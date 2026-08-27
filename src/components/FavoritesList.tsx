"use client";

import { useMemo, useState } from "react";
import { ArticleLink } from "./ArticleLink";
import { FavoriteStar } from "./FavoriteStar";
import { WesternMagnifier } from "./WesternMagnifier";
import { formatPublished, directHref } from "./EditionView";

export type FavoriteArticle = {
  id: string;
  headline: string | null;
  sourceTitle: string;
  sourceUrl: string;
  feedTitle: string;
  favoritedAt: Date | string | null;
};

/** Minuscules et accents retirés, pour que "eleves" trouve "élevés" et
 *  inversement — taper les accents sur un clavier de téléphone est pénible,
 *  et un filtre qui les exige donne l'impression de ne rien trouver. */
function normalize(s: string): string {
  return s
    .normalize("NFD")
    // Plage échappée (et non les caractères combinants en littéral) : ces
    // signes diacritiques sont invisibles dans un éditeur et se perdent au
    // moindre souci d'encodage de fichier. Même écriture que stripAccents
    // dans /api/articles/search.
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Liste des articles favoris : titres seuls, sans photo. Un clic sur le
 * titre ouvre l'article (fenêtre interne). L'étoile permet de retirer le
 * favori directement depuis la liste, sans recharger la page.
 *
 * Le filtre par mot-clé travaille EN LOCAL, sur la liste déjà chargée : les
 * favoris tiennent en mémoire (on n'en garde jamais des milliers), donc
 * aucune raison d'aller interroger le serveur à chaque frappe comme le fait
 * la recherche de "En direct", qui fouille elle tout l'historique.
 * Conséquence agréable : le filtrage est instantané, sans temporisation.
 */
export function FavoritesList({ articles }: { articles: FavoriteArticle[] }) {
  const [items, setItems] = useState(articles);
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = normalize(query.trim());
    if (!q) return items;
    // Recherche sur le titre ET le nom du flux : on se souvient souvent d'un
    // favori par sa source ("le truc de Korben") plutôt que par son titre
    // exact.
    return items.filter((a) =>
      normalize(`${a.headline || ""} ${a.sourceTitle} ${a.feedTitle}`).includes(q)
    );
  }, [items, query]);

  if (items.length === 0) {
    return (
      <p className="py-24 text-center italic text-sepia">
        Aucun favori pour l’instant. Clique sur l’étoile à côté d’un article pour l’ajouter ici.
      </p>
    );
  }

  return (
    <div>
      {/* Même présentation que le champ de recherche de "En direct" (loupe +
          simple filet sous le texte) : c'est le même geste, il doit avoir la
          même apparence d'une page à l'autre. */}
      <div className="mb-4 flex items-center justify-between gap-3">
        <span className="text-xs italic text-sepia">
          {filtered.length}
          {filtered.length !== items.length && ` sur ${items.length}`} favori
          {(filtered.length > 1 || (filtered.length === 0 && items.length > 1)) && "s"}
        </span>
        <label className="flex items-center gap-2 border-b border-ink/40 pb-1 focus-within:border-journal">
          <WesternMagnifier className="h-4 w-4 shrink-0 text-ink/70" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filtrer par mot-clé…"
            className="w-36 bg-transparent text-sm italic text-ink placeholder:text-sepia/70 focus:outline-none sm:w-56"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <p className="border-t-2 border-ink py-16 text-center italic text-sepia">
          Aucun favori ne correspond à « {query.trim()} ».
        </p>
      ) : (
        <ul className="border-t-2 border-ink">
          {filtered.map((article) => (
            <li key={article.id} className="flex items-center justify-between gap-4 border-b border-ink/30 py-3">
              <div>
                <ArticleLink
                  href={directHref(article)}
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
                // Retire l'article de la liste COMPLÈTE (items), pas de la
                // liste filtrée : sinon il réapparaîtrait dès qu'on efface le
                // filtre, alors qu'il n'est plus en favori.
                onToggle={(next) => {
                  if (!next) setItems((prev) => prev.filter((a) => a.id !== article.id));
                }}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
