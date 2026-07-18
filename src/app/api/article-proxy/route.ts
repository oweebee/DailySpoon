import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { prisma } from "@/lib/prisma";
import { getSettings } from "@/lib/settings";
import { REDLIB_INSTANCES, isRedditHostname, isRedditImageHostname, isRedditVideoHostname } from "@/lib/reddit";
import { isAlreadyMorssUrl } from "@/lib/text";
import { isForbiddenProxyTarget } from "@/lib/urlGuard";

// jsdom a besoin du runtime Node complet (pas edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Principe "Morss" : au lieu de charger le site source directement dans
// l'iframe (bloqué par beaucoup de sites via X-Frame-Options/CSP), on
// récupère la page côté serveur, on en extrait l'article propre (via
// Readability, la même techno que Firefox Reader View / Pocket), et on sert
// une version simplifiée depuis notre propre domaine — jamais bloquée
// puisqu'elle ne vient plus du site source du point de vue du navigateur.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function proxyImageUrl(absoluteUrl: string): string {
  return `/api/image-proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function proxyVideoUrl(absoluteUrl: string): string {
  return `/api/video-proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

/** "src" vide, data-URI minuscule (souvent un pixel transparent en base64)
 *  ou nom de fichier explicitement "placeholder"/"blank"/"spacer" — signe
 *  quasi certain d'une image en lazy-load dont le VRAI chemin est ailleurs
 *  (data-src...), pas encore chargé puisqu'on ne fait QUE parser le HTML
 *  brut ici (aucun JS n'a jamais tourné pour remplir "src"). */
function looksLikeLazyPlaceholder(src: string): boolean {
  if (!src.trim()) return true;
  if (src.startsWith("data:image") && src.length < 200) return true;
  return /placeholder|blank\.gif|spacer\.gif|1x1\.(?:gif|png)/i.test(src);
}

/** Beaucoup de sites (Gamekult confirmé en usage réel) chargent leurs
 *  images en lazy-load : le vrai chemin n'est présent que dans un attribut
 *  data-* (data-src, data-lazy-src, data-original, ou le premier candidat
 *  d'un data-srcset), tant que "src" ne contient qu'un pixel/placeholder —
 *  sans ce repli, l'image proxifiée pointe vers ce placeholder et reste
 *  invisible. Retourne l'URL à utiliser, ou null si vraiment aucune trouvée. */
function resolveImgSrc(el: Element): string | null {
  const src = el.getAttribute("src");
  if (src && !looksLikeLazyPlaceholder(src)) return src;
  const lazyCandidate =
    el.getAttribute("data-src") ||
    el.getAttribute("data-lazy-src") ||
    el.getAttribute("data-original") ||
    el.getAttribute("data-srcset")?.split(",")[0]?.trim().split(/\s+/)[0] ||
    null;
  return lazyCandidate || src || null;
}

/** Réécrit tous les src d'images/sources d'un fragment de contenu déjà
 *  extrait (Readability...) pour passer par notre proxy d'images (contourne
 *  le hotlinking), avec repli lazy-load (voir resolveImgSrc) — factorisé ici
 *  car appliqué de façon identique aux trois chemins d'extraction (générique,
 *  Redlib, self-post Reddit).
 */
function rewriteContentImages(contentDom: JSDOM, baseUrl: string): void {
  contentDom.window.document.querySelectorAll("img, source").forEach((el) => {
    const resolved = resolveImgSrc(el);
    if (resolved) {
      try {
        el.setAttribute("src", proxyImageUrl(new URL(resolved, baseUrl).toString()));
      } catch {
        // URL déjà relative/invalide, on laisse tel quel plutôt que de planter.
      }
    }
    el.removeAttribute("srcset");
    el.removeAttribute("data-src");
    el.removeAttribute("data-lazy-src");
    el.removeAttribute("data-original");
    el.removeAttribute("data-srcset");
  });
}

// Les apostrophes ' et ’ (courbe) sont interchangeables selon le site source
// (voire selon l'encodeur HTML utilisé), mais toutes les listes de phrases
// ci-dessous n'écrivent qu'UNE seule forme — sans normalisation, une phrase
// comme "écran d'accueil" (apostrophe droite dans la liste) ne matchait pas
// "écran d’accueil" (apostrophe courbe sur le site réel), et la détection de
// contenu/chrome échouait silencieusement. Appliqué à CHAQUE comparaison de
// texte de cette page (isSubstantiveParagraph, isLeadingJunkElement,
// isRelatedPostsHeading) via normalizeApostrophes().
function normalizeApostrophes(text: string): string {
  return text.replace(/[’‘]/g, "'");
}

// Beaucoup de sites glissent, après le vrai texte de l'article mais toujours
// à l'intérieur du bloc que Readability extrait, un rebus de fin d'article :
// pub pour l'appli mobile, bandeau newsletter, liste "à lire aussi" — pas du
// contenu de l'article. On repère le dernier paragraphe qui ressemble à du
// vrai texte, et on supprime tout ce qui vient après (photo publicitaire,
// listes de liens, etc.), plutôt que d'essayer de reconnaître chaque site.
const TRAILING_JUNK_PHRASES = [
  "inscrivez-vous",
  "abonnez-vous",
  "newsletter",
  "téléchargez notre application",
  "téléchargez l'application",
  "app store",
  "google play",
  "écran d'accueil",
  "toute l'actu",
  "en un clin d'œil",
  "restez connecté",
  "restez informé",
  "dans l'internet d'",
  "sur le même sujet",
  "à lire aussi",
  "cet article vous a plu",
  "partager cet article",
  // Bandeaux "suivez-nous" (réseaux sociaux, Google Actualités, WhatsApp...)
  // — très fréquents en fin d'article sur les sites français, jamais du
  // contenu de l'article lui-même.
  "suivez-nous",
  "pour ne manquer aucune actualité",
  "rejoignez-nous sur",
  "retrouvez-nous sur",
  "google actualités",
  "google news",
  "notre chaîne whatsapp",
  "sur whatsapp",
  // Bandeau "soutenez-nous / sans publicité" en tête de page (ex. Gamekult)
  // — sinon assez long pour passer isSubstantiveParagraph comme "vrai"
  // premier paragraphe et empêcher trimLeadingJunk de couper le menu qui
  // suit (voir plus bas).
  "soutenez",
  "sans publicité",
  "découvrez tous nos contenus",
  // Bandeau promo appli/newsletter (ex. Numerama, "ToujoursPlus") — le
  // paragraphe entier passait isSubstantiveParagraph (assez long, lien minoritaire
  // dans le texte) faute d'y reconnaître une phrase connue.
  "un édito exclusif",
  "l'agenda de la rédaction",
  "toujoursplus"
];

