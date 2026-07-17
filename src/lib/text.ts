/**
 * FreshRSS's summary/content fields (and some feed titles) are raw HTML
 * straight from the source — paragraphs, links, whole embedded <table>/
 * <img> blocks, and sometimes that markup arrives HTML-entity-encoded
 * (&lt;span&gt;...) rather than literal. Some feeds also hand back content
 * pre-truncated by the publisher mid-tag (e.g. "...<a href=" with no
 * closing ">" at all) — decode + strip in a loop for well-formed tags,
 * then a final pass mops up any dangling, unclosed tag fragments so nothing
 * broken ever reaches the page.
 */
export function stripHtml(html: string): string {
  let text = html;

  for (let i = 0; i < 3; i++) {
    const before = text;
    text = text
      .replace(/&nbsp;/gi, " ")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#0?39;/gi, "'")
      .replace(/&amp;/gi, "&")
      .replace(/<(script|style|table)[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<[^>]+>/g, " ");
    if (text === before) break;
  }

  // Anything still starting with "<" or "</" at this point is a broken,
  // never-closed tag fragment (e.g. a source feed truncated its own
  // content mid-markup) — the well-formed-tag loop above can't match it
  // since there's no closing ">" to find. Strip through to the next "<"
  // (or end of string) rather than leave raw markup visible.
  text = text.replace(/<\/?[a-zA-Z][^<]*/g, " ");

  return text.replace(/\s+/g, " ").trim();
}

// Repères de "chrome" de page (barre d'infos, boutons, tags...) que certains
// flux — notamment enrichis via un proxy comme morss, qui aspire toute la
// page plutôt que le seul article — collent EN TÊTE du contenu, avant le
// vrai texte (ex. Korben : pub sponsorisée, titre répété, date, "PAR
// <auteur> / N MIN DE LECTURE", tags, "à lire plus tard", "Sauvegardé",
// "Catégories connexes ...", "Écouter cet article ~N min"). stripHtml()
// aplatit tout ça en un seul bloc de texte plat, donc ce chrome consomme
// tout le budget d'affichage des extraits (accueil, "En direct") sans
// qu'aucun vrai texte d'article n'apparaisse.
// Comparés à une version en minuscules du texte (voir stripLeadingChrome) —
// évite toute surprise avec le pliage de casse des lettres accentuées (É,
// À...) selon les moteurs regex, et permet d'écrire les repères simplement.
const LEADING_CHROME_MARKERS: RegExp[] = [
  /min(?:ute)?s?\s+de\s+lecture/,
  /[àa]\s+lire\s+plus\s+tard/,
  /cat[ée]gories?\s+connexes/,
  /[ée]couter\s+cet\s+article(?:\s*[~≈]?\s*\d+\s*min)?/
];
// On ne cherche que dans le tout début du texte : un repère qui apparaît
// plus loin a de bonnes chances d'être du vrai contenu (un article qui
// PARLE de temps de lecture, par exemple), pas du chrome de page.
const LEADING_CHROME_SEARCH_WINDOW = 2500;

/**
 * Coupe tout ce qui précède le DERNIER repère de chrome trouvé en tête du
 * texte (voir LEADING_CHROME_MARKERS) — le dernier, pas le premier, pour
 * passer d'un coup par-dessus tout le bloc (pub, byline, tags...) plutôt que
 * de ne couper qu'une partie. Renvoie le texte tel quel si aucun repère
 * n'est trouvé, plutôt que de risquer de couper du vrai contenu.
 */
export function stripLeadingChrome(text: string): string {
  const window = text.slice(0, LEADING_CHROME_SEARCH_WINDOW);
  const lowerWindow = window.toLowerCase();
  let cutAt = -1;
  for (const marker of LEADING_CHROME_MARKERS) {
    const match = lowerWindow.match(marker);
    if (match && match.index !== undefined) {
      const end = match.index + match[0].length;
      if (end > cutAt) cutAt = end;
    }
  }
  if (cutAt === -1) return text;
  return text.slice(cutAt).replace(/^[\s/·•\-–—~]+/, "").trim();
}

/** Heuristic: does this text still contain raw or entity-encoded markup that stripHtml should clean? */
export function looksLikeHtml(text: string | null | undefined): boolean {
  if (!text) return false;
  return /<\s*[a-z][a-z0-9]*[\s>/]/i.test(text) || /&lt;\s*[a-z]/i.test(text);
}

/**
 * Best-effort first <img> src found in raw (possibly entity-encoded) HTML —
 * decodes entities first for the same reason stripHtml does.
 */
export function extractFirstImageSrc(html: string | null | undefined): string | null {
  if (!html) return null;
  const decoded = html
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, "&");
  const match = decoded.match(/<img[^>]+src=["']([^"']+)["']/i);
  return match ? match[1] : null;
}
