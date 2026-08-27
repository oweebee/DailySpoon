import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { prisma } from "@/lib/prisma";
import { MORSS_BASE_URL, getSettings, type ThemeName } from "@/lib/settings";
import { getRedlibInstances, isRedditHostname, isRedditImageHostname, isRedditVideoHostname } from "@/lib/reddit";
import { isAlreadyMorssUrl, splitIntoReadableParagraphs, BROWSER_USER_AGENT } from "@/lib/text";
import { isForbiddenProxyTarget } from "@/lib/urlGuard";
import { hoistNestedArticleIfClearlyBetter, deepTrimJunk } from "@/lib/articleClean";
import { translateBestEffort, type TranslateOptions } from "@/lib/translate";

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

/**
 * Habillage sombre du lecteur d'article, ajouté EN FIN de feuille de style
 * (donc prioritaire à spécificité égale) quand le thème Material est actif.
 * Écrit en surcharge plutôt qu'en variables : cette page est du HTML autonome
 * et figé, servi en iframe hors du CSS de l'application — dupliquer ici tout
 * le système de thèmes de globals.css pour un seul autre thème coûterait plus
 * cher que ces quelques règles.
 *
 * Le fleuron en cuillères et les photos d'article restent intacts : seule
 * l'illusion "vieux papier" (grain, vignette, empattements, lettrine) est
 * retirée.
 */
const MATERIAL_READER_CSS = `
  html { background: #121212; }
  body {
    background-color: #121212;
    background-image: none;
    color: #e2e2e2;
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  h1, .kicker, .article-body h2, .article-body h3 {
    font-family: "Inter", system-ui, -apple-system, "Segoe UI", Helvetica, Arial, sans-serif;
  }
  /* Même rouge unique que le reste de l'application en thème Material (voir
     --color-journal dans globals.css) : cette page étant du HTML autonome,
     la valeur doit y être recopiée en dur — elle n'a accès à aucune variable
     de l'app. À garder synchronisée si le rouge du thème change. */
  .kicker, .meta-top a, .article-body a, .fav-star.is-fav { color: #d64040; }
  .meta-top { color: #969696; border-bottom-color: #3c3c3c; }
  .byline, .source-bottom, .fav-star, .embed-note, .article-body figcaption { color: #969696; }
  .double-rule { border-top: 1px solid #3c3c3c; border-bottom: none; }
  /* Lettrine retirée : ornement de presse papier, incongru en monospace. */
  .article-body > p:first-of-type::first-letter {
    float: none; font-size: inherit; font-weight: inherit; line-height: inherit; padding: 0; color: inherit;
  }
  /* Texte au fil de l'eau plutôt que justifié avec césures : la justification
     sert à imiter une colonne de presse, elle creuse des rivières blanches
     dans une monospace. */
  .article-body { text-align: left; hyphens: none; }
  .article-body img, .article-body picture { border-color: #3c3c3c; box-shadow: none; }
  .article-body blockquote { border-left-color: #3c3c3c; color: #c8c8c8; }
  .notice-box { border-color: #3c3c3c; background: rgba(255, 255, 255, 0.06); color: #c8c8c8; }
  /* Le timbre-poste redevient un bouton, comme dans le reste de l'app. */
  .stamp-link {
    background-image: none;
    aspect-ratio: auto;
    padding: 0.5rem 1rem;
    border: 1px solid #3c3c3c;
    border-radius: 0.25rem;
    background-color: rgba(255, 255, 255, 0.08);
    color: #e2e2e2;
    transform: none;
    filter: none;
    text-shadow: none;
  }
  .stamp-link:hover { transform: none; filter: none; background-color: rgba(255, 255, 255, 0.14); }
  .translate-progress { background: #e2e2e2; }
`;

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
  /** Thème actif (voir Settings.theme). Cette page est du HTML autonome,
   *  servi dans une iframe et donc TOTALEMENT hors du CSS de l'application :
   *  elle ne peut pas hériter des variables de globals.css et doit porter son
   *  propre habillage. Sans ça, ouvrir un article en thème sombre projetait
   *  une page blanche en pleine figure. */
  theme?: ThemeName;
}): string {
  const { title, byline, siteName, bodyHtml, originalUrl, showTranslateLink, translated, articleId, favorite, embedFallback, theme } =
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
  // serveur complet avec le contenu traduit via l'instance LibreTranslate
  // auto-hébergée (best-effort — cf. translateArticle plus bas : si elle est
  // injoignable, le texte d'origine est réaffiché tel quel).
  const translateHref = `/api/article-proxy?url=${encodeURIComponent(originalUrl)}${translated ? "" : "&translate=1"}`;
  const translateLabel = translated ? "Texte original ↺" : "Traduire en français ⇄";
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..900;1,400..900&family=Inter:ital,wght@0,300..800;1,300..800&display=swap" rel="stylesheet" />
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
  /* Barre de progression noire en haut de page, affichée le temps du
     rechargement complet déclenché par le lien "Traduire en français" — la
     traduction (jusqu'à 60 blocs, appels séquentiels à l'API Google
     Translate côté serveur, voir translateContentHtml) peut prendre
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
    background: #1a1a1a;
    z-index: 1000;
    opacity: 0;
    pointer-events: none;
  }
  .translate-progress.is-active {
    opacity: 1;
    animation: translate-progress-slide 1.1s ease-in-out infinite;
  }
  @keyframes translate-progress-slide {
    0% { margin-left: -40%; }
    100% { margin-left: 100%; }
  }
${theme === "material" ? MATERIAL_READER_CSS : ""}
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
  <script>
(function () {
  // Affiche la barre de progression noire dès le clic sur "Traduire en
  // français ⇄" / "Texte original ↺" — le navigateur continue de peindre
  // cette page (et donc la barre) pendant qu'il prépare la navigation vers
  // la version traduite/originale, avant de la remplacer une fois arrivée.
  // Pas de preventDefault : la navigation classique du lien <a> suit son
  // cours normalement, on ajoute juste ce signal visuel avant qu'elle parte.
  var link = document.getElementById("translate-link");
  var bar = document.getElementById("translate-progress");
  if (link && bar) {
    link.addEventListener("click", function () {
      bar.classList.add("is-active");
    });
  }
  // Si l'utilisateur revient en arrière (bfcache) sur cette page pendant
  // qu'elle était affichée "en cours de traduction", la barre resterait
  // sinon figée active indéfiniment.
  window.addEventListener("pageshow", function () {
    if (bar) bar.classList.remove("is-active");
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

async function translateContentHtml(html: string, opts: TranslateOptions): Promise<string> {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return html;
  const blocks = Array.from(root.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, figcaption")).slice(
    0,
    MAX_BLOCKS_TO_TRANSLATE
  );
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
    el.textContent = await translateBestEffort(original, opts);
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
    translateBestEffort(title, opts),
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

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("URL manquante", { status: 400 });

  // Thème actif, lu UNE FOIS et transmis à tous les rendus de cette requête
  // (y compris les pages d'erreur et de repli) : cette page étant du HTML
  // autonome servi en iframe, elle n'hérite de rien et doit s'habiller
  // elle-même. Best-effort — en cas de souci de base, on sert l'habillage
  // d'origine plutôt que de refuser d'afficher l'article.
  const theme: ThemeName = await getSettings()
    .then((s) => s.theme)
    .catch(() => "dailyspoon" as const);

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
        theme,
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
        theme,
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
          theme,
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
            theme,
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
          theme,
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
        theme,
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
            theme,
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
          theme,
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
          theme,
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
        theme,
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
        theme,
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