// Un "vrai" paragraphe peut être un <p> classique ou un <blockquote> (souvent
// utilisé par les CMS pour encadrer un bandeau "suivez-nous" plutôt qu'une
// vraie citation) — les deux sont évalués pareil ; tout autre type d'élément
// (image, figure, liste de liens...) n'est de toute façon jamais considéré
// comme du texte d'article.
function isSubstantiveParagraph(el: Element): boolean {
  if (el.tagName !== "P" && el.tagName !== "BLOCKQUOTE") return false;
  const text = (el.textContent || "").trim();
  if (text.length < 40) return false;

  const lower = normalizeApostrophes(text.toLowerCase());
  if (TRAILING_JUNK_PHRASES.some((p) => lower.includes(p))) return false;

  // Un paragraphe qui n'est en fait qu'un lien/bouton habillé (CTA) plutôt
  // que de la prose — on l'ignore même s'il est assez long.
  const links = el.querySelectorAll("a");
  if (links.length > 0) {
    const linkText = Array.from(links)
      .map((a) => (a.textContent || "").trim())
      .join(" ");
    if (linkText.length >= text.length - 5) return false;
  }

  return true;
}

// Titres qui annoncent quasi-systématiquement une section "articles
// similaires/récents" en toute fin de page (widget Jetpack Related Posts et
// équivalents WordPress) — un signal beaucoup plus fiable que "dernier
// paragraphe substantiel", car ce bloc suit souvent un vrai paragraphe (ex.
// un disclaimer d'auteur) qui, lui, passe la détection de contenu réel et
// empêchait jusqu'ici de couper ce qui vient après.
const RELATED_POSTS_HEADING_PHRASES = [
  "articles récents",
  "articles similaires",
  "à lire aussi",
  "lire aussi",
  "sur le même sujet",
  "vous devriez également aimer",
  "pourrait aussi vous intéresser",
  "posts similaires",
  "related posts",
  "you might also like",
  "on vous recommande",
  // Gamekult (et sans doute d'autres sites au même gabarit) : cette phrase de
  // transition n'est PAS un titre (H1-4) mais un simple <p>, juste avant une
  // liste de teasers d'articles suggérés (image + titre-lien + tag "news"
  // répétés) — vu en usage réel, tout ce bloc restait affiché après le
  // "vrai" texte de l'article, sans qu'aucun signal de titre classique ne
  // permette de le détecter.
  "ça vous a intéressé"
];

function isRelatedPostsHeading(el: Element): boolean {
  const text = normalizeApostrophes((el.textContent || "").trim().toLowerCase());
  const isHeadingTag = /^H[1-4]$/.test(el.tagName);
  // Un <p> très court (pas un vrai paragraphe de contenu) peut aussi porter
  // ce signal — voir "ça vous a intéressé" ci-dessus, jamais dans un H1-4
  // sur Gamekult.
  const isShortParagraph = el.tagName === "P" && text.length < 80;
  if (!isHeadingTag && !isShortParagraph) return false;
  return RELATED_POSTS_HEADING_PHRASES.some((p) => text.includes(p));
}

/** Coupe le contenu juste après le dernier paragraphe "réel" — ou dès un
 *  titre de type "Articles récents"/"À lire aussi" si celui-ci apparaît
 *  plus tôt, quel que soit le paragraphe qui le précède. Tout ce qui suit
 *  le point de coupe retenu (photo, liste de liens, bandeau newsletter,
 *  articles suggérés...) est retiré. */
function trimTrailingJunk(root: Element): void {
  const children = Array.from(root.children);
  let lastRealIdx = -1;
  let firstRelatedHeadingIdx = -1;
  children.forEach((el, i) => {
    if (isSubstantiveParagraph(el)) lastRealIdx = i;
    if (firstRelatedHeadingIdx === -1 && isRelatedPostsHeading(el)) firstRelatedHeadingIdx = i;
  });

  if (lastRealIdx === -1 && firstRelatedHeadingIdx === -1) return; // rien d'identifiable, on ne touche à rien par sécurité

  let cutFrom = lastRealIdx + 1;
  if (firstRelatedHeadingIdx !== -1) {
    cutFrom = lastRealIdx === -1 ? firstRelatedHeadingIdx : Math.min(cutFrom, firstRelatedHeadingIdx);
  }
  if (cutFrom >= children.length) return; // rien à couper

  for (let i = children.length - 1; i >= cutFrom; i--) {
    children[i].remove();
  }
}

// Symétrique de trimTrailingJunk, mais en tête d'article : certains sites
// (ex. Gamekult) glissent tout le chrome de la page — bandeau
// "soutenez-nous", menu (liste de rubriques), "Menu"/"Recherche"/"Abonnés",
// fil "Accueil > News > <titre répété>" — À L'INTÉRIEUR du bloc que
// Readability extrait comme contenu d'article, avant le vrai texte. On
// repère le premier paragraphe "réel" (même détection que trimTrailingJunk)
// et on supprime tout ce qui le précède, à condition d'y reconnaître un
// signal de chrome connu (sinon on ne touche à rien, par sécurité — un
// article dont le premier paragraphe est simplement court n'est pas
// forcément pollué).
const LEADING_JUNK_EXACT_PHRASES = [
  "menu",
  "recherche",
  "rechercher",
  "abonnés",
  "abonnements",
  "l'actualité",
  "accueil",
  "news",
  "se connecter",
  "s'inscrire",
  "sommaire"
];

function isLeadingJunkElement(el: Element): boolean {
  if (el.tagName === "UL" || el.tagName === "OL" || el.tagName === "NAV") return true;
  const text = normalizeApostrophes((el.textContent || "").trim().toLowerCase());
  return LEADING_JUNK_EXACT_PHRASES.includes(text);
}

