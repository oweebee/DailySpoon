"use client";

import { useState } from "react";
import { CategoryColumn } from "./CategoryColumn";
import { MobilePagedSection } from "./MobilePagedSection";
import type { ArticleLike } from "./EditionView";

/**
 * Répartit "items" en "columns" piles indépendantes, round-robin (item 0 ->
 * colonne 0, item 1 -> colonne 1, ..., item "columns" -> colonne 0...) — la
 * même position qu'une grille CSS row-major classique à "columns" colonnes,
 * mais SANS le défaut d'une grille : ici chaque colonne est un simple bloc
 * empilé (flex-col) dont la hauteur ne dépend que de SON PROPRE contenu, pas
 * de celui de ses voisines. Avec une vraie grille CSS, toutes les catégories
 * d'une même "rangée" sont forcées à la même hauteur (celle de la plus
 * longue) par align-items:stretch, laissant un grand vide sous les
 * catégories plus courtes avant que la rangée suivante ne commence.
 */
function bucketize<T>(items: T[], columns: number): T[][] {
  const buckets: T[][] = Array.from({ length: columns }, () => []);
  items.forEach((item, i) => buckets[i % columns].push(item));
  return buckets;
}

export type CategoryEntry = {
  label: string;
  // null si cette catégorie n'a pas d'équivalent dans /admin/categories
  // (ex. rubrique éditoriale choisie librement par l'IA) — dans ce cas on
  // ne peut rien persister en base pour elle, le glisser-déposer est
  // simplement désactivé sur sa colonne.
  freshrssId: string | null;
  articles: ArticleLike[];
  // "À la une" en colonne swipable : uniquement sur mobile (voir
  // MobilePagedSection ci-dessous). Sur desktop, la une garde son propre
  // encart large (rendu à part par EditionView, avant <CategoryGrid>) donc
  // cette entrée est exclue de la grille desktop pour ne pas la dupliquer.
  isHero?: boolean;
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
  showFavorite = true,
  date
}: {
  initialCategories: CategoryEntry[];
  /** Limite l'aperçu à 10 lignes (page "En direct") — pour lire la suite,
   *  on ouvre l'article via la photo ou le lien source. */
  clampSummary?: boolean;
  showMedal?: boolean;
  showDateStamp?: boolean;
  showFavorite?: boolean;
  /** Dupliquée en haut de chaque page du carrousel mobile — voir
   *  MobilePagedSection. */
  date: Date;
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
      {/* ——— Mobile : une page par rubrique, swipe horizontal — chaque page
          emporte sa PROPRE copie du menu du haut (Masthead), donc swiper
          déplace le menu avec le contenu comme un seul bloc. Plus de zone de
          défilement à hauteur fixée à l'intérieur d'une page : on descend
          normalement pour tout explorer, chargement infini compris. Le
          glisser-déposer de réorganisation n'a pas de sens ici, donc pas de
          props draggable dans cette branche. Voir MobilePagedSection. */}
      <MobilePagedSection
        date={date}
        className="md:hidden"
        pages={categories.map((cat) => ({
          key: cat.label,
          content: (
            <CategoryColumn
              label={cat.label}
              articles={cat.articles}
              clampSummary={clampSummary}
              showMedal={showMedal}
              showDateStamp={showDateStamp}
              showFavorite={showFavorite}
              autoInfinite
            />
          )
        }))}
      />

      {/* ——— Desktop/tablette : chaque colonne visuelle est une pile
          indépendante (voir bucketize) plutôt qu'une grille CSS classique —
          une grille forcerait toutes les catégories d'une même "rangée" à
          partager la hauteur de la plus longue. Glisser-déposer sur le
          titre de chaque colonne inchangé. "Afficher plus d'articles"
          bascule ici en encart à défilement interne (hauteur figée) plutôt
          que de faire grandir la colonne — scrollExpand. Deux jeux de piles
          (2 colonnes en md, 4 en lg) rendus en parallèle, un seul visible à
          la fois via Tailwind — la répartition round-robin reproduit
          exactement la même position par catégorie qu'avant. */}
      {(() => {
        const nonHero = categories.filter((cat) => !cat.isHero);
        const renderColumn = (bucket: CategoryEntry[], colIndex: number, lastIndex: number) => (
          <div
            key={colIndex}
            className={`flex flex-col gap-1 ${colIndex > 0 ? "border-l border-ink/30 pl-6" : ""} ${
              colIndex < lastIndex ? "pr-6" : ""
            }`}
          >
            {bucket.map((cat) => (
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
        );

        const bucketsMd = bucketize(nonHero, 2);
        const bucketsLg = bucketize(nonHero, 4);

        return (
          <>
            <div className="hidden md:grid md:grid-cols-2 lg:hidden">
              {bucketsMd.map((bucket, i) => renderColumn(bucket, i, bucketsMd.length - 1))}
            </div>
            <div className="hidden lg:grid lg:grid-cols-4">
              {bucketsLg.map((bucket, i) => renderColumn(bucket, i, bucketsLg.length - 1))}
            </div>
          </>
        );
      })()}
    </>
  );
}
