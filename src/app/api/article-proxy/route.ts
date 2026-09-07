import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { prisma } from "@/lib/prisma";
import { MORSS_BASE_URL, getSettings } from "@/lib/settings";
import { paletteFor, rgb } from "@/lib/theme";
import { getRedlibInstances, isRedditHostname, isRedditImageHostname, isRedditVideoHostname } from "@/lib/reddit";
import { isAlreadyMorssUrl, splitIntoReadableParagraphs, BROWSER_USER_AGENT } from "@/lib/text";
import { isForbiddenProxyTarget } from "@/lib/urlGuard";
import { hoistNestedArticleIfClearlyBetter, deepTrimJunk } from "@/lib/articleClean";
import { translateBestEffort, translateOrNull, translateBatchOrNull, type TranslateOptions } from "@/lib/translate";

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

// fallbackExcerpt (sourceExcerpt en base) est stocké aplati en une seule
// ligne (voir stripHtml) — aucun paragraphe d'origine n'est récupérable. On
// reconstruit un découpage approximatif par regroupement de phrases plutôt
// que d'afficher tout le texte dans un unique <p> (voir
// splitIntoReadableParagraphs).
function excerptToParagraphsHtml(excerpt: string): string {
  return splitIntoReadableParagraphs(excerpt)
    .map((p) => `<p>${escapeHtml(p)}</p>`)
    .join("");
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
  // "gray.svg"/"backgrounds/gray..." (Gamekult confirmé en usage réel, voir
  // resolveImgSrc) : image de fond grise servant de squelette de chargement
  // tant que le JS du site n'a pas injecté la vraie image — jamais du vrai
  // contenu, quel que soit le nom exact du fichier de fond utilisé.
  return /placeholder|blank\.gif|spacer\.gif|1x1\.(?:gif|png)|\/backgrounds?\/gray/i.test(src);
}

/** Beaucoup de sites (Gamekult confirmé en usage réel) chargent leurs
 *  images en lazy-load : le vrai chemin n'est présent que dans un attribut
 *  data-* (data-src, data-lazy-src, data-original, data-img-src-default, ou
 *  le premier candidat d'un data-srcset), tant que "src" ne contient qu'un
 *  pixel/placeholder — sans ce repli, l'image proxifiée pointe vers ce
 *  placeholder et reste invisible. Retourne l'URL à utiliser, ou null si
 *  vraiment aucune trouvée (voir rewriteContentImages : dans ce cas précis,
 *  mieux vaut retirer l'image que servir/afficher le placeholder gris tel
 *  quel).
 */
function resolveImgSrc(el: Element): string | null {
  const src = el.getAttribute("src");
  if (src && !looksLikeLazyPlaceholder(src)) return src;
  const lazyCandidate =
    el.getAttribute("data-src") ||
    el.getAttribute("data-lazy-src") ||
    el.getAttribute("data-original") ||
    el.getAttribute("data-img-src-default") ||
    el.getAttribute("data-srcset")?.split(",")[0]?.trim().split(/\s+/)[0] ||
    null;
  // Contrairement à avant, on ne retombe PLUS sur "src" tel quel quand aucun
  // candidat lazy n'a été trouvé : "src" à ce stade N'EST QUE le placeholder
  // (on vient d'établir looksLikeLazyPlaceholder(src) === true ci-dessus) —
  // le proxifier ne ferait qu'afficher un rectangle gris vide. Vu en usage
  // réel sur Gamekult : le vrai chemin n'est présent NULLE PART dans le HTML
  // statique (chargé par le JS du site via un simple index numérique,
  // data-gt-index, jamais l'URL elle-même) — pas de repli possible dans ce
  // cas, autant retirer l'image (voir rewriteContentImages) plutôt que
  // montrer un carré gris cassé.
  return lazyCandidate || null;
}

/**
 * Force les liens du corps de l'article (ceux en rouge) à s'ouvrir dans un
 * NOUVEL onglet. Cette page est servie dans l'iframe du lecteur interne :
 * sans "target", un clic remplace le lecteur lui-même par le site externe —
 * on perd l'article en cours de lecture, et beaucoup de sites refusent de
 * toute façon d'être affichés en iframe, laissant une zone blanche.
 *
 * Les URL sont aussi rendues absolues au passage : Readability conserve
 * parfois des liens relatifs ("/produit/123"), qui pointeraient sinon vers
 * NOTRE domaine et non vers le site d'origine.
 *
 * rel="noopener noreferrer" : sans "noopener", la page ouverte garde une
 * référence JavaScript vers celle qui l'a ouverte et peut la faire naviguer
 * ailleurs à notre insu.
 */