function trimLeadingJunk(root: Element): void {
  const children = Array.from(root.children);
  let firstRealIdx = -1;
  for (let i = 0; i < children.length; i++) {
    if (isSubstantiveParagraph(children[i])) {
      firstRealIdx = i;
      break;
    }
  }
  if (firstRealIdx <= 0) return; // rien avant le premier paragraphe réel, ou aucun trouvé

  const before = children.slice(0, firstRealIdx);
  if (!before.some((el) => isLeadingJunkElement(el))) return; // pas de signal de chrome reconnu : on ne touche à rien

  // Garde la dernière image/figure juste avant le texte réel : presque
  // toujours la photo d'illustration de l'article, pas du chrome.
  let cutTo = firstRealIdx;
  const prev = children[cutTo - 1];
  if (prev && /^(IMG|FIGURE|PICTURE)$/.test(prev.tagName)) cutTo -= 1;

  for (let i = cutTo - 1; i >= 0; i--) {
    children[i].remove();
  }
}

// `Response.text()` du fetch natif décode toujours en UTF-8, quel que soit
// l'encodage réel de la page — ce qui bousille les accents (é -> �) sur tout
// site qui sert du HTML en ISO-8859-1/Windows-1252 (encore fréquent). On lit
// donc les octets bruts et on détecte nous-mêmes le bon charset : d'abord
// via l'en-tête HTTP Content-Type, sinon via la balise <meta charset> de la
// page (repérable en la lisant provisoirement en latin1, qui est sans perte
// pour les octets ASCII où vit cette balise).
function detectCharset(buffer: ArrayBuffer, contentTypeHeader: string | null): string {
  if (contentTypeHeader) {
    const m = /charset=([^;]+)/i.exec(contentTypeHeader);
    if (m) return m[1].trim().toLowerCase().replace(/["']/g, "");
  }
  const head = Buffer.from(buffer.slice(0, 2048)).toString("latin1");
  const metaCharset = /<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i.exec(head);
  if (metaCharset) return metaCharset[1].toLowerCase();
  return "utf-8";
}

function decodeHtml(buffer: ArrayBuffer, contentTypeHeader: string | null): string {
  const charset = detectCharset(buffer, contentTypeHeader);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

// Étoile "shérif" (même silhouette que FavoriteStar.tsx côté app React) pour
// marquer/démarquer un article en favori depuis la page proxifiée — servie
// en HTML statique dans une iframe, donc pas de composant React ici : un
// bouton + un petit script inline qui appelle /api/articles/favorite (même
// origine que l'iframe, donc le cookie de session suit automatiquement).
const STAR_PATH_D =
  "M12,2 L14.35,8.76 L21.51,8.91 L15.80,13.24 L17.88,20.09 L12,16 L6.12,20.09 L8.20,13.24 L2.49,8.91 L9.65,8.76 Z";

function favoriteStarHtml(): string {
  return `<button type="button" class="js-fav-star fav-star" onclick="toggleFavorite()" aria-label="Favori">
    <svg viewBox="0 0 24 24" width="15" height="15"><path d="${STAR_PATH_D}" /></svg>
  </button>`;
}

// Trois cuillères (clin d'œil au nom "DailySpoon") en guise de fleuron de fin
// d'article, à la place du symbole "❦ ❦ ❦" d'origine — en SVG plutôt qu'un
// emoji pour rester en niveaux de gris (un emoji cuillère s'afficherait en
// couleur, hors thème). Inclinées façon couverts posés en éventail (pas
// debout au garde-à-vous) — mêmes angles et même silhouette que
// SpoonDivider.tsx côté app React, pour une cohérence visuelle totale.
function spoonSvg(rotateDeg: number): string {
  // Boîte plus étroite que haute + preserveAspectRatio="none" : étire le bol
  // verticalement (moins rond, effet "maracas" évité) — même technique que
  // les "o" du masthead et SpoonDivider.tsx côté app React.
  return `<svg viewBox="0 0 24 24" preserveAspectRatio="none" width="12" height="17" style="transform: rotate(${rotateDeg}deg)"><ellipse cx="12" cy="6.2" rx="5.1" ry="6.2"/><rect x="10.6" y="11.4" width="2.8" height="11.2" rx="1.4"/></svg>`;
}

function renderPage(opts: {
  title: string;
  byline?: string | null;
  siteName?: string | null;
  bodyHtml: string;
  originalUrl: string;
  /** Affiche le lien de bascule traduction — seulement sur les pages qui
   *  ont un vrai contenu d'article (pas les pages de repli/erreur). */
  showTranslateLink?: boolean;
  /** Page actuellement affichée en français traduit (vs langue d'origine). */
  translated?: boolean;
  /** Id de l'Article en base correspondant à cette URL, s'il existe — permet
   *  d'afficher l'étoile favori (absent si l'article n'est pas encore/plus
   *  en base, ex. lien externe non aspiré). */
  articleId?: string | null;
  favorite?: boolean;
  /** Le fetch serveur a échoué (403, anti-bot...) même via le repli morss :
   *  au lieu du texte d'erreur habituel, affiche directement la page source
   *  dans une iframe — la requête part alors du navigateur du visiteur, pas
   *  de ce serveur, ce qui contourne un blocage ciblant spécifiquement les
   *  requêtes serveur-à-serveur. Pas de garantie : certains sites refusent
   *  aussi l'affichage en iframe (X-Frame-Options/CSP frame-ancestors), la
   *  zone reste alors vide — "Voir l'original"/"Ouvrir dans un nouvel
   *  onglet" restent le recours dans ce cas. */
  embedFallback?: boolean;
}): string {
  const { title, byline, siteName, bodyHtml, originalUrl, showTranslateLink, translated, articleId, favorite, embedFallback } =
    opts;
  const kickerRaw = siteName || new URL(originalUrl).hostname.replace(/^www\./, "");
  const kicker = escapeHtml(kickerRaw);
  // La ligne "source" sous le titre reste toujours affichée (repli sur le
  // seul nom du site si aucun byline), pour que l'étoile favori ait toujours
  // un ancrage juste en dessous du titre.
  const bylineRaw = [siteName, byline].filter((v): v is string => Boolean(v)).join(" · ") || kickerRaw;
  const metaBits = escapeHtml(bylineRaw);
  const showStar = Boolean(articleId);
  const starHtml = showStar ? favoriteStarHtml() : "";
  // Traduction à la demande seulement (pas par défaut) : un lien dans le
  // bandeau du haut bascule vers /api/article-proxy?...&translate=1 (ou
  // l'enlève pour revenir à la langue d'origine), qui refait un rendu
  // serveur complet avec le contenu traduit via l'endpoint public Google
  // Translate (best-effort, non officiel — cf. translateViaGoogle plus bas).
  const translateHref = `/api/article-proxy?url=${encodeURIComponent(originalUrl)}${translated ? "" : "&translate=1"}`;
  const translateLabel = translated ? "Texte original ↺" : "Traduire en français ⇄";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html { background: #dcdcdc; }
  body {
    margin: 0;
    padding: 40px 28px 70px;
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.7;
    font-size: 15px;
    /* Papier gris : même grain de bruit + vignette que le reste du site,
       pour que la page proxifiée fasse illusion de vieux papier journal. */
    background-color: #f0f0f0;
    background-image:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.5' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E"),
      radial-gradient(ellipse at center, #f5f5f5 0%, #ececec 70%, #dcdcdc 100%);
    /* Pas de "background-attachment: fixed" ici : dans un iframe, ça fait
       défiler le texte tout seul au-dessus d'un fond qui semble figé/vide.
       Le fond doit défiler avec le contenu, comme une vraie page de papier. */
  }
  .page {
    max-width: 660px;
    margin: 0 auto;
  }
  .meta-top {
    /* Grille à 3 colonnes (pas flex + space-between) : le lien du milieu
       reste réellement centré sur la ligne, quelles que soient les
       longueurs du lien de gauche et du nom de site à droite — sinon son
       centre "flottant" ne s'aligne pas avec le kicker centré juste
       en dessous. */
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 12px;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: #5c5c5c;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(26, 26, 26, 0.6);
    margin-bottom: 4px;
  }
  .meta-top a { color: #8b1a1a; text-decoration: none; }
  .meta-top a:hover { text-decoration: underline; }
  .meta-left { text-align: left; }
  .meta-center { text-align: center; }
  .meta-right { text-align: right; }
  .double-rule { border-top: 3px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; height: 6px; margin: 2px 0 22px; }
  .kicker {
    text-align: center;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.3em;
    color: #8b1a1a;
    margin: 22px 0 6px;
  }
  h1 {
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 900;
    font-size: 2.15rem;
    line-height: 1.15;
    text-align: center;
    margin: 0 0 8px;
  }
  .byline {
    text-align: center;
    font-size: 0.78rem;
    font-style: italic;
    color: #5c5c5c;
    margin-bottom: 28px;
  }
  .fav-star {
    display: inline-flex;
    vertical-align: middle;
    margin-left: 7px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    color: #5c5c5c;
  }
  .fav-star svg path { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linejoin: round; }
  .fav-star.is-fav { color: #8a0303; }
  .fav-star.is-fav svg path { fill: currentColor; }
  .source-bottom {
    text-align: center;
    font-size: 0.8rem;
    font-style: italic;
    color: #5c5c5c;
    margin-top: 2.6em;
  }
  .article-body { text-align: justify; hyphens: auto; }
  .article-body > p:first-of-type::first-letter {
    float: left;
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 900;
    font-size: 3.6em;
    line-height: 0.82;
    padding-right: 0.09em;
    padding-top: 0.04em;
    color: #1a1a1a;
  }
  .article-body p { margin: 1.05em 0; }
  .article-body img, .article-body picture {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.4em auto;
    /* Contrairement aux vignettes de la liste (volontairement en noir et
       blanc), la photo dans l'article ouvert reste en couleur. */
    border: 1px solid #1a1a1a;
    box-shadow: 3px 3px 0 rgba(26, 26, 26, 0.15);
    cursor: zoom-in;
  }
  /* Popup zoom plein écran au clic sur une image de l'article — overlay
     sombre + image centrée, fermeture au clic n'importe où ou touche Échap. */
  .lightbox-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 999;
    background: rgba(26, 26, 26, 0.92);
    cursor: zoom-out;
    align-items: center;
    justify-content: center;
    padding: 24px;
  }
  .lightbox-overlay.is-open { display: flex; }
  .lightbox-overlay img {
    max-width: 100%;
    max-height: 100%;
    box-shadow: 0 10px 60px rgba(0, 0, 0, 0.6);
    border: none;
    margin: 0;
  }
  .article-body figure { margin: 1.4em 0; }
  .article-body figcaption { font-size: 0.75rem; color: #5c5c5c; font-style: italic; text-align: center; margin-top: 0.4em; }
  .article-body a { color: #8b1a1a; }
  .article-body blockquote {
    border-left: 3px solid #1a1a1a;
    margin: 1.2em 0;
    padding: 0.2em 0 0.2em 1.1em;
    color: #3a3a3a;
    font-style: italic;
  }
  .article-body h2, .article-body h3 {
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 800;
    margin: 1.4em 0 0.5em;
  }
  /* Encadré d'avertissement (repli texte Reddit/extraction échouée) — même
     esprit que les cases d'article de l'appli React (bordure pleine + fond
     gris clair), placé APRÈS le texte récupéré plutôt qu'avant, sur toute
     la largeur de la zone de texte. */
  .notice-box {
    margin-top: 2.4em;
    border: 2px solid #1a1a1a;
    background: rgba(26, 26, 26, 0.07);
    padding: 1em 1.2em;
    font-size: 0.85rem;
    line-height: 1.6;
    color: #3a3a3a;
  }
  /* Bouton "timbre" — même fond de timbre-poste que côté app React (voir
     public/stamps/stamp-md.png, globals.css .stamp-bg-md). Ratio RÉEL de
     l'image imposé via "aspect-ratio" (700/270, dimensions exactes du
     fichier) plutôt qu'étiré aux dimensions du bouton — sinon les
     perforations rondes de l'image se déforment en ovales. La largeur
     (texte + padding horizontal) pilote donc la hauteur, jamais l'inverse.
     Répliqué en CSS pur ici puisque cette page est servie hors du bundle
     Tailwind (rendu HTML brut pour l'iframe de lecture) — même chemin
     /stamps/ (dossier public, servi tel quel). */
  .stamp-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    background-image: url("/stamps/stamp-md.png");
    background-repeat: no-repeat;
    background-position: center;
    background-size: contain;
    aspect-ratio: 700 / 270;
    color: #f0f0f0;
    padding: 0 1.6em;
    font-family: Georgia, serif;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    text-decoration: none;
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6);
    transform: rotate(-1.5deg);
    filter: drop-shadow(2px 4px 8px rgba(26, 26, 26, 0.28));
    transition: transform 0.15s ease, filter 0.15s ease;
  }
  .stamp-link:hover {
    transform: rotate(0deg) scale(1.03);
    filter: drop-shadow(3px 5px 10px rgba(26, 26, 26, 0.32));
  }
  .stamp-wrap { text-align: center; margin-top: 2.6em; }
  .colophon { text-align: center; margin-top: 3.2em; color: #5c5c5c; }
  .colophon svg { display: inline-block; vertical-align: middle; margin: 0 9px; fill: currentColor; }
  /* Repli iframe (fetch serveur bloqué) : occupe la hauteur visible de la
     fenêtre plutôt qu'une hauteur fixe arbitraire, pour rester utilisable
     sur mobile comme desktop. */
  .embed-frame {
    display: block;
    width: 100%;
    height: 78vh;
    min-height: 420px;
    border: 1px solid #1a1a1a;
    box-shadow: 3px 3px 0 rgba(26, 26, 26, 0.15);
    background: #fff;
  }
  .embed-note { text-align: center; font-size: 0.75rem; font-style: italic; color: #5c5c5c; margin: 0.8em 0 1.6em; }
</style>
</head>
<body>
  <div class="page">
    <p class="meta-top">
      <span class="meta-left"></span>
      <span class="meta-center">
        ${showTranslateLink ? `<a href="${escapeHtml(translateHref)}">${translateLabel}</a>` : ""}
      </span>
      <span class="meta-right">${kicker}</span>
    </p>
    <div class="double-rule"></div>
    <p class="kicker">✦ ${kicker} ✦</p>
    ${
      embedFallback
        ? `<p class="embed-note">Lecture directe indisponible sur ce serveur — affichage de la page source ci-dessous.</p>
    <iframe class="embed-frame" src="${escapeHtml(originalUrl)}" title="${escapeHtml(title)}" referrerpolicy="no-referrer" loading="lazy"></iframe>`
        : `<h1>${escapeHtml(title)}</h1>
    <p class="byline">${metaBits}${starHtml}</p>
    <div class="article-body">${bodyHtml}</div>
    <p class="source-bottom">Source : ${kicker}${starHtml}</p>`
    }
    <p class="stamp-wrap">
      <a class="stamp-link" href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer">Ouvrir dans un nouvel onglet ↗</a>
    </p>
    <p class="colophon">${spoonSvg(-18)}${spoonSvg(14)}${spoonSvg(-18)}</p>
  </div>
  <div class="lightbox-overlay" id="lightbox"><img id="lightbox-img" src="" alt="" /></div>
  <script>
(function () {
  var overlay = document.getElementById("lightbox");
  var overlayImg = document.getElementById("lightbox-img");
  function open(src, alt) {
    overlayImg.src = src;
    overlayImg.alt = alt || "";
    overlay.classList.add("is-open");
  }
  function close() {
    overlay.classList.remove("is-open");
    overlayImg.src = "";
  }
  document.querySelectorAll(".article-body img").forEach(function (img) {
    img.addEventListener("click", function () {
      open(img.currentSrc || img.src, img.alt);
    });
  });
  overlay.addEventListener("click", close);
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape") close();
  });
})();
</script>
  ${
    showStar
      ? `<script>
(function () {
  var articleId = ${JSON.stringify(articleId)};
  var fav = ${favorite ? "true" : "false"};
  function paint() {
    document.querySelectorAll(".js-fav-star").forEach(function (el) {
      el.classList.toggle("is-fav", fav);
      el.setAttribute("aria-pressed", fav ? "true" : "false");
      el.title = fav ? "Retirer des favoris" : "Ajouter aux favoris";
    });
  }
  window.toggleFavorite = function () {
    fav = !fav;
    paint();
    fetch("/api/articles/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId: articleId, favorite: fav })
    }).catch(function () {});
  };
  paint();
})();
</script>`
      : ""
  }
</body>
</html>`;
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Traduction à la demande uniquement (lien "Traduire en français" dans la
// page, jamais automatique) via le point d'accès public non officiel que
// translate.google.com utilise lui-même en coulisses — gratuit, sans clé
// API, mais non documenté/non garanti par Google (peut cesser de
// fonctionner sans préavis). Best-effort : en cas d'échec, on garde le
// texte d'origine plutôt que de casser la page.
async function translateViaGoogle(text: string, targetLang = "fr"): Promise<string> {
  if (!text || !text.trim()) return text;
  const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLang, dt: "t", q: text });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
      }
    });
    if (!res.ok) return text;
    const data: any = await res.json();
    const segments = data?.[0];
    if (!Array.isArray(segments)) return text;
    const translated = segments.map((seg: any) => seg?.[0] ?? "").join("");
    return translated || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

// Limite le nombre de blocs traduits par article : l'endpoint est gratuit
// mais non officiel, et chaque bloc = une requête réseau séquentielle — on
// évite qu'un article démesurément long ne prenne des dizaines de secondes
// à s'ouvrir ou ne se fasse limiter par Google.
const MAX_BLOCKS_TO_TRANSLATE = 60;

async function translateContentHtml(html: string): Promise<string> {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return html;
  const blocks = Array.from(root.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, figcaption")).slice(
    0,
    MAX_BLOCKS_TO_TRANSLATE
  );
  for (const el of blocks) {
    const original = el.innerHTML.trim();
    if (!original) continue;
    el.innerHTML = await translateViaGoogle(original);
  }
  return root.innerHTML;
}

async function translateArticle(title: string, bodyHtml: string): Promise<{ title: string; bodyHtml: string }> {
  const [translatedTitle, translatedBody] = await Promise.all([
    translateViaGoogle(title),
    translateContentHtml(bodyHtml)
  ]);
  return { title: translatedTitle, bodyHtml: translatedBody };
}

// Reddit (y compris old.reddit.com) bloque désormais la plupart des
// requêtes serveur-à-serveur avec un 403, quel que soit le User-Agent —
// blocage réseau/IP, pas seulement JS. La seule voie qui reste fiable est
// l'API JSON publique (pas d'auth requise pour un post public) : on la
// préfère pour les URLs de post ("/comments/...").
function isRedditPostUrl(u: URL): boolean {
  return isRedditHostname(u.hostname) && /\/comments\//.test(u.pathname);
}

// Reddit renvoie le corps d'un self-post déjà en HTML (sain, rendu depuis
// le markdown) mais échappé une fois de trop dans le JSON (ex. "&lt;p&gt;").
// On le fait décoder par un parseur HTML : en assignant la chaîne comme
// innerHTML d'un nœud temporaire, les entités sont décodées en vrais
// caractères "<"/">" dans le texte — qu'on relit via textContent pour
// récupérer du HTML valide, réutilisable comme markup.
function decodeRedditHtml(encoded: string): string {
  const dom = new JSDOM(`<!doctype html><body><div id="tmp">${encoded}</div></body>`);
  return dom.window.document.getElementById("tmp")?.textContent || "";
}

// REDLIB_INSTANCES (essai best-effort avant l'API JSON officielle) vit
// désormais dans src/lib/reddit.ts, partagé avec redditFeedHealth.ts.
async function fetchViaRedlib(parsed: URL): Promise<{ html: string; baseUrl: string } | null> {
  const path = parsed.pathname + parsed.search;
  for (const instance of REDLIB_INSTANCES) {
    const target = `${instance}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(target, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      // Écarte les pages de challenge anti-bot (Anubis, Cloudflare...) ou
      // les réponses trop courtes pour être une vraie page de post.
      if (html.length < 500 || /anubis|checking your browser|cf-browser-verification/i.test(html)) continue;
      return { html, baseUrl: target };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

type RedditPost = { title: string; author: string; subreddit: string; bodyHtml: string };

async function fetchRedditPost(parsed: URL): Promise<RedditPost | null> {
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const jsonUrl = `https://www.reddit.com${cleanPath}.json?raw_json=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json"
      }
    });
    if (!res.ok) return null;

    const json: any = await res.json();
    const post = json?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    let bodyHtml: string;
    if (post.is_self && post.selftext_html) {
      bodyHtml = decodeRedditHtml(post.selftext_html);
    } else if (post.url) {
      bodyHtml = `<p><em>Ce post pointe vers un lien externe :</em></p><p><a href="${escapeHtml(
        post.url
      )}">${escapeHtml(post.url)}</a></p>`;
    } else {
      bodyHtml = "<p><em>Post sans contenu textuel.</em></p>";
    }

    return {
      title: post.title || "Post Reddit",
      author: post.author || "inconnu",
      subreddit: post.subreddit_name_prefixed || "reddit.com",
      bodyHtml
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Va chercher le HTML d'une page, en tentant d'abord une requête directe
 * depuis ce serveur puis, si elle échoue (403, timeout...) et qu'une
 * instance morss est configurée (/admin/settings), une seconde tentative en
 * relayant via morss — dont l'IP n'est pas forcément bloquée là où celle de
 * ce serveur l'est (cas fréquent : NYTimes, Cloudflare...). "morss.it/:html/
 * <url sans schéma>" est l'option officielle de morss pour obtenir une page
 * HTML unique déjà nettoyée plutôt qu'un flux RSS — best-effort : si morss
 * répond autre chose qu'un vrai article (échec, page de blocage...),
 * Readability ne trouvera simplement rien d'exploitable et on retombe sur
 * le message d'erreur habituel.
 */
async function fetchArticleHtml(
  targetUrl: string,
  morssBaseUrl: string
): Promise<{ html: string; baseUrl: string } | { error: string } | null> {
  async function attempt(url: string, timeoutMs: number): Promise<{ html: string; baseUrl: string } | { error: string } | null> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) return { error: `${res.status}` };
      const rawBuffer = await res.arrayBuffer();
      const html = decodeHtml(rawBuffer, res.headers.get("content-type"));
      return { html, baseUrl: url };
    } catch (err: any) {
      return { error: err?.message || "échec réseau" };
    } finally {
      clearTimeout(timeout);
    }
  }

  const direct = await attempt(targetUrl, 10000);
  if (direct && "html" in direct) return direct;

  if (!morssBaseUrl) return direct; // pas de repli configuré : renvoie l'erreur directe telle quelle
  // Si targetUrl est déjà une URL morss, l'échec vient de morss lui-même —
  // relayer une seconde fois via morss referait exactement la même requête
  // qui vient d'échouer, pour rien (juste un second timeout à attendre).
  if (isAlreadyMorssUrl(targetUrl, morssBaseUrl)) return direct;

  const strippedUrl = targetUrl.replace(/^https?:\/\//, "");
  const morssUrl = `${morssBaseUrl}/:html/${strippedUrl}`;
  const viaMorss = await attempt(morssUrl, 12000);
  if (viaMorss && "html" in viaMorss) return viaMorss;

  return direct; // les deux ont échoué : on renvoie l'erreur de la tentative directe (plus parlante)
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("URL manquante", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocole invalide");
  } catch {
    return new NextResponse("URL invalide", { status: 400 });
  }
  // Anti-SSRF : jamais de fetch serveur vers une cible interne (voir urlGuard).
  if (isForbiddenProxyTarget(parsed)) {
    return new NextResponse("Cible non autorisée", { status: 403 });
  }
  const originalUrl = parsed.toString();
  const fetchUrl = originalUrl;
  const wantsTranslation = req.nextUrl.searchParams.get("translate") === "1";

  // Retrouve l'Article correspondant (même sourceUrl) pour savoir s'il faut
  // afficher l'étoile favori et dans quel état — absent si l'article n'est
  // pas (ou plus) en base. sourceExcerpt/summary servent de repli texte
  // (voir excerptFallbackBodyHtml) quand l'extraction live échoue
  // complètement (Reddit bloqué, Readability qui ne trouve rien...) : on a
  // déjà ce texte en base (récupéré depuis le flux RSS), pas de raison de
  // se contenter d'un simple message d'erreur si on peut l'afficher à la
  // place, non tronqué (contrairement à la vignette, limitée à 10 lignes).
  const articleRecord = await prisma.article
    .findFirst({
      where: { sourceUrl: originalUrl },
      select: { id: true, favorite: true, sourceExcerpt: true, summary: true, sourceTitle: true, headline: true }
    })
    .catch(() => null);
  const articleId = articleRecord?.id ?? null;
  const favorite = articleRecord?.favorite ?? false;
  const fallbackExcerpt = articleRecord?.summary?.trim() || articleRecord?.sourceExcerpt?.trim() || null;
  // Même titre que celui déjà affiché en vignette (accueil, En direct) —
  // headline (réécrit par l'IA, ex. en français) prioritaire sur sourceTitle
  // (brut, langue d'origine) : même ordre de priorité que partout ailleurs
  // dans l'appli (EditionView/CategoryColumn affichent headline||sourceTitle)
  // — sinon on se retrouvait avec un titre anglais au-dessus d'un texte
  // français, incohérent avec la vignette.
  const fallbackTitle = articleRecord?.headline?.trim() || articleRecord?.sourceTitle?.trim() || null;

  // Le message d'avertissement passe APRÈS le texte récupéré (pas avant) et
  // dans un encadré grisé sur toute la largeur de la zone de texte — même
  // esprit que les cases d'article de l'appli (bordure + fond gris clair),
  // pour bien le distinguer visuellement du texte de l'article lui-même.
  function excerptFallbackBodyHtml(notice: string): string {
    const noticeBox = `<div class="notice-box">${escapeHtml(notice)}</div>`;
    if (!fallbackExcerpt) return noticeBox;
    return `<p>${escapeHtml(fallbackExcerpt)}</p>${noticeBox}`;
  }

  // Certains posts Reddit à média donnent, dans le flux RSS (surtout via un
  // miroir Redlib), un lien DIRECT vers le CDN média (i.redd.it/v.redd.it)
  // comme URL de l'article plutôt que le lien de la discussion — ni une
  // page HTML (Readability n'y trouve rien), ni embarquable en iframe
  // (Reddit bloque X-Frame-Options dessus aussi) : sans ce cas à part, ça
  // tombait sur la page de repli iframe, cassée. On les affiche donc
  // directement.
  if (isRedditImageHostname(parsed.hostname)) {
    return htmlResponse(
      renderPage({
        title: "Image Reddit",
        siteName: "reddit.com",
        bodyHtml: `<p style="text-align:center;"><img src="${proxyImageUrl(originalUrl)}" alt="" /></p>`,
        originalUrl,
        articleId,
        favorite
      })
    );
  }

  if (isRedditVideoHostname(parsed.hostname)) {
    // v.redd.it ne sert jamais de fichier vidéo à sa racine — il faut
    // deviner un des chemins DASH_<résolution>.mp4 habituels. Limite
    // connue et non contournable simplement : cette piste vidéo est SANS
    // LE SON (Reddit sert l'audio à part, la remuxer demanderait du
    // traitement serveur type ffmpeg, hors de portée ici) — best-effort,
    // testé en cascade côté client jusqu'à trouver une résolution
    // disponible, avec un mot vers "Voir l'original" pour le son.
    const base = `${parsed.protocol}//${parsed.hostname}${parsed.pathname}`.replace(/\/+$/, "");
    const candidates = ["1080", "720", "480", "360", "240"].map((res) => proxyVideoUrl(`${base}/DASH_${res}.mp4`));
    const bodyHtml = `
      <p style="text-align:center;">
        <video id="reddit-video" controls preload="metadata" style="max-width:100%;border:1px solid #1a1a1a;box-shadow:3px 3px 0 rgba(26,26,26,0.15);"></video>
      </p>
      <p style="text-align:center;font-size:0.8em;font-style:italic;">Vidéo Reddit sans son (limitation technique de ce serveur) — pour la version complète avec le son, utilise « Voir l'original » en haut de page.</p>
      <script>
        (function () {
          var candidates = ${JSON.stringify(candidates)};
          var video = document.getElementById("reddit-video");
          var i = 0;
          function tryNext() {
            if (i >= candidates.length) return;
            video.src = candidates[i++];
          }
          video.addEventListener("error", tryNext);
          tryNext();
        })();
      </script>
    `;
    return htmlResponse(
      renderPage({
        title: "Vidéo Reddit",
        siteName: "reddit.com",
        bodyHtml,
        originalUrl,
        articleId,
        favorite
      })
    );
  }

  if (isRedditPostUrl(parsed)) {
    // Si on a déjà un texte pour ce post en base (fallbackExcerpt =
    // summary IA sinon sourceExcerpt tel que récupéré depuis le flux — ce
    // dernier est parfois déjà en français : Reddit traduit lui-même
    // certains posts côté flux/Redlib, indépendamment de toute IA de notre
    // côté), on le sert directement plutôt que d'aller chercher le texte
    // ORIGINAL (souvent anglais) via Redlib/l'API JSON officielle plus bas :
    // cohérence avec la vignette avant tout — c'est exactement le même
    // texte qui y est affiché — plus besoin d'aller-retour réseau pour un
    // résultat qu'on a déjà en base.
    if (fallbackExcerpt) {
      return htmlResponse(
        renderPage({
          title: fallbackTitle || "Post Reddit",
          siteName: "reddit.com",
          bodyHtml: `<p>${escapeHtml(fallbackExcerpt)}</p><div class="notice-box">Texte tel que récupéré depuis le flux (même texte qu'en vignette). Pour le texte original et les commentaires, utilise « Voir l'original » en haut de page.</div>`,
          originalUrl,
          articleId,
          favorite
        })
      );
    }

    // 1) Miroir Redlib (best-effort, voir REDLIB_INSTANCES) : rendu HTML
    //    complet côté serveur, passé par le même pipeline Readability que
    //    n'importe quel autre site.
    const redlib = await fetchViaRedlib(parsed);
    if (redlib) {
      const redlibDom = new JSDOM(redlib.html, { url: redlib.baseUrl });
      const redlibArticle = new Readability(redlibDom.window.document as unknown as Document).parse();
      if (redlibArticle && redlibArticle.content) {
        const contentDom = new JSDOM(`<div id="root">${redlibArticle.content}</div>`);
        rewriteContentImages(contentDom, redlib.baseUrl);
        contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());
        const rootEl = contentDom.window.document.getElementById("root");
        if (rootEl) trimTrailingJunk(rootEl);

        let finalTitle = redlibArticle.title || "Post Reddit";
        let finalBody = rootEl?.innerHTML || "";
        if (wantsTranslation) {
          const t = await translateArticle(finalTitle, finalBody);
          finalTitle = t.title;
          finalBody = t.bodyHtml;
        }

        return htmlResponse(
          renderPage({
            title: finalTitle,
            byline: redlibArticle.byline,
            siteName: "reddit.com",
            bodyHtml: finalBody,
            originalUrl,
            showTranslateLink: true,
            translated: wantsTranslation,
            articleId,
            favorite
          })
        );
      }
    }

    // 2) Repli sur l'API JSON officielle de Reddit (marche parfois même
    //    quand le HTML est bloqué).
    const redditPost = await fetchRedditPost(parsed);
    if (redditPost) {
      // Même traitement des images que le chemin générique : passage par
      // le proxy d'images pour les éventuelles illustrations du self-post.
      const contentDom = new JSDOM(`<div id="root">${redditPost.bodyHtml}</div>`);
      rewriteContentImages(contentDom, "https://www.reddit.com");
      let finalTitle = redditPost.title;
      let finalBody = contentDom.window.document.getElementById("root")?.innerHTML || "";
      if (wantsTranslation) {
        const t = await translateArticle(finalTitle, finalBody);
        finalTitle = t.title;
        finalBody = t.bodyHtml;
      }

      return htmlResponse(
        renderPage({
          title: finalTitle,
          byline: `Posté par u/${redditPost.author}`,
          siteName: redditPost.subreddit,
          bodyHtml: finalBody,
          originalUrl,
          showTranslateLink: true,
          translated: wantsTranslation,
          articleId,
          favorite
        })
      );
    }
    // 3) Ni les miroirs Redlib ni l'API JSON n'ont marché. Plutôt qu'un
    // simple message d'erreur, on retombe sur le texte déjà récupéré et
    // stocké depuis le flux RSS (sourceExcerpt/summary) s'il existe — non
    // tronqué, contrairement à la vignette limitée à 10 lignes.
    return htmlResponse(
      renderPage({
        title: fallbackTitle || "Reddit indisponible depuis ce serveur",
        bodyHtml: excerptFallbackBodyHtml(
          "Reddit bloque les requêtes venant de ce serveur (IP d'hébergeur), y compris via son API publique et les miroirs de secours essayés. Utilise « Ouvrir dans un nouvel onglet » pour lire ce post directement" +
            (fallbackExcerpt ? " ou lire les commentaires." : ".")
        ),
        originalUrl,
        articleId,
        favorite
      })
    );
  }

  try {
    const { morssBaseUrl } = await getSettings();
    const fetched = await fetchArticleHtml(fetchUrl, morssBaseUrl);

    if (!fetched || "error" in fetched) {
      // Fetch serveur bloqué (403, anti-bot...) même après repli morss. Si on
      // a déjà un titre/texte pour cet article en base (récupéré depuis le
      // flux RSS — voir fallbackExcerpt/fallbackTitle plus haut), on l'affiche
      // directement : PLUS FIABLE que l'iframe ci-dessous, et cohérent avec ce
      // que fait déjà ce même code pour Reddit et pour un Readability qui ne
      // trouve rien (voir plus bas). Vu en usage réel sur nytimes.com : le
      // flux RSS donne un titre et un extrait exploitables alors que le fetch
      // serveur ET l'iframe (X-Frame-Options bloqué par NYT) échouent tous
      // les deux — sans ce repli, la page ne montrait rien d'utile du tout.
      if (fallbackExcerpt) {
        return htmlResponse(
          renderPage({
            title: fallbackTitle || new URL(originalUrl).hostname.replace(/^www\./, ""),
            bodyHtml: excerptFallbackBodyHtml(
              "Lecture directe indisponible sur ce serveur (site bloquant, y compris via le repli morss) — voici l'aperçu récupéré depuis le flux. Utilise « Ouvrir dans un nouvel onglet » pour lire l'article complet."
            ),
            originalUrl,
            articleId,
            favorite
          })
        );
      }

      // Rien en base non plus : on tente d'afficher directement la page
      // source dans une iframe — la requête part alors du NAVIGATEUR du
      // visiteur, pas de ce serveur, donc contourne un blocage qui ne visait
      // QUE les requêtes serveur-à-serveur (cas fréquent : anti-bot basé sur
      // l'IP/réputation plutôt qu'un vrai blocage d'affichage). Sans garantie
      // non plus : certains sites (X-Frame-Options/CSP frame-ancestors)
      // refusent aussi l'affichage en iframe, auquel cas la zone reste vide —
      // "Ouvrir dans un nouvel onglet" (déjà en haut de page) reste alors le
      // seul recours.
      return htmlResponse(
        renderPage({
          title: new URL(originalUrl).hostname.replace(/^www\./, ""),
          bodyHtml: "",
          originalUrl,
          articleId,
          favorite,
          embedFallback: true
        })
      );
    }

    const { html: rawHtml, baseUrl: resolvedBaseUrl } = fetched;
    const dom = new JSDOM(rawHtml, { url: resolvedBaseUrl });
    // Cast : le type Document de jsdom et celui de lib.dom (attendu par
    // Readability) ne s'unifient pas toujours parfaitement en TS, alors
    // qu'ils sont compatibles à l'exécution (usage standard recommandé par
    // Mozilla pour Node).
    const article = new Readability(dom.window.document as unknown as Document).parse();

    if (!article || !article.content) {
      return htmlResponse(
        renderPage({
          title: fallbackTitle || "Article non extrait",
          bodyHtml: excerptFallbackBodyHtml(
            "Impossible d'extraire proprement le contenu de cet article. Utilise « Ouvrir dans un nouvel onglet » pour le lire directement sur le site source" +
              (fallbackExcerpt ? " — voici néanmoins l'aperçu récupéré depuis le flux." : ".")
          ),
          originalUrl,
          articleId,
          favorite
        })
      );
    }

    // Les images intégrées à l'article pointent encore vers le site
    // source — même souci de hotlinking que pour la vignette de la liste,
    // donc même traitement : on les fait passer par notre proxy d'images.
    const contentDom = new JSDOM(`<div id="root">${article.content}</div>`);
    rewriteContentImages(contentDom, fetchUrl);
    contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());

    const rootEl = contentDom.window.document.getElementById("root");
    if (rootEl) {
      trimTrailingJunk(rootEl);
      trimLeadingJunk(rootEl);
    }

    let finalTitle = article.title || "Article";
    let finalBody = rootEl?.innerHTML || "";
    if (wantsTranslation) {
      const t = await translateArticle(finalTitle, finalBody);
      finalTitle = t.title;
      finalBody = t.bodyHtml;
    }

    return htmlResponse(
      renderPage({
        title: finalTitle,
        byline: article.byline,
        siteName: article.siteName,
        bodyHtml: finalBody,
        originalUrl,
        showTranslateLink: true,
        translated: wantsTranslation,
        articleId,
        favorite
      })
    );
  } catch (err: any) {
    return htmlResponse(
      renderPage({
        title: "Erreur",
        bodyHtml: `<p>Erreur lors de la récupération de l'article : ${escapeHtml(
          err?.message || "inconnue"
        )}. Utilise « Ouvrir dans un nouvel onglet ».</p>`,
        originalUrl,
        articleId,
        favorite
      })
    );
  }
}
