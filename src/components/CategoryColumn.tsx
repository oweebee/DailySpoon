"use client";

import { useState } from "react";
import type { ArticleLike } from "./EditionView";
import { SourceLine, formatStamp } from "./EditionView";
import { ArticleImage } from "./ArticleImage";
import { ArticleLink } from "./ArticleLink";

const INITIAL_COUNT = 5;
const STEP = 5;

export function CategoryColumn({
  label,
  articles,
  draggable = false,
  isDragging = false,
  onDragStart,
  onDragEnd,
  onDropHere,
  clampSummary = false,
  showMedal = true,
  showDateStamp = true,
  showFavorite = true
}: {
  label: string;
  articles: ArticleLike[];
  /** Autorise le glisser-déposer du titre pour réorganiser les colonnes.
   *  Désactivé si cette catégorie n'a pas d'équivalent dans les réglages
   *  admin (ex. rubrique éditoriale choisie par l'IA) — rien à persister. */
  draggable?: boolean;
  isDragging?: boolean;
  onDragStart?: () => void;
  onDragEnd?: () => void;
  onDropHere?: () => void;
  /** Limite l'aperçu à 10 lignes (page "En direct") — pour lire la suite,
   *  on ouvre l'article via la photo ou le lien source. */
  clampSummary?: boolean;
  /** La page d'accueil (FrontPageView) n'a pas la notion de médaille, de
   *  tampon-date sur la photo (toujours l'édition du jour) ni de favoris —
   *  ces trois options permettent de les masquer, tout en gardant le
   *  comportement habituel (true) partout ailleurs (/direct, colonnes
   *  classiques). */
  showMedal?: boolean;
  showDateStamp?: boolean;
  showFavorite?: boolean;
}) {
  const [visibleCount, setVisibleCount] = useState(INITIAL_COUNT);

  const visible = articles.slice(0, visibleCount);
  const remaining = articles.length - visible.length;

  return (
    // Filets et paddings calculés par position réelle dans la rangée
    // (nth-child), pas par "divide-x" (qui ignore les retours à la ligne
    // de la grille et faisait apparaître le filet à gauche de la 1ère
    // colonne de chaque nouvelle rangée au lieu de rester à droite).
    // md = grille à 2 colonnes (rangées : 1-2, 3-4, ...) : filet retiré
    // sur les positions impaires (1er de chaque rangée).
    // lg = grille à 4 colonnes (rangées : 1-4, 5-8, ...) : on restaure le
    // filet sur les positions 3/7/11 (retiré à tort par la règle "impair"
    // du md) et on restaure le padding droit sur les positions 2/6/10.
    <section
      onDragOver={draggable ? (e) => e.preventDefault() : undefined}
      onDrop={
        draggable
          ? (e) => {
              e.preventDefault();
              onDropHere?.();
            }
          : undefined
      }
      className={`md:border-l md:border-ink/30 md:px-6 md:[&:nth-child(2n+1)]:border-l-0 md:[&:nth-child(2n+1)]:pl-0 md:[&:nth-child(2n)]:pr-0 lg:[&:nth-child(4n+3)]:border-l lg:[&:nth-child(4n+3)]:pl-6 lg:[&:nth-child(4n+2)]:pr-6 ${isDragging ? "opacity-40" : ""}`}
    >
      <h2
        draggable={draggable}
        onDragStart={draggable ? onDragStart : undefined}
        onDragEnd={draggable ? onDragEnd : undefined}
        className={`mb-4 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em] ${
          draggable ? "cursor-grab select-none active:cursor-grabbing" : ""
        }`}
      >
        {label}
      </h2>
      <div className="divide-y divide-ink/20">
        {visible.map((article) => (
          <article key={article.id} className="py-4 first:pt-0">
            {article.imageUrl && (
              <ArticleLink
                href={article.sourceUrl}
                title={article.headline || article.sourceTitle}
                className="mb-2 block aspect-[16/9] w-full"
              >
                <ArticleImage
                  src={article.imageUrl}
                  alt={article.headline || article.sourceTitle}
                  dateLabel={showDateStamp ? formatStamp(article.publishedAt) : null}
                  medal={showMedal ? article.medal : false}
                  className="h-full w-full"
                />
              </ArticleLink>
            )}
            <h3 className="font-display text-sm font-bold leading-snug">{article.headline}</h3>
            <p
              className={`newsprint mt-1 text-sm leading-snug text-neutral-700 ${
                clampSummary ? "line-clamp-[10]" : ""
              }`}
            >
              {article.summary}
            </p>
            <SourceLine article={article} showDate={!article.imageUrl} showFavorite={showFavorite} />
          </article>
        ))}
      </div>

      {remaining > 0 && (
        <button
          onClick={() => setVisibleCount((c) => Math.min(c + STEP, articles.length))}
          className="mt-3 w-full border-t border-dashed border-ink/40 pt-2 text-center text-[0.65rem] italic uppercase tracking-[0.2em] text-sepia hover:text-ink hover:underline"
        >
          Suite — encore {Math.min(STEP, remaining)} de plus ({remaining} au total)
        </button>
      )}
    </section>
  );
}