function openContentLinksInNewTab(contentDom: JSDOM, baseUrl: string): void {
  contentDom.window.document.querySelectorAll("a[href]").forEach((el) => {
    const href = el.getAttribute("href") || "";
    // Les ancres internes ("#section") n'ont aucun sens dans un nouvel
    // onglet : elles ne mènent nulle part hors de cette page.
    if (!href.trim() || href.startsWith("#")) return;
    try {
      el.setAttribute("href", new URL(href, baseUrl).toString());
    } catch {
      // href inexploitable (javascript:, mailto:, URL malformée) : on laisse
      // tel quel plutôt que de le casser.
    }
    el.setAttribute("target", "_blank");
    el.setAttribute("rel", "noopener noreferrer");
  });
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
    } else {
      const currentSrc = el.getAttribute("src") || "";
      if (looksLikeLazyPlaceholder(currentSrc)) {
        // Aucun vrai chemin récupérable (voir resolveImgSrc) : on retire
        // l'image plutôt que de servir le placeholder gris (un carré gris
        // cassé est pire qu'une absence d'image). Si c'était le seul contenu
        // de son <p> parent (cas Gamekult : chaque image lazy est seule dans
        // son propre <p>), on retire aussi ce <p> devenu vide pour ne pas
        // laisser un paragraphe blanc fantôme dans le texte.
        const parent = el.parentElement;
        el.remove();
        if (parent && parent.tagName === "P" && !(parent.textContent || "").trim() && parent.children.length === 0) {
          parent.remove();
        }
      }
    }
    el.removeAttribute("srcset");
    el.removeAttribute("data-src");
    el.removeAttribute("data-lazy-src");
    el.removeAttribute("data-original");
    el.removeAttribute("data-img-src-default");
    el.removeAttribute("data-srcset");
  });
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
  /** Déclinaison de couleur choisie dans /admin/settings (voir
   *  src/lib/theme.ts). Cette page est du HTML autonome, servi en iframe
   *  hors du CSS de l'application : elle ne peut lire aucune variable CSS et
   *  reçoit donc les couleurs en dur, écrites dans sa propre feuille. */
  accent?: string | null;
}): string {
  const { title, byline, siteName, bodyHtml, originalUrl, showTranslateLink, translated, articleId, favorite, embedFallback, accent } =
    opts;
  // Couleurs de la déclinaison choisie, écrites EN DUR dans la feuille de
  // style ci-dessous : cette page est du HTML autonome servi en iframe, hors
  // du bundle de l'application — elle ne peut lire aucune variable CSS de
  // globals.css. src/lib/theme.ts reste la source unique des deux côtés.
  const pal = paletteFor(accent);
  const paper = rgb(pal.paper);
  const surface = rgb(pal.surface);
  const ink = rgb(pal.ink);
  const rule = rgb(pal.rule);
  const sepia = rgb(pal.sepia);
  const journal = rgb(pal.journal);
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
  // serveur complet avec le contenu traduit via l'instance LibreTranslate
  // auto-hébergée (best-effort — cf. translateArticle plus bas : si elle est
  // injoignable, le texte d'origine est réaffiché tel quel).
  const translateHref = `/api/article-proxy?url=${encodeURIComponent(originalUrl)}${translated ? "" : "&translate=1"}`;
  const translateLabel = translated ? "Texte original ↺" : "Traduire en français ⇄";
  // URL de la version d'origine (sans &translate=1) — sert au retour "Texte
  // original" après une traduction progressive appliquée en place.
  const originalHref = `/api/article-proxy?url=${encodeURIComponent(originalUrl)}`;
  // Traduction PROGRESSIVE possible seulement sur une page en langue d'origine
  // qui a un vrai contenu d'article (pas un repli iframe, pas une page déjà
  // traduite côté serveur). Dans ce cas on marque les blocs traduisibles pour
  // que le script client puisse les cibler et les faire basculer un par un au
  // fil du flux — voir le POST plus bas. Sinon, comportement d'origine (lien
  // classique vers &translate=1, rendu serveur complet).
  const canProgressiveTranslate = Boolean(showTranslateLink && !translated && !embedFallback);
  const bodyForRender = canProgressiveTranslate ? tagTranslatableBlocks(bodyHtml) : bodyHtml;
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  /* Le lecteur est une SURFACE posée au-dessus du site, pas le fond de page :
     il prend donc le ton "surface" (un cran plus clair que les marges du
     site). Avec le ton "paper", il paraissait simplement noir. */
  html { background: ${surface}; }
  body {
    margin: 0;
    padding: 40px 28px 70px;
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
    background-color: ${surface};
    color: ${ink};
    line-height: 1.7;
    font-size: 15px;
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
    color: ${sepia};
    padding-bottom: 6px;
    border-bottom: 1px solid ${rule};
    margin-bottom: 4px;
  }
  .meta-top a { color: ${journal}; text-decoration: none; }
  .meta-top a:hover { text-decoration: underline; }
  .meta-left { text-align: left; }
  .meta-center { text-align: center; }
  .meta-right { text-align: right; }
  .double-rule { border-top: 1px solid ${rule}; height: 6px; margin: 2px 0 22px; }
  .kicker {
    text-align: center;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.3em;
    color: ${journal};
    margin: 22px 0 6px;
  }
  h1 {
    font-weight: 800;
    font-size: 2.15rem;
    line-height: 1.15;
    text-align: center;
    margin: 0 0 8px;
  }
  .byline {
    text-align: center;
    font-size: 0.78rem;
    font-style: italic;
    color: ${sepia};
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
    color: ${sepia};
  }
  .fav-star svg path { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linejoin: round; }
  .fav-star.is-fav { color: ${journal}; }
  .fav-star.is-fav svg path { fill: currentColor; }
  .source-bottom {
    text-align: center;
    font-size: 0.8rem;
    font-style: italic;
    color: ${sepia};
    margin-top: 2.6em;
  }
  /* Texte au fil de l'eau, ni justifié ni coupé : la justification creuse des
     rivières blanches et des espaces irréguliers, très visibles à l'écran. */
  .article-body { text-align: left; hyphens: none; }
  .article-body p { margin: 1.05em 0; }
  .article-body img, .article-body picture {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.4em auto;
    /* Contrairement aux vignettes de la liste (en noir et blanc par défaut),
       la photo dans l'article ouvert reste toujours en couleur. */
    border: 1px solid ${rule};
    cursor: zoom-in;
  }
  /* Popup zoom plein écran au clic sur une image de l'article — overlay
     sombre + image centrée, fermeture au clic n'importe où ou touche Échap. */
  .lightbox-overlay {
    display: none;
    position: fixed;
    inset: 0;
    z-index: 999;
    background: rgba(0, 0, 0, 0.92);
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
  .article-body figcaption { font-size: 0.75rem; color: ${sepia}; font-style: italic; text-align: center; margin-top: 0.4em; }
  .article-body a { color: ${journal}; }
  .article-body blockquote {
    border-left: 3px solid ${rule};
    margin: 1.2em 0;
    padding: 0.2em 0 0.2em 1.1em;
    color: ${sepia};
    font-style: italic;
  }
  .article-body h2, .article-body h3 {
    font-weight: 700;
    margin: 1.4em 0 0.5em;
  }
  /* Encadré d'avertissement (repli texte Reddit/extraction échouée) — même
     esprit que les cartes d'article de l'appli React, placé APRÈS le texte
     récupéré plutôt qu'avant, sur toute la largeur de la zone de texte. */
  .notice-box {
    margin-top: 2.4em;
    border: 1px solid ${rule};
    background: ${paper};
    padding: 1em 1.2em;
    font-size: 0.85rem;
    line-height: 1.6;
    color: ${sepia};
  }
  /* Bouton "lire l'article d'origine" — même silhouette que les boutons
     d'action de l'application (voir .stamp-button dans globals.css),
     répliquée en CSS pur puisque cette page est servie hors du bundle
     Tailwind. */
  .stamp-link {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem 1rem;
    border: 1px solid ${rule};
    border-radius: 0.25rem;
    background-color: ${paper};
    color: ${ink};
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    text-decoration: none;
    transition: border-color 0.15s ease;
  }
  .stamp-link:hover { border-color: ${journal}; }
  .stamp-wrap { text-align: center; margin-top: 2.6em; }
  /* Cul-de-lampe en cuillères : dans la couleur d'accent, seul ornement
     conservé de l'application. */
  .colophon { text-align: center; margin-top: 3.2em; color: ${journal}; }
  .colophon svg { display: inline-block; vertical-align: middle; margin: 0 9px; fill: currentColor; }
  /* Repli iframe (fetch serveur bloqué) : occupe la hauteur visible de la
     fenêtre plutôt qu'une hauteur fixe arbitraire, pour rester utilisable
     sur mobile comme desktop. */
  .embed-frame {
    display: block;
    width: 100%;
    height: 78vh;
    min-height: 420px;
    border: 1px solid ${rule};
    background: #fff;
  }
  .embed-note { text-align: center; font-size: 0.75rem; font-style: italic; color: ${sepia}; margin: 0.8em 0 1.6em; }
  /* Barre de progression en haut de page, affichée le temps du rechargement
     complet déclenché par le lien "Traduire en français" — la traduction
     (appels séquentiels côté serveur, voir translateContentHtml) peut prendre
     plusieurs secondes, pendant lesquelles cette page ne montre autrement
     aucun signe de chargement (navigation classique d'un lien <a>, pas une
     requête fetch qu'on pourrait suivre) — surtout visible ici puisque la
     page est servie dans une iframe de lecture, où le chrome du navigateur
     hôte ne montre rien non plus. Défilement indéterminé (on ne connaît pas
     la progression réelle) plutôt qu'une vraie barre de pourcentage. */
  .translate-progress {
    position: fixed;
    top: 0;
    left: 0;
    height: 3px;
    width: 40%;
    background: ${ink};
    z-index: 1000;
    opacity: 0;
    pointer-events: none;
    /* Remplissage progressif fluide en mode déterminé (traduction progressive,
       la largeur est pilotée en JS bloc par bloc). */
    transition: width 0.25s ease-out;
  }
  .translate-progress.is-active { opacity: 1; }
  /* Mode INDÉTERMINÉ : repli sans traduction progressive (page déjà traduite
     côté serveur, ou JS qui bascule sur la navigation classique) — on ne connaît
     pas la progression réelle, donc le ruban défile en boucle. */
  .translate-progress.is-active.is-indeterminate {
    width: 40%;
    animation: translate-progress-slide 1.1s ease-in-out infinite;
  }
  @keyframes translate-progress-slide {
    0% { margin-left: -40%; }
    100% { margin-left: 100%; }
  }
  /* Pendant la traduction, tout ce qui est encore en langue d'origine est
     estompé ; chaque bloc retrouve sa teinte pleine au moment où sa traduction
     arrive. On voit ainsi l'avancement descendre dans la page, en plus de la
     barre du haut. */
  [data-tr-block] { transition: opacity 0.35s ease; }
  [data-tr-block].tr-pending { opacity: 0.45; }
  /* Bref halo au moment où un bloc bascule en français, pour que l'œil suive la
     progression sans que ce soit clignotant/agressif. */
  @keyframes tr-just-flash {
    from { background-color: ${journal}22; }
    to { background-color: transparent; }
  }
  [data-tr-block].tr-just {
    animation: tr-just-flash 0.9s ease-out;
    border-radius: 2px;
  }
</style>
</head>
<body>
  <div class="translate-progress" id="translate-progress"></div>
  <div class="page">
    <p class="meta-top">
      <span class="meta-left"></span>
      <span class="meta-center">
        ${showTranslateLink ? `<a href="${escapeHtml(translateHref)}" id="translate-link">${translateLabel}</a>` : ""}
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
    <div class="article-body">${bodyForRender}</div>
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
  <script>
(function () {
  var link = document.getElementById("translate-link");
  var bar = document.getElementById("translate-progress");
  if (!link || !bar) return;

  // Valeurs injectées par le serveur (voir renderPage).
  var PROGRESSIVE = ${canProgressiveTranslate ? "true" : "false"};
  var ORIGINAL_HREF = ${JSON.stringify(originalHref)};
  var FALLBACK_HREF = ${JSON.stringify(translateHref)};
  var ORIG_LABEL = ${JSON.stringify(translateLabel)};

  // Repli : page déjà traduite côté serveur, ou traduction progressive non
  // applicable. Comportement d'origine — on affiche la barre indéterminée puis
  // on laisse la navigation classique du lien <a> suivre son cours.
  if (!PROGRESSIVE) {
    link.addEventListener("click", function () {
      bar.classList.add("is-active");
      bar.classList.add("is-indeterminate");
    });
    window.addEventListener("pageshow", function () {
      bar.classList.remove("is-active");
      bar.classList.remove("is-indeterminate");
    });
    return;
  }

  // Traduction PROGRESSIVE : la page reste affichée en langue d'origine ; au
  // clic on demande au serveur (POST) de traduire les blocs et on les fait
  // basculer un par un dès qu'ils arrivent dans le flux, la barre se
  // remplissant au fur et à mesure. Aucun rechargement de page.
  var busy = false;
  var translatedInPlace = false;

  function setWidth(p) {
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    bar.style.width = p + "%";
  }

  link.addEventListener("click", function (e) {
    // Une fois traduit en place, le lien redevient "Texte original" et recharge
    // la version d'origine (rendue par le serveur, sans &translate=1).
    if (translatedInPlace) {
      window.location.href = ORIGINAL_HREF;
      return;
    }
    e.preventDefault();
    if (busy) return;
    run();
  });

  window.addEventListener("pageshow", function () {
    if (!busy) {
      bar.classList.remove("is-active");
      setWidth(0);
    }
  });

  // Construit, pour un bloc, la chaîne à faire traduire. Le balisage interne
  // (lien, gras, italique...) est remplacé par un repère {0}, {1}... : la phrase
  // reste donc entière et cohérente pour le moteur, et les éléments d'origine
  // sont réinsérés APRÈS traduction, à la place où le repère a atterri — même si
  // le français en change l'ordre. C'est ce qui permet de traduire un paragraphe
  // contenant un lien sans le casser.
  function buildTemplate(el) {
    var parts = [];
    var inlines = [];
    var kids = el.childNodes;
    for (var n = 0; n < kids.length; n++) {
      var node = kids[n];
      if (node.nodeType === 3) {
        parts.push(node.nodeValue || "");
      } else if (node.nodeType === 1) {
        parts.push("{" + inlines.length + "}");
        inlines.push(node);
      }
    }
    return { template: parts.join(""), inlines: inlines };
  }

  function run() {
    var els = Array.prototype.slice.call(document.querySelectorAll(".article-body [data-tr-block]"));
    if (els.length === 0) {
      // Rien à traduire côté client : on laisse le repli serveur faire foi.
      window.location.href = FALLBACK_HREF;
      return;
    }

    // Une entrée par bloc ; "texts" est la liste à plat envoyée au serveur
    // (le gabarit du bloc, puis le texte propre de chacun de ses éléments
    // internes). Le serveur reste un simple traducteur de chaînes : c'est ici
    // qu'on sait à quel bloc chaque index appartient.
    var entries = [];
    var texts = [];
    var owner = [];
    for (var b = 0; b < els.length; b++) {
      var el = els[b];
      var built = buildTemplate(el);
      // Un bloc sans la moindre lettre (une image seule, un séparateur...) n'a
      // rien à traduire.
      if (!/[A-Za-zÀ-ÖØ-öø-ÿ]/.test(built.template)) continue;
      var entry = {
        el: el,
        inlines: built.inlines,
        templateIndex: texts.length,
        inlineIndices: [],
        remaining: 1
      };
      owner[texts.length] = entry;
      texts.push(built.template.trim());
      for (var q = 0; q < built.inlines.length; q++) {
        owner[texts.length] = entry;
        entry.inlineIndices.push(texts.length);
        entry.remaining++;
        texts.push((built.inlines[q].textContent || "").trim());
      }
      entries.push(entry);
    }
    if (entries.length === 0) {
      window.location.href = FALLBACK_HREF;
      return;
    }

    var results = new Array(texts.length);
    var total = texts.length;
    var done = 0;
    var applied = 0;
    busy = true;
    bar.classList.add("is-active");
    setWidth(3);
    link.textContent = "Traduction…";
    // Tout ce qui est encore en langue d'origine passe en estompé ; chaque bloc
    // reprend sa teinte pleine dès que sa traduction est appliquée.
    for (var g = 0; g < entries.length; g++) entries[g].el.classList.add("tr-pending");

    // Réinsère la traduction dans le bloc. Les repères sont vérifiés AVANT de
    // toucher au DOM : s'il en manque un (le moteur l'a avalé), on ne touche à
    // rien et le bloc reste en langue d'origine — jamais de bloc mutilé.
    function applyEntry(e) {
      var tpl = results[e.templateIndex];
      var ok = false;
      if (typeof tpl === "string" && tpl.trim()) {
        if (e.inlines.length === 0) {
          e.el.textContent = tpl;
          ok = true;
        } else {
          var complete = true;
          for (var k = 0; k < e.inlines.length; k++) {
            if (tpl.indexOf("{" + k + "}") === -1) { complete = false; break; }
          }
          if (complete) {
            var frag = document.createDocumentFragment();
            var re = /\\{(\\d+)\\}/g;
            var last = 0;
            var m;
            while ((m = re.exec(tpl)) !== null) {
              if (m.index > last) frag.appendChild(document.createTextNode(tpl.slice(last, m.index)));
              var node = e.inlines[parseInt(m[1], 10)];
              if (node) {
                var inlineText = results[e.inlineIndices[parseInt(m[1], 10)]];
                // On ne réécrit le texte d'un élément interne que s'il est
                // lui-même en texte nu (sinon on écraserait son propre balisage).
                if (typeof inlineText === "string" && inlineText && node.children.length === 0) {
                  node.textContent = inlineText;
                }
                frag.appendChild(node);
              }
              last = m.index + m[0].length;
            }
            if (last < tpl.length) frag.appendChild(document.createTextNode(tpl.slice(last)));
            while (e.el.firstChild) e.el.removeChild(e.el.firstChild);
            e.el.appendChild(frag);
            ok = true;
          }
        }
      }
      e.el.classList.remove("tr-pending");
      if (ok) {
        e.el.classList.add("tr-just");
        applied++;
      }
    }

    function finish() {
      if (!busy) return;
      busy = false;
      // Un bloc jamais traduit (flux interrompu, budget atteint, moteur muet)
      // ne doit pas rester estompé pour toujours : il reprend sa teinte pleine,
      // simplement en langue d'origine.
      for (var f = 0; f < entries.length; f++) entries[f].el.classList.remove("tr-pending");
      setWidth(100);
      setTimeout(function () {
        bar.classList.remove("is-active");
        setWidth(0);
      }, 450);
      if (applied > 0) {
        translatedInPlace = true;
        link.textContent = "Texte original ↺";
      } else {
        // Aucun bloc n'a pu être traduit (moteur indisponible) : on ne fait pas
        // croire à une bascule réussie, on rend la main pour réessayer.
        link.textContent = ORIG_LABEL;
      }
    }

    fetch("/api/article-proxy", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ texts: texts })
    }).then(function (res) {
      if (!res.ok || !res.body) throw new Error("flux indisponible");
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buf = "";
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) { finish(); return; }
          buf += decoder.decode(r.value, { stream: true });
          var lines = buf.split("\\n");
          buf = lines.pop();
          for (var k = 0; k < lines.length; k++) {
            var line = lines[k];
            if (!line || !line.trim()) continue;
            var msg;
            try { msg = JSON.parse(line); } catch (err) { continue; }
            if (msg && msg.done) { finish(); return; }
            if (msg && typeof msg.i === "number") {
              if (msg.ok && typeof msg.text === "string") results[msg.i] = msg.text;
              // Un bloc n'est réécrit qu'une fois TOUTES ses pièces reçues
              // (son gabarit + le texte de chacun de ses éléments internes),
              // sinon on le reconstruirait avec des morceaux manquants.
              var e = owner[msg.i];
              if (e) {
                e.remaining--;
                if (e.remaining === 0) applyEntry(e);
              }
              done++;
              setWidth(4 + (done / total) * 96);
            }
          }
          return pump();
        });
      }
      return pump();
    }).catch(function () {
      if (translatedInPlace) return;
      // Flux impossible : repli sur la traduction serveur classique plutôt que
      // de laisser l'utilisateur sans rien.
      window.location.href = FALLBACK_HREF;
    });
  }
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
// page, jamais automatique) — le moteur vit dans src/lib/translate.ts,
// partagé avec le backfill automatique des vignettes "En direct"
// (syncTranslateFlags, voir generateEdition.ts).

