type ArticleLike = {
  id: string;
  headline: string | null;
  summary: string | null;
  category: string | null;
  priorityScore: number | null;
  sourceUrl: string;
  sourceTitle: string;
  feedTitle: string;
};

export function EditionView({ articles }: { articles: ArticleLike[] }) {
  if (articles.length === 0) {
    return (
      <p className="text-center text-neutral-500 py-24">
        Aucun article dans cette édition pour l’instant.
      </p>
    );
  }

  const sorted = [...articles].sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  const [hero, ...rest] = sorted;

  const byCategory = new Map<string, ArticleLike[]>();
  for (const article of rest) {
    const cat = article.category || "Autre";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(article);
  }

  const categories = [...byCategory.keys()].sort((a, b) => a.localeCompare(b));

  return (
    <div>
      <article className="border-b-2 border-ink pb-8 mb-8">
        <p className="uppercase text-xs tracking-widest text-neutral-600 mb-2">À la une</p>
        <h1 className="text-4xl md:text-5xl font-bold leading-tight mb-3">{hero.headline}</h1>
        <p className="text-lg leading-relaxed text-neutral-800">{hero.summary}</p>
        <SourceLine article={hero} />
      </article>

      <div className="grid md:grid-cols-3 gap-x-8 gap-y-10">
        {categories.map((cat) => (
          <section key={cat}>
            <h2 className="text-lg font-bold uppercase border-b border-ink mb-3 pb-1">{cat}</h2>
            <div className="space-y-5">
              {byCategory.get(cat)!.map((article) => (
                <article key={article.id}>
                  <h3 className="font-bold leading-snug">{article.headline}</h3>
                  <p className="text-sm text-neutral-700 mt-1 leading-relaxed">{article.summary}</p>
                  <SourceLine article={article} />
                </article>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function SourceLine({ article }: { article: ArticleLike }) {
  return (
    <a
      href={article.sourceUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="text-xs text-neutral-500 hover:underline mt-1 inline-block"
    >
      Source : {article.feedTitle || article.sourceTitle}
    </a>
  );
}
