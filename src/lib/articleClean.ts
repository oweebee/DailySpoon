// Nettoyage du "chrome" (bandeaux, menus, CTA newsletter, résumés IA en tête
// de page...) qu'un article extrait via Readability peut encore contenir.
// Historiquement défini directement dans /api/article-proxy (modale de
// lecture) ; factorisé ici pour être réutilisé AUSSI par l'envoi Wallabag
// (src/lib/wallabagSend.ts), qui en avait besoin tout autant — sans ce
// nettoyage, le contenu envoyé à Wallabag arrivait avec tout le chrome
// mélangé au texte réel en un seul bloc (résumé "Ce qu'il faut retenir" +
// disclaimer IA de korben.info, bandeau newsletter en fin d'article...).

// Les apostrophes ' et ' (courbe) sont interchangeables selon le site source
// (voire selon l'encodeur HTML utilisé), mais toutes les listes de phrases
// ci-dessous n'écrivent qu'UNE seule forme — sans normalisation, une phrase
// comme "écran d'accueil" (apostrophe droite dans la liste) ne matchait pas
// "écran d'accueil" (apostrophe courbe sur le site réel), et la détection de
// contenu/chrome échouait silencieusement.
export function normalizeApostrophes(text: string): string {
  return text.replace(/[''']/g, "'");
}

// Beaucoup de sites glissent, après le vrai texte de l'article mais toujours
// à l'intérieur du bloc que Readability extrait, un rebus de fin d'article :
// pub pour l'appli mobile, bandeau newsletter, liste "à lire aussi" — pas du
// contenu de l'article. On repère le dernier paragraphe qui ressemble à du
// vrai texte, et on supprime tout ce qui vient après.
export const TRAILING_JUNK_PHRASES = [
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
  "suivez-nous",
  "pour ne manquer aucune actualité",
  "rejoignez-nous sur",
  "retrouvez-nous sur",
  "google actualités",
  "google news",
  "notre chaîne whatsapp",
  "sur whatsapp",
  "soutenez",
  "sans publicité",
  "découvrez tous nos contenus",
  "un édito exclusif",
  "l'agenda de la rédaction",
  "toujoursplus"
];

// Un "vrai" paragraphe peut être un <p> classique ou un <blockquote> (souvent
// utilisé par les CMS pour encadrer un bandeau "suivez-nous" plutôt qu'une
// vraie citation) — les deux sont évalués pareil.
export function isSubstantiveParagraph(el: Element): boolean {
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

// trimLeadingJunk/trimTrailingJunk ne regardent que les enfants DIRECTS de
// root — mais certains sites enveloppent CHAQUE paragraphe réel dans son
// propre <div> plutôt que de le poser à plat comme enfant direct. Ce repli
// élargit la détection : un enfant compte comme "réel" s'il EST un paragraphe
// substantiel OU s'il en CONTIENT un (recherche récursive).
export function containsSubstantiveParagraph(el: Element): boolean {
  if (el.tagName === "P" || el.tagName === "BLOCKQUOTE") return isSubstantiveParagraph(el);
  return Array.from(el.querySelectorAll("p, blockquote")).some((p) => isSubstantiveParagraph(p));
}

// Titres qui annoncent quasi-systématiquement une section "articles
// similaires/récents" en toute fin de page.
export const RELATED_POSTS_HEADING_PHRASES = [
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
  "ça vous a intéressé"
];

export function isRelatedPostsHeading(el: Element): boolean {
  const text = normalizeApostrophes((el.textContent || "").trim().toLowerCase());
  const isHeadingTag = /^H[1-4]$/.test(el.tagName);
  const isShortParagraph = el.tagName === "P" && text.length < 80;
  if (!isHeadingTag && !isShortParagraph) return false;
  return RELATED_POSTS_HEADING_PHRASES.some((p) => text.includes(p));
}

/** Coupe le contenu juste après le dernier paragraphe "réel" — ou dès un
 *  titre de type "Articles récents"/"À lire aussi" si celui-ci apparaît
 *  plus tôt. Tout ce qui suit le point de coupe retenu (photo, liste de
 *  liens, bandeau newsletter, articles suggérés...) est retiré. */
export function trimTrailingJunk(root: Element): void {
  const children = Array.from(root.children);
  let lastRealIdx = -1;
  let firstRelatedHeadingIdx = -1;
  children.forEach((el, i) => {
    if (containsSubstantiveParagraph(el)) lastRealIdx = i;
    if (firstRelatedHeadingIdx === -1 && isRelatedPostsHeading(el)) firstRelatedHeadingIdx = i;
  });

  if (lastRealIdx === -1 && firstRelatedHeadingIdx === -1) return;

  let cutFrom = lastRealIdx + 1;
  if (firstRelatedHeadingIdx !== -1) {
    cutFrom = lastRealIdx === -1 ? firstRelatedHeadingIdx : Math.min(cutFrom, firstRelatedHeadingIdx);
  }
  if (cutFrom >= children.length) return;

  for (let i = children.length - 1; i >= cutFrom; i--) {
    children[i].remove();
  }
}

// Chrome de tête reconnu par correspondance EXACTE du texte de l'élément
// (menus, fils d'ariane...).
export const LEADING_JUNK_EXACT_PHRASES = [
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

// Chrome de tête reconnu par correspondance PARTIELLE (contains) — pour des
// blocs plus longs et variables qu'un simple libellé de menu. Ajouté pour les
// encarts "résumé généré par IA" de korben.info (bloc "Ce qu'il faut
// retenir" + puces + disclaimer liens affiliés), observés collés en tête du
// contenu extrait, avant le vrai texte de l'article, et jamais reconnus par
// LEADING_JUNK_EXACT_PHRASES (correspondance stricte).
export const LEADING_JUNK_INCLUDES_PHRASES = [
  "ce qu'il faut retenir",
  "résumé généré par ia",
  "resume genere par ia",
  "contient des liens affiliés"
];

export function isLeadingJunkElement(el: Element): boolean {
  if (el.tagName === "UL" || el.tagName === "OL" || el.tagName === "NAV") return true;
  const text = normalizeApostrophes((el.textContent || "").trim().toLowerCase());
  if (LEADING_JUNK_EXACT_PHRASES.includes(text)) return true;
  return LEADING_JUNK_INCLUDES_PHRASES.some((p) => text.includes(p));
}

const MIN_HOISTED_ARTICLE_TEXT_LENGTH = 200;

export function substantiveTextLength(el: Element): number {
  let total = 0;
  el.querySelectorAll("p, blockquote").forEach((p) => {
    if (isSubstantiveParagraph(p)) total += (p.textContent || "").trim().length;
  });
  return total;
}

/** Un <article> DESCENDANT (pas root lui-même) est une convention HTML5
 *  sémantique fiable pour "voici le vrai contenu" — s'il en existe un
 *  contenant une quantité substantielle de texte, on hisse directement SON
 *  contenu à la place de celui de root, ce qui élimine d'un coup tout le
 *  chrome qui l'entoure, quelle que soit sa profondeur d'imbrication. */
export function hoistNestedArticleIfClearlyBetter(root: Element): void {
  const candidates = Array.from(root.querySelectorAll("article")).filter((el) => el !== root);
  if (candidates.length === 0) return;

  let best: Element | null = null;
  let bestLen = 0;
  for (const el of candidates) {
    const len = substantiveTextLength(el);
    if (len > bestLen) {
      best = el;
      bestLen = len;
    }
  }
  if (!best || bestLen < MIN_HOISTED_ARTICLE_TEXT_LENGTH) return;

  const rootLen = substantiveTextLength(root);
  if (bestLen >= rootLen - 10) return;

  root.innerHTML = best.innerHTML;
}

/** Symétrique de trimTrailingJunk, mais en tête d'article. */
export function trimLeadingJunk(root: Element): void {
  const children = Array.from(root.children);
  let firstRealIdx = -1;
  for (let i = 0; i < children.length; i++) {
    if (containsSubstantiveParagraph(children[i])) {
      firstRealIdx = i;
      break;
    }
  }
  if (firstRealIdx <= 0) return;

  const before = children.slice(0, firstRealIdx);
  if (!before.some((el) => isLeadingJunkElement(el))) return;

  // Garde la dernière image/figure juste avant le texte réel : presque
  // toujours la photo d'illustration de l'article, pas du chrome.
  let cutTo = firstRealIdx;
  const prev = children[cutTo - 1];
  if (prev && /^(IMG|FIGURE|PICTURE)$/.test(prev.tagName)) cutTo -= 1;

  for (let i = cutTo - 1; i >= 0; i--) {
    children[i].remove();
  }
}

/** Applique le nettoyage complet, dans l'ordre éprouvé par /api/article-proxy :
 *  hissage d'un <article> imbriqué mieux fourni, puis retrait du chrome de
 *  fin, puis de tête. Mute `root` en place. */
export function cleanExtractedArticle(root: Element): void {
  hoistNestedArticleIfClearlyBetter(root);
  trimTrailingJunk(root);
  trimLeadingJunk(root);
}