// Limite le nombre de blocs traduits par article. Plus une question de quota
// (l'instance LibreTranslate est auto-hébergée et illimitée — voir
// src/lib/translate.ts) mais de TEMPS : chaque bloc est une requête
// séquentielle vers un moteur qui tourne sur le processeur du serveur, sans
// carte graphique. Sans plafond, un article très long resterait des minutes à
// s'ouvrir.
const MAX_BLOCKS_TO_TRANSLATE = 60;

// Budget GLOBAL pour la traduction d'un article ouvert : tant qu'elle tourne,
// la requête HTTP reste ouverte et l'utilisateur regarde une page blanche avec
// la barre de progression qui défile. Passé ce délai total, on rend la main
// immédiatement en gardant la langue d'origine pour les blocs restants. Sans ce
// plafond, un article long dont le moteur répond lentement pouvait bloquer la
// page une ou deux minutes ; et si le moteur ne répondait plus DU TOUT, chaque
// bloc attendait son propre timeout l'un après l'autre —
// MAX_BLOCKS_TO_TRANSLATE × timeout, soit jusqu'à une vingtaine de minutes de
// page blanche (constaté en usage réel : "ça tourne en boucle, je ne sais même
// pas si ça finira").
const ARTICLE_TRANSLATE_BUDGET_MS = 90000;

