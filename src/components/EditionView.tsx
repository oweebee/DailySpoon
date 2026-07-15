import { CategoryColumn } from "./CategoryColumn";
import { ArticleImage } from "./ArticleImage";

export type ArticleLike = {
  id: string;
  headline: string | null;
  summary: string | null;
  category: string | null;
  priorityScore: number | null;
  sourceUrl: string;
  sourceTitle: string;
  feedTitle: string;
  imageUrl: string | null;
  publishedAt: Date | string | null;
};

export function EditionView({ articles }: { articles: ArticleLike[] }) {
  if (articles.length === 0) {
    return (
      <p className="py-24 text-center italic text-sepia">
        Aucun article dans cette édition pour l’instant.
      </p>
    );
  }

  const sorted = [...articles].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  const [hero, ...rest] = sorted;

  const MAX_PER_CATEGORY = 20;

  const byCategory = new Map<string, ArticleLike[]>();
  for (const article of rest) {
    const cat = article.category || "Autre";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(article);
  }

  // Les plus récents d'abord, toutes sources confondues, et on plafonne à
  // 20 par rubrique pour ne pas la laisser grossir indéfiniment au fil des
  // régénérations (bouton "Aspirer les news" notamment).
  for (const [cat, arts] of byCategory) {
    arts.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    byCategory.set(cat, arts.slice(0, MAX_PER_CATEGORY));
  }

  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div>
      {/* ——— À la une ——— */}
      <article className="mb-10 border-b-2 border-ink pb-10 text-center">
        <p className="mb-3 text-xs uppercase tracking-[0.35em] text-journal">
          ✦ À la une ✦
        </p>
        <h1 className="mx-auto mb-5 max-w-3xl font-display text-3xl font-black leading-tight md:text-5xl">
          {hero.headline}
        </h1>
        {hero.imageUrl && (
          <ArticleImage
            src={hero.imageUrl}
            alt={hero.headline || hero.sourceTitle}
            dateLabel={formatStamp(hero.publishedAt)}
            className="mx-auto mb-5 aspect-[16/9] w-full max-w-2xl"
          />
        )}
        <p className="drop-cap newsprint mx-auto max-w-2xl text-base leading-snug text-neutral-800 md:columns-2 md:gap-8 md:text-left">
          {hero.summary}
        </p>
        <div className="mt-4">
          <SourceLine article={hero} showDate={!hero.imageUrl} />
        </div>
      </article>

      {/* ——— Rubriques en colonnes avec filets verticaux ——— */}
      <div className="grid gap-x-0 gap-y-8 md:grid-cols-2 md:divide-x md:divide-ink/30 lg:grid-cols-4">
        {categories.map((cat) => (
          <CategoryColumn key={cat} label={cat} articles={byCategory.get(cat)!} />
        ))}
      </div>

      {/* Cul-de-lampe de fin d'édition */}
      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
    </div>
  );
}

export function formatPublished(d: Date | string | null): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).format(date);
}

/** Short caps format for the on-photo "stamp", e.g. "15 JUIL 2026 14:32". */
export function formatStamp(d: Date | string | null): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("fr-FR", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit"
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return `${get("day")} ${get("month").replace(".", "")} ${get("year")} ${get("hour")}:${get("minute")}`.toUpperCase();
}

export function SourceLine({ article, showDate = true }: { article: ArticleLike; showDate?: boolean }) {
  const formatted = showDate ? formatPublished(article.publishedAt) : null;
  return (
    <p className="mt-1 text-xs italic text-sepia">
      {formatted && <span>{formatted} · </span>}
      <a href={article.sourceUrl} target="_blank" rel="noopener noreferrer" className="hover:underline">
        Source : {article.feedTitle || article.sourceTitle}
      </a>
    </p>
  );
}
