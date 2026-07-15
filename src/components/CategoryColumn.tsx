"use client";

import { useState } from "react";
import type { ArticleLike } from "./EditionView";
import { SourceLine, formatStamp } from "./EditionView";
import { ArticleImage } from "./ArticleImage";

const INITIAL_COUNT = 3;
const STEP = 5;

export function CategoryColumn({ label, articles }: { label: string; articles: ArticleLike[] }) {
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
      className="md:border-l md:border-ink/30 md:px-6 md:[&:nth-child(2n+1)]:border-l-0 md:[&:nth-child(2n+1)]:pl-0 md:[&:nth-child(2n)]:pr-0 lg:[&:nth-child(4n+3)]:border-l lg:[&:nth-child(4n+3)]:pl-6 lg:[&:nth-child(4n+2)]:pr-6"
    >
      <h2 className="mb-4 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">
        {label}
      </h2>
      <div className="divide-y divide-ink/20">
        {visible.map((article) => (
          <article key={article.id} className="py-4 first:pt-0">
            {article.imageUrl && (
              <ArticleImage
                src={article.imageUrl}
                alt={article.headline || article.sourceTitle}
                dateLabel={formatStamp(article.publishedAt)}
                className="mb-2 aspect-[16/9] w-full"
              />
            )}
            <h3 className="font-display text-base font-bold leading-snug">{article.headline}</h3>
            <p className="newsprint mt-1 text-[0.8rem] leading-snug text-neutral-700">
              {article.summary}
            </p>
            <SourceLine article={article} showDate={!article.imageUrl} />
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