// Budget du chemin PROGRESSIF (flux), bien plus large que celui ci-dessus : là
// où le rendu serveur bloquant fait patienter devant une page blanche — d'où
// les 90s —, ici les blocs basculent au fil de l'eau. L'utilisateur lit déjà le
// début pendant que la suite arrive, et rien ne l'empêche de faire autre chose,
// donc écourter la traduction d'un article long n'apporterait rien : ça
// laisserait juste la fin en langue d'origine sans raison. L'abandon rapide en
// cas de moteur muet (échecs consécutifs) protège toujours du cas "LibreTranslate
// ne répond plus".
const ARTICLE_STREAM_BUDGET_MS = 420000;

// Plafond de chaînes acceptées par le flux. Une chaîne = un gabarit de bloc OU
// le texte d'un élément interne (lien, gras) — il en faut donc plus que le
// simple nombre de blocs.
const MAX_STREAM_STRINGS = 800;

// Les textes sont envoyés au moteur PAR LOTS plutôt qu'un par un. Constaté en
// usage réel : un appel HTTP par bloc et par lien, ça faisait des centaines
// d'appels pour un seul article — assez pour dépasser le plafond de cadence de
// l'instance (LT_REQ_LIMIT) et pour empiler les connexions sur un conteneur
// déjà juste en mémoire. La traduction s'arrêtait alors net au milieu.
// Le lot reste petit exprès : le but est de diviser le nombre d'appels, pas de
// tout envoyer d'un bloc — les blocs continuent d'apparaître au fil de l'eau.
const STREAM_BATCH_MAX_ITEMS = 8;
// Volume de caractères par lot, gardé bien sous LT_CHAR_LIMIT (5000 côté
// instance) puisque cette limite s'applique à la requête entière.
const STREAM_BATCH_MAX_CHARS = 2500;
// Un lot contient plusieurs textes : il lui faut plus de temps qu'un texte seul.
const STREAM_BATCH_TIMEOUT_MS = 45000;
// Respiration avant de retenter un lot : une surcharge passagère ou un
// redémarrage du conteneur se résorbe souvent en une poignée de secondes, et
// réessayer dans la milliseconde ne ferait qu'ajouter à la charge.
const STREAM_RETRY_PAUSE_MS = 1500;

