"use client";

import { useState } from "react";
import { CategoryColumn } from "./CategoryColumn";
import type { ArticleLike } from "./EditionView";

export type CategoryEntry = {
  label: string;
  // null si cette catégorie n'a pas d'équivalent dans /admin/categories
  // (ex. rubrique éditoriale choisie librement par l'IA) — dans ce cas on
  // ne peut rien persister en base pour elle, le glisser-déposer est
  // simplement désactivé sur sa colonne.
  freshrssId: string | null;
  articles: ArticleLike[];
};

/**
 * Grille des colonnes de rubriques, avec réorganisation par glisser-déposer
 * directement sur le titre de chaque colonne (entre les deux filets
 * horizontaux) — pas de bouton ni de poignée visible. L'ordre est persisté
 * côté serveur (SelectedCategory.order) dès le dépôt, donc effectif sur
 * toutes les pages et conservé après redémarrage/redéploiement, comme dans
 * /admin/categories.
 */
export function CategoryGrid({
  initialCategories,
  clampSummary = false,
  showMedal = true,
  showDateStamp = true,
  showFavorite = true
}: {
  initialCategories: CategoryEntry[];
  /** Limite l'aperçu à 10 lignes (page "En direct") — pour lire la suite,
   *  on ouvre l'article via la photo ou le lien source. */
  clampSummary?: boolean;
  showMedal?: boolean;
  showDateStamp?: boolean;
  showFavorite?: boolean;
}) {
  const [categories, setCategories] = useState(initialCategories);
  const [draggedLabel, setDraggedLabel] = useState<string | null>(null);

  function handleDrop(targetLabel: string) {
    const dragged = draggedLabel;
    setDraggedLabel(null);
    if (!dragged || dragged === targetLabel) return;

    const fromIndex = categories.findIndex((c) => c.label === dragged);
    const toIndex = categories.findIndex((c) => c.label === targetLabel);
    if (fromIndex === -1 || toIndex === -1) return;

    const reordered = [...categories];
    const [moved] = reordered.splice(fromIndex, 1);
    reordered.splice(toIndex, 0, moved);
    setCategories(reordered);

    const freshrssIds = reordered.map((c) => c.freshrssId).filter((id): id is string => !!id);
    if (freshrssIds.length === 0) return;
    fetch("/api/admin/categories/reorder", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ freshrssIds })
    }).catch(() => {
      // Best-effort : en cas d'échec réseau, l'ordre reste tel quel côté
      // affichage mais ne sera pas retenu à la prochaine visite.
    });
  }

  return (
    <>
      {/* ——— Mobile : une rubrique par "page", swipe au doigt (scroll-snap
          natif, pas de librairie JS) — le glisser-déposer de réorganisation
          n'a pas de sens ici (conflit avec le swipe horizontal), donc pas de
          props draggable dans cette branche. Chaque page fait exactement
          100% de la largeur, sans gap : la colonne voisine ne doit jamais
          être visible pendant la lecture de l'actuelle. */}
      <div className="-mx-6 flex snap-x snap-mandatory overflow-x-auto md:hidden">
        {categories.map((cat) => (
          <div key={cat.label} className="w-full shrink-0 snap-center px-6">
            <CategoryColumn
              label={cat.label}
              articles={cat.articles}
              clampSummary={clampSummary}
              showMedal={showMedal}
              showDateStamp={showDateStamp}
              showFavorite={showFavorite}
              scrollExpand
            />
          </div>
        ))}
      </div>

      {/* ——— Desktop/tablette : grille classique inchangée, avec
          glisser-déposer sur le titre de chaque colonne. "Afficher plus
          d'articles" bascule ici en encart à défilement interne (hauteur
          figée) plutôt que de faire grandir la colonne — scrollExpand. */}
      <div className="hidden gap-x-0 gap-y-8 md:grid md:grid-cols-2 lg:grid-cols-4">
        {categories.map((cat) => (
          <CategoryColumn
            key={cat.label}
            label={cat.label}
            articles={cat.articles}
            draggable={!!cat.freshrssId}
            isDragging={draggedLabel === cat.label}
            onDragStart={() => setDraggedLabel(cat.label)}
            onDragEnd={() => setDraggedLabel(null)}
            onDropHere={() => handleDrop(cat.label)}
            clampSummary={clampSummary}
            showMedal={showMedal}
            showDateStamp={showDateStamp}
            showFavorite={showFavorite}
            scrollExpand
          />
        ))}
      </div>
    </>
  );
}
