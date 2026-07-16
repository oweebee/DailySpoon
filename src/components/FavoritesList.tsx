"use client";

import { useState } from "react";
import { ArticleLink } from "./ArticleLink";
import { FavoriteStar } from "./FavoriteStar";
import { formatPublished } from "./EditionView";

export type FavoriteArticle = {
  id: string;
  headline: string | null;
  sourceTitle: string;
  sourceUrl: string;
  feedTitle: string;
  favoritedAt: Date | string | null;
};

/**
 * Liste des articles favoris : titres seuls, sans photo. Un clic sur le
 * titre ouvre l'article (fenêtre interne). L'étoile permet de retirer le
 * favori directement depuis la liste, sans recharger la page.
 */
export function FavoritesList({ articles }: { articles: FavoriteArticle[] }) {
  const [items, setItems] = useState(articles);

  if (items.length === 0) {
    return (
      <p className="py-24 text-center italic text-sepia">
        Aucun favori pour l’instant. Clique sur l’étoile à côté d’un article pour l’ajouter ici.
      </p>
    );
  }

  return (
    <ul className="border-t-2 border-ink">
      {items.map((article) => (
        <li key={article.id} className="flex items-center justify-between gap-4 border-b border-ink/30 py-3">
          <div>
            <ArticleLink
              href={article.sourceUrl}
              title={article.headline || article.sourceTitle}
              className="font-display font-bold hover:underline"
            >
              {article.headline || article.sourceTitle}
            </ArticleLink>
            {formatPublished(article.favoritedAt) && (
              <p className="mt-0.5 text-xs italic text-sepia">
                Ajouté aux favoris le {formatPublished(article.favoritedAt)}
              </p>
            )}
          </div>
          <FavoriteStar
            articleId={article.id}
            initialFavorite={true}
            onToggle={(next) => {
              if (!next) setItems((prev) => prev.filter((a) => a.id !== article.id));
            }}
          />
        </li>
      ))}
    </ul>
  );
}