// Timeout PAR BLOC, volontairement plus court que celui du backfill de fond
// (TIMEOUT_MS = 45s dans translate.ts) : là-bas un lot est retraité au passage
// suivant sans que personne n'attende, et le conteneur peut être en train de
// charger ses modèles ; ICI quelqu'un attend en direct, donc mieux vaut
// abandonner vite un bloc récalcitrant que bloquer toute la page dessus.
const ARTICLE_PER_BLOCK_TIMEOUT_MS = 15000;

// Au-delà de ce nombre d'échecs CONSÉCUTIFS, on considère le moteur
// indisponible et on cesse d'essayer : inutile de faire attendre un timeout à
// l'utilisateur sur chacun des blocs restants un par un. La page rend alors la
// version d'origine tout de suite. Seuil à 3 (et non 1) pour ne pas abandonner
// tout l'article à cause d'un unique bloc lent sur un moteur par ailleurs sain.
const ARTICLE_MAX_CONSECUTIVE_FAILURES = 3;

// Sélecteur + règles de sélection des blocs traduisibles — UNE SEULE source,
// partagée par les trois usages : le rendu serveur non progressif
// (translateContentHtml), le marquage pour la traduction progressive
// (tagTranslatableBlocks) et, indirectement, le script client qui ne cible que
// les éléments ainsi marqués. Toute divergence désalignerait les index entre le
// navigateur et le flux serveur.
const TRANSLATABLE_BLOCK_SELECTOR = "p, li, blockquote, h1, h2, h3, h4, figcaption";
function selectTranslatableBlocks(root: Element): Element[] {
  return Array.from(root.querySelectorAll(TRANSLATABLE_BLOCK_SELECTOR))
    .slice(0, MAX_BLOCKS_TO_TRANSLATE)
    // Mêmes exclusions que la traduction elle-même : uniquement les blocs sans
    // élément enfant (sinon on casserait un lien/une image en réécrivant le
    // texte) et non vides.
    .filter((el) => el.children.length === 0 && Boolean((el.textContent || "").trim()));
}

// Plafond de blocs pour la traduction PROGRESSIVE, bien plus haut que celui du
// rendu serveur bloquant : ici rien ne bloque la page (les blocs basculent au
// fil de l'eau et l'utilisateur lit déjà le début pendant que la suite arrive),
// donc rien ne justifie de s'arrêter à 60 blocs sur un article long.
const MAX_PROGRESSIVE_BLOCKS = 200;

