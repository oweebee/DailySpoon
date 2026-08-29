/**
 * Choix du texte affiché/servi pour un article : la traduction française
 * quand elle existe, le texte brut du flux sinon.
 *
 * Un seul endroit pour cette règle, parce qu'elle s'applique désormais à
 * TROIS sorties qui n'ont rien à voir entre elles — la page "En direct"
 * (composants React), les notifications Telegram et l'API Google Reader
 * servie aux lecteurs RSS externes. Les voir diverger donnerait un article
 * en français dans l'application et en anglais dans Readrops pour le même
 * flux coché "traduction".
 *
 * Ce que ces champs SONT : le texte d'origine du flux, traduit tel quel et
 * mis en cache (voir TranslateFeed et syncTranslateFlags dans
 * generateEdition.ts). Ce ne sont PAS des résumés réécrits par l'IA — la
 * règle "En direct n'affiche jamais d'IA" reste donc respectée.
 *
 * Ce qu'ils ne touchent PAS : l'article ouvert (article-proxy) sert toujours
 * la langue d'origine, avec son propre bouton "Traduire" à la demande.
 *
 * Module sans aucune dépendance (ni React, ni Prisma) : il est importé aussi
 * bien par des composants client que par du code serveur.
 */

export type TranslatableArticle = {
  sourceTitle?: string | null;
  sourceExcerpt?: string | null;
  translatedTitle?: string | null;
  translatedExcerpt?: string | null;
};

/** Titre à afficher, sans repli générique : à l'appelant de décider quoi
 *  faire d'une chaîne vide (les contextes diffèrent — "(sans titre)" dans
 *  l'app, le nom du flux dans l'API Google Reader, qui refuse un titre vide). */
export function preferredTitle(a: TranslatableArticle): string {
  return (a.translatedTitle && a.translatedTitle.trim()) || (a.sourceTitle && a.sourceTitle.trim()) || "";
}

/** Extrait à afficher, même convention que preferredTitle. */
export function preferredExcerpt(a: TranslatableArticle): string {
  return (a.translatedExcerpt && a.translatedExcerpt.trim()) || (a.sourceExcerpt && a.sourceExcerpt.trim()) || "";
}
