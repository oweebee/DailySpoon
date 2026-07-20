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
  /[ée]couter\s+cet\s+article(?:\s*[~≈]?\s*\d+\s*min)?/,
  // Gamekult (et probablement d'autres sites au même gabarit de page) :
  // bannière de soutien ("Soutenez Gamekult et découvrez tous nos contenus
  // sans publicité"), suivie de la liste des plateformes puis du menu
  // complet ("Menu Recherche Abonnés L'actualité Accueil News") puis d'un
  // fil d'ariane qui RÉPÈTE le titre de l'article avant un tag "news" — vu
  // en usage réel, tout ce bloc arrivait collé en tête du vrai texte. Le
  // ".+?" entre "News" et le "news" suivant avale ce titre répété quel qu'il
  // soit, sans avoir besoin de le connaître à l'avance.
  /soutenez\s+\S+\s+et\s+d[ée]couvrez\s+tous\s+nos\s+contenus/,
  /menu\s+recherche\s+abonn[ée]s\s+l['’]actualit[ée]\s+accueil\s+news\s+.+?\s+news\b/
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

/** Une URL d'image extraite est-elle un vrai fichier, ou juste un
 *  bouche-trou de lazy-load ? Beaucoup de thèmes WordPress mettent un
 *  placeholder dans src= (data: URI d'un SVG gris, GIF transparent 1x1,
 *  "blank.gif"/"spacer.gif", parfois une image en base64) et la VRAIE URL
 *  dans data-src/data-lazy-src/srcset. Sans ce test, on retenait le
 *  placeholder comme "image trouvée" : miniature vide à l'écran ET repli
 *  og:image jamais déclenché (puisqu'une image avait "été trouvée") — vu en
 *  usage réel sur le flux Korben. */
export function isPlaceholderImage(url: string): boolean {
  const u = url.trim().toLowerCase();
  if (!u) return true;
  if (u.startsWith("data:")) return true;
  return /(?:^|\/)(?:blank|spacer|placeholder|transparent|lazy|loader|grey|gray)[-_.]?\d*\.(?:gif|png|svg)/.test(u);
}

/**
 * Best-effort first <img> found in raw (possibly entity-encoded) HTML —
 * decodes entities first for the same reason stripHtml does.
 *
 * Ne se contente PAS du premier src= : passe en revue chaque <img> et, pour
 * chacun, teste les attributs susceptibles de porter la vraie URL
 * (data-src/data-lazy-src/data-original/srcset avant src, car en lazy-load
 * c'est src qui contient le bouche-trou). Renvoie la première URL réellement
 * exploitable, ou null si le contenu n'a que des placeholders — auquel cas
 * l'appelant peut enchaîner sur son repli og:image, ce qui n'arrivait jamais
 * avant (voir isPlaceholderImage ci-dessus).
 */
export function extractFirstImageSrc(html: string | null | undefined): string | null {
  if (!html) return null;
  const decoded = html
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&amp;/gi, "&");

  const imgTags = decoded.match(/<img[^>]*>/gi);
  if (!imgTags) return null;

  // srcset en dernier recours : sa syntaxe est "url1 480w, url2 800w", donc
  // on n'en garde que la première URL (avant l'espace/la virgule).
  const attrs = ["data-src", "data-lazy-src", "data-original", "data-srcset", "srcset", "src"];

  for (const tag of imgTags) {
    for (const attr of attrs) {
      const m = tag.match(new RegExp(`\\b${attr}=["']([^"']+)["']`, "i"));
      if (!m) continue;
      const raw = m[1].trim();
      const url = (attr.includes("srcset") ? raw.split(",")[0].trim().split(/\s+/)[0] : raw).trim();
      if (url && !isPlaceholderImage(url)) return url;
    }
  }
  return null;
}

/**
 * Est-ce que cette URL passe déjà PAR l'instance morss configurée ?
 * Utilisé partout où on envisage un repli via morss après un échec direct
 * (flux persos, article-proxy) : si l'URL en échec est déjà une URL morss,
 * l'échec vient de morss lui-même — la relayer une seconde fois via morss
 * referait exactement la même requête qui vient d'échouer (attente d'un
 * second timeout pour rien, aucune chance de succès différent). Comparaison
 * par hostname (pas juste startsWith) pour rester correcte que morssBaseUrl
 * soit noté avec ou sans "https://", avec ou sans slash final.
 */
export function isAlreadyMorssUrl(url: string, morssBaseUrl: string | null | undefined): boolean {
  if (!morssBaseUrl) return false;
  try {
    const morssHost = new URL(
      morssBaseUrl.startsWith("http") ? morssBaseUrl : `https://${morssBaseUrl}`
    ).hostname;
    const urlHost = new URL(url).hostname;
    return urlHost === morssHost;
  } catch {
    // URL(s) mal formées : repli sur une comparaison texte simple plutôt que
    // de planter — mieux vaut un faux négatif (tente le repli morss pour
    // rien) qu'une exception qui casserait tout l'import du flux.
    const strippedBase = morssBaseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "");
    return strippedBase.length > 0 && url.includes(strippedBase);
  }
}
