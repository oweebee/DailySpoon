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
    <section className="md:px-6 md:first:pl-0 md:last:pr-0">
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
