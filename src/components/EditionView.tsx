export type ArticleLike = {
  id: string;
  headline: string | null;
  summary: string | null;
  category: string | null;
  priorityScore: number | null;
  sourceUrl: string;
  sourceTitle: string;
  feedTitle: string;
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
        <h1 className="mx-auto mb-5 max-w-4xl font-display text-4xl font-black leading-tight md:text-6xl">
          {hero.headline}
        </h1>
        <p className="drop-cap newsprint mx-auto max-w-2xl text-lg leading-relaxed text-neutral-800 md:columns-2 md:gap-8 md:text-left">
          {hero.summary}
        </p>
        <div className="mt-4">
          <SourceLine article={hero} />
        </div>
      </article>

      {/* ——— Rubriques en colonnes avec filets verticaux ——— */}
      <div className="grid gap-x-0 gap-y-12 md:grid-cols-3 md:divide-x md:divide-ink/30">
        {categories.map((cat) => (
          <section key={cat} className="md:px-6 md:first:pl-0 md:last:pr-0">
            <h2 className="mb-4 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">
              {cat}
            </h2>
            <div className="divide-y divide-ink/20">
              {byCategory.get(cat)!.map((article) => (
                <article key={article.id} className="py-4 first:pt-0">
                  <h3 className="font-display text-lg font-bold leading-snug">
                    {article.headline}
                  </h3>
                  <p className="newsprint mt-1.5 text-sm leading-relaxed text-neutral-700">
                    {article.summary}
                  </p>
                  <SourceLine article={article} />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>

      {/* Cul-de-lampe de fin d'édition */}
      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
    </div>
  );
}

function SourceLine({ article }: { article: ArticleLike }) {
  return (
    <a
      href={article.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="mt-1 inline-block text-xs italic text-sepia hover:underline"
    >
      — Source : {article.feedTitle || article.sourceTitle}
    </a>
  );
}