/**
 * Marque, dans le HTML du corps d'article, chaque bloc traduisible d'un
 * attribut data-tr-block="" — repère stable que le script client utilise pour
 * retrouver EXACTEMENT le même ensemble de blocs, dans le même ordre.
 *
 * Contrairement à selectTranslatableBlocks (rendu serveur, qui ne sait traiter
 * que du texte nu), on retient ICI AUSSI les blocs contenant du balisage
 * interne — liens, gras, italique. C'était la cause du "à moitié traduit" :
 * dans un article réel, la plupart des paragraphes contiennent au moins un lien
 * ou un mot en gras, et ils restaient tous en langue d'origine. Le script
 * client sait les traduire sans les casser (repères {0}, {1}... à la place des
 * éléments internes, réinsérés après traduction — voir buildTemplate/applyEntry).
 *
 * Seule exclusion restante : les blocs qui CONTIENNENT eux-mêmes un autre bloc
 * traduisible (ex. un <blockquote> qui enveloppe un <p>). Sans ça, le même
 * texte serait traduit deux fois et les deux réécritures se marcheraient dessus
 * dans le DOM. On ne garde donc que les blocs "feuilles" — leurs enfants
 * éventuels ne sont alors que du balisage en ligne, ce que le client gère.
 */
function tagTranslatableBlocks(html: string): string {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return html;
  Array.from(root.querySelectorAll(TRANSLATABLE_BLOCK_SELECTOR))
    .filter(
      (el) =>
        Boolean((el.textContent || "").trim()) && el.querySelector(TRANSLATABLE_BLOCK_SELECTOR) === null
    )
    .slice(0, MAX_PROGRESSIVE_BLOCKS)
    .forEach((el) => el.setAttribute("data-tr-block", ""));
  return root.innerHTML;
}

async function translateContentHtml(html: string, opts: TranslateOptions): Promise<string> {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return html;
  const blocks = selectTranslatableBlocks(root);
  const blockOpts: TranslateOptions = { ...opts, timeoutMs: ARTICLE_PER_BLOCK_TIMEOUT_MS };
  const deadline = Date.now() + ARTICLE_TRANSLATE_BUDGET_MS;
  let consecutiveFailures = 0;
  for (const el of blocks) {
    // On traduit le TEXTE (textContent), pas le balisage interne
    // (innerHTML) — et uniquement pour les blocs qui n'ont aucun élément
    // enfant. Deux raisons :
    //   1. envoyer du HTML à traduire revient à laisser le moteur réécrire
    //      des balises : il en supprime, en déplace, et le balisage revient
    //      abîmé ;
    //   2. un bloc contenant une image ou un lien verrait ces éléments
    //      purement et simplement supprimés en réécrivant son texte.
    // Les blocs à balisage interne gardent donc leur langue d'origine plutôt
    // que de risquer d'être cassés — compromis assumé.
    if (el.children.length > 0) continue;
    const original = (el.textContent || "").trim();
    if (!original) continue;
    // Budget global épuisé, ou moteur visiblement indisponible (trop d'échecs
    // d'affilée) : on s'arrête là. textContent est déjà en langue d'origine
    // pour ce bloc et les suivants, donc il n'y a rien à faire — on les laisse
    // tels quels.
    if (Date.now() >= deadline || consecutiveFailures >= ARTICLE_MAX_CONSECUTIVE_FAILURES) break;
    // translateOrNull (et pas translateBestEffort) pour DISTINGUER un échec
    // d'une vraie traduction : best-effort renverrait le texte d'origine dans
    // les deux cas, empêchant de détecter que le moteur ne répond plus.
    const translated = await translateOrNull(original, blockOpts);
    if (translated !== null) {
      el.textContent = translated;
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
    }
  }
  return root.innerHTML;
}

