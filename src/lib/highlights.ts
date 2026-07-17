// 3 traces de surligneur (voir public/highlights), réutilisées à la fois
// pour le fond des titres de rubrique (CategoryColumn, teinte rouge
// d'origine des fichiers) et pour le bandeau "À la une" (EditionView, même
// jeu d'images mais teinté en noir via un filtre CSS brightness-0) — fichier
// neutre partagé pour éviter un import circulaire entre ces deux composants
// (qui s'importent déjà mutuellement pour SourceLine/formatStamp/ArticleLike).
export const CATEGORY_HIGHLIGHTS = [
  "/highlights/highlight-1.png",
  "/highlights/highlight-2.png",
  "/highlights/highlight-3.png"
];