async function translateArticle(title: string, bodyHtml: string): Promise<{ title: string; bodyHtml: string }> {
  // Adresse et clé de l'instance viennent des réglages (modifiables sans
  // redéploiement) — lues une seule fois par article traduit, puis passées à
  // chaque appel plutôt que relues à chaque bloc.
  const { libretranslateUrl, libretranslateApiKey } = await getSettings();
  const opts = { libretranslateUrl, libretranslateApiKey };
  const [translatedTitle, translatedBody] = await Promise.all([
    // Titre : même timeout court que les blocs (utilisateur en attente), pas
    // les 45s du backfill.
    translateBestEffort(title, { ...opts, timeoutMs: ARTICLE_PER_BLOCK_TIMEOUT_MS }),
    translateContentHtml(bodyHtml, opts)
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

// getRedlibInstances() (essai best-effort avant l'API JSON officielle) vit
// désormais dans src/lib/reddit.ts, partagé avec redditFeedHealth.ts et
// customFeeds.ts — lit un cache auto-rafraîchi par le worker (voir
// refreshRedlibInstanceCache), jamais de sondage réseau ici.
async function fetchViaRedlib(parsed: URL): Promise<{ html: string; baseUrl: string } | null> {
  const path = parsed.pathname + parsed.search;
  for (const instance of await getRedlibInstances()) {
    const target = `${instance}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(target, {
        signal: controller.signal,
        headers: {
          "User-Agent": BROWSER_USER_AGENT,
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
        "User-Agent": BROWSER_USER_AGENT,
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
 * ce serveur l'est (cas fréquent : NYTimes, Cloudflare, korben.info...).
 * "<instance morss>/:get=page/<url sans schéma>" est la syntaxe ACTUELLE de
 * morss pour récupérer une page HTML unique déjà nettoyée (script/iframe
 * retirés, liens absolutisés — voir cgi_get dans morss/wsgi.py) plutôt qu'un
 * flux RSS ; c'est ensuite CE HTML que Readability (ci-dessous) traite pour
 * en extraire l'article. L'ancienne syntaxe "/:html/<url>" (bare option, pas
 * ":get=page") ne correspond à AUCUNE option reconnue par les versions
 * actuelles de morss : elle retombait donc sur le pipeline flux RSS normal,
 * qui rejetait la page avec "Link provided is not a valid feed" — repéré en
 * usage réel sur korben.info : le repli morss semblait "aussi bloqué" alors
 * qu'il s'agissait en fait d'une syntaxe d'URL périmée, sans lien avec le
 * VPN. Best-effort malgré tout : si morss répond autre chose qu'un vrai
 * article (échec, page de blocage...), Readability ne trouvera simplement
 * rien d'exploitable et on retombe sur le message d'erreur habituel.
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
          "User-Agent": BROWSER_USER_AGENT,
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
  const morssUrl = `${morssBaseUrl}/:get=page/${strippedUrl}`;
  const viaMorss = await attempt(morssUrl, 12000);
  if (viaMorss && "html" in viaMorss) return viaMorss;

  return direct; // les deux ont échoué : on renvoie l'erreur de la tentative directe (plus parlante)
}

/**
 * Traduction PROGRESSIVE d'un article ouvert (en flux). Le navigateur envoie la
 * liste des textes de blocs extraits du DOM déjà affiché (chaque bloc porte
 * data-tr-block, posé par tagTranslatableBlocks — voir le script client dans
 * renderPage) ; on renvoie EN FLUX, une ligne JSON par bloc dès qu'il est prêt
 * ({i, ok, text}), de sorte que la page fasse basculer les blocs en français
 * l'un après l'autre sans se recharger, avec une barre qui se remplit. La ligne
 * finale {done:true} clôt le flux. Mêmes garde-fous que le rendu serveur non
 * progressif (translateContentHtml) : timeout court par bloc, budget global,
 * abandon rapide si le moteur ne répond plus — pour ne jamais laisser la page
 * tourner indéfiniment.
 */
export async function POST(req: NextRequest): Promise<Response> {
  let payload: unknown = null;
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "corps JSON invalide" }, { status: 400 });
  }
  const rawTexts: unknown = (payload as { texts?: unknown } | null)?.texts;
  if (!Array.isArray(rawTexts)) {
    return NextResponse.json({ error: "texts[] requis" }, { status: 400 });
  }
  const texts = rawTexts.slice(0, MAX_STREAM_STRINGS).map((t) => (typeof t === "string" ? t : ""));

  const { libretranslateUrl, libretranslateApiKey } = await getSettings();
  const blockOpts: TranslateOptions = {
    libretranslateUrl,
    libretranslateApiKey,
    timeoutMs: ARTICLE_PER_BLOCK_TIMEOUT_MS
  };

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) => controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      // Pas d'instance configurée : rien à traduire, on le signale et on ferme.
      if (!libretranslateUrl) {
        send({ done: true, reason: "no-engine" });
        controller.close();
        return;
      }
      const batchOpts: TranslateOptions = { ...blockOpts, timeoutMs: STREAM_BATCH_TIMEOUT_MS };
      const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

      // Découpage en lots, bornés à la fois en nombre de textes et en volume de
      // caractères. Les textes vides sont réglés tout de suite : le client
      // attend une réponse pour CHAQUE index avant de réécrire un bloc, donc en
      // oublier un le laisserait en attente pour toujours.
      const batches: number[][] = [];
      let current: number[] = [];
      let currentChars = 0;
      for (let i = 0; i < texts.length; i++) {
        const original = texts[i].trim();
        if (!original) {
          send({ i, ok: false });
          continue;
        }
        if (
          current.length > 0 &&
          (current.length >= STREAM_BATCH_MAX_ITEMS || currentChars + original.length > STREAM_BATCH_MAX_CHARS)
        ) {
          batches.push(current);
          current = [];
          currentChars = 0;
        }
        current.push(i);
        currentChars += original.length;
      }
      if (current.length > 0) batches.push(current);

      const deadline = Date.now() + ARTICLE_STREAM_BUDGET_MS;
      let consecutiveFailures = 0;
      // Passe à false si l'on constate que l'instance refuse les requêtes
      // groupées mais répond bien texte par texte — on finit alors l'article
      // dans ce mode plutôt que de réessayer un groupage voué à l'échec.
      let batchSupported = true;

      // Traduit les textes d'un lot un par un et renvoie true si au moins un a
      // abouti (sert à savoir si le moteur répond encore).
      const sendOneByOne = async (indices: number[]): Promise<boolean> => {
        let anyOk = false;
        for (const i of indices) {
          const translated = await translateOrNull(texts[i].trim(), blockOpts);
          if (translated !== null) {
            send({ i, ok: true, text: translated });
            anyOk = true;
          } else {
            send({ i, ok: false });
          }
        }
        return anyOk;
      };

      for (const batch of batches) {
        // Budget global épuisé, ou moteur visiblement indisponible : on clôt le
        // flux tout de suite, le client garde la langue d'origine pour le reste.
        if (Date.now() >= deadline || consecutiveFailures >= ARTICLE_MAX_CONSECUTIVE_FAILURES) {
          send({ done: true, reason: "budget" });
          controller.close();
          return;
        }

        if (!batchSupported) {
          consecutiveFailures = (await sendOneByOne(batch)) ? 0 : consecutiveFailures + 1;
          continue;
        }

        const payload = batch.map((i) => texts[i].trim());
        let out = await translateBatchOrNull(payload, batchOpts);
        if (out === null) {
          // Une hésitation du moteur (surcharge passagère, conteneur qui
          // redémarre) ne doit pas condamner tout l'article : on le laisse
          // respirer et on retente le lot une fois.
          await pause(STREAM_RETRY_PAUSE_MS);
          out = await translateBatchOrNull(payload, batchOpts);
        }

        if (out === null) {
          // Le lot ne passe décidément pas. Un seul texte témoin permet de
          // distinguer les deux causes possibles : moteur réellement muet, ou
          // instance qui répond mais ne gère pas les tableaux.
          const probe = await translateOrNull(payload[0], blockOpts);
          if (probe === null) {
            for (const i of batch) send({ i, ok: false });
            consecutiveFailures++;
          } else {
            batchSupported = false;
            send({ i: batch[0], ok: true, text: probe });
            await sendOneByOne(batch.slice(1));
            consecutiveFailures = 0;
          }
          continue;
        }

        let anyOk = false;
        for (let k = 0; k < batch.length; k++) {
          const translated = out[k];
          if (translated !== null) {
            send({ i: batch[k], ok: true, text: translated });
            anyOk = true;
          } else {
            send({ i: batch[k], ok: false });
          }
        }
        consecutiveFailures = anyOk ? 0 : consecutiveFailures + 1;
      }
      send({ done: true });
      controller.close();
    }
  });

  return new NextResponse(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-store",
      // Désactive le buffering d'un éventuel reverse-proxy (nginx/traefik) pour
      // que le flux arrive réellement bloc par bloc, et non d'un coup à la fin.
      "X-Accel-Buffering": "no"
    }
  });
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("URL manquante", { status: 400 });

  // Thème actif, lu UNE FOIS et transmis à tous les rendus de cette requête
  // (y compris les pages d'erreur et de repli) : cette page étant du HTML
  // autonome servi en iframe, elle n'hérite de rien et doit s'habiller
  // elle-même. Best-effort — en cas de souci de base, on sert l'habillage
  // d'origine plutôt que de refuser d'afficher l'article.
  const accent = (await getSettings().catch(() => null))?.materialAccent ?? null;

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
  // sourceExcerpt (texte brut du flux RSS, jamais touché par l'IA) D'ABORD,
  // summary (réécriture Gemini, posée UNIQUEMENT quand une impression IA
  // tourne — voir generateEdition.ts, aiRewritten) seulement en dernier
  // recours. Avant ce correctif l'ordre était inversé : dès qu'une impression
  // IA passait sur l'article (même s'il avait été aspiré sans IA par "En
  // Direct" plus tôt dans la journée), ce repli de lecture affichait le
  // résumé Gemini à la place du texte original du flux — contraire à l'esprit
  // "En Direct" (zéro IA), repéré via le texte "Selon Korben, ..." qui
  // n'existe nulle part dans l'article source ni dans son flux RSS.
  const fallbackExcerpt = articleRecord?.sourceExcerpt?.trim() || articleRecord?.summary?.trim() || null;
  // sourceTitle (titre BRUT du flux, jamais touché par l'IA) D'ABORD, headline
  // (réécrit par Gemini quand une impression IA tourne) seulement en dernier
  // recours — même logique que fallbackExcerpt ci-dessus et que la vignette
  // "En direct" (voir directTitle dans EditionView) : la lecture d'un article
  // depuis "En direct" doit rester 100 % sans IA, titre compris. Le champ
  // sourceExcerpt affiché juste en dessous est lui aussi le texte brut du
  // flux, donc titre et corps restent cohérents (même langue, même source).
  const fallbackTitle = articleRecord?.sourceTitle?.trim() || articleRecord?.headline?.trim() || null;

  // Le message d'avertissement passe APRÈS le texte récupéré (pas avant) et
  // dans un encadré grisé sur toute la largeur de la zone de texte — même
  // esprit que les cases d'article de l'appli (bordure + fond gris clair),
  // pour bien le distinguer visuellement du texte de l'article lui-même.
  function excerptFallbackBodyHtml(notice: string): string {
    const noticeBox = `<div class="notice-box">${escapeHtml(notice)}</div>`;
    if (!fallbackExcerpt) return noticeBox;
    return `${excerptToParagraphsHtml(fallbackExcerpt)}${noticeBox}`;
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
        accent,
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
        <video id="reddit-video" controls preload="metadata" style="max-width:100%;"></video>
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
        accent,
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
    // sourceExcerpt tel que récupéré depuis le flux, sinon summary IA en
    // dernier recours — voir plus haut — sourceExcerpt est parfois déjà en
    // français : Reddit traduit lui-même
    // certains posts côté flux/Redlib, indépendamment de toute IA de notre
    // côté), on le sert directement plutôt que d'aller chercher le texte
    // ORIGINAL (souvent anglais) via Redlib/l'API JSON officielle plus bas :
    // cohérence avec la vignette avant tout — c'est exactement le même
    // texte qui y est affiché — plus besoin d'aller-retour réseau pour un
    // résultat qu'on a déjà en base.
    if (fallbackExcerpt) {
      return htmlResponse(
        renderPage({
          accent,
          title: fallbackTitle || "Post Reddit",
          siteName: "reddit.com",
          bodyHtml: `${excerptToParagraphsHtml(fallbackExcerpt)}<div class="notice-box">Texte tel que récupéré depuis le flux (même texte qu'en vignette). Pour le texte original et les commentaires, utilise « Voir l'original » en haut de page.</div>`,
          originalUrl,
          articleId,
          favorite
        })
      );
    }

    // 1) Miroir Redlib (best-effort, voir getRedlibInstances()) : rendu HTML
    //    complet côté serveur, passé par le même pipeline Readability que
    //    n'importe quel autre site.
    const redlib = await fetchViaRedlib(parsed);
    if (redlib) {
      const redlibDom = new JSDOM(redlib.html, { url: redlib.baseUrl });
      const redlibArticle = new Readability(redlibDom.window.document as unknown as Document).parse();
      if (redlibArticle && redlibArticle.content) {
        const contentDom = new JSDOM(`<div id="root">${redlibArticle.content}</div>`);
        rewriteContentImages(contentDom, redlib.baseUrl);
        openContentLinksInNewTab(contentDom, redlib.baseUrl);
        contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());
        const rootEl = contentDom.window.document.getElementById("root");
        if (rootEl) deepTrimJunk(rootEl);

        let finalTitle = redlibArticle.title || "Post Reddit";
        let finalBody = rootEl?.innerHTML || "";
        if (wantsTranslation) {
          const t = await translateArticle(finalTitle, finalBody);
          finalTitle = t.title;
          finalBody = t.bodyHtml;
        }

        return htmlResponse(
          renderPage({
            accent,
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
      openContentLinksInNewTab(contentDom, "https://www.reddit.com");
      let finalTitle = redditPost.title;
      let finalBody = contentDom.window.document.getElementById("root")?.innerHTML || "";
      if (wantsTranslation) {
        const t = await translateArticle(finalTitle, finalBody);
        finalTitle = t.title;
        finalBody = t.bodyHtml;
      }

      return htmlResponse(
        renderPage({
          accent,
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
        accent,
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
    const fetched = await fetchArticleHtml(fetchUrl, MORSS_BASE_URL);

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
            accent,
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
          accent,
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
          accent,
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
    openContentLinksInNewTab(contentDom, fetchUrl);
    contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());

    const rootEl = contentDom.window.document.getElementById("root");
    if (rootEl) {
      // AVANT deepTrimJunk (voir son commentaire de tête, articleClean.ts) :
      // élimine d'abord le chrome noyé sur plusieurs niveaux d'imbrication
      // si un <article> descendant se dégage clairement, puis deepTrimJunk
      // nettoie ce qui reste (byline dupliqué, encarts métadonnées
      // "Franchise :"/"Titre original :"..., "articles similaires" en fin
      // d'article), y compris quand tout ça est regroupé plusieurs niveaux
      // plus bas que root (gamekult.com, cnrs.fr/Le journal...).
      hoistNestedArticleIfClearlyBetter(rootEl);
      deepTrimJunk(rootEl);
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
        accent,
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
        accent,
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
