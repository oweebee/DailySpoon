import { ArticleLink } from "./ArticleLink";
import { ArticleImage } from "./ArticleImage";
import { SourceLine, type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { SpoonDivider } from "./SpoonDivider";

/**
 * Vraie mise en page de "une" de journal — boîtes encadrées façon coupures
 * de presse (gros article au centre, deux articles secondaires de part et
 * d'autre, puis des rubriques en encadrés en bas de page), plutôt que la
 * grille à filets verticaux de EditionView (toujours utilisée telle quelle
 * sur /direct, inchangée).
 *
 * "Adapté au mieux" par l'IA sans appel supplémentaire : aucune requête IA
 * dédiée à la mise en page — le nombre de héros affichés et la taille des
 * encadrés de rubrique s'adaptent simplement aux signaux déjà produits par
 * le traitement IA existant (priorityScore, médaille, volume d'articles par
 * rubrique), qui varient naturellement à chaque impression.
 */
export function FrontPageView({
  articles,
  categoryOrder = []
}: {
  articles: ArticleLike[];
  categoryOrder?: CategoryOrderEntry[];
}) {
  if (articles.length === 0) {
    return (
      <p className="py-24 text-center italic text-sepia">
        Aucun article dans cette édition pour l’instant.
      </p>
    );
  }

  // Même logique de sélection des héros que EditionView (recency des flux
  // médaillés, puis repli sur priorityScore) — gardée identique pour que
  // "à la une" désigne toujours les mêmes articles partout dans l'app.
  const byRecency = (a: ArticleLike, b: ArticleLike) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  };
  const medaledArticles = [...articles].filter((a) => a.medal).sort(byRecency);
  const fallbackArticles = [...articles]
    .filter((a) => !a.medal)
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  const heroes = [...medaledArticles, ...fallbackArticles].slice(0, 3);
  const heroMain = heroes[0];
  // Répartition de gauche/droite calculée explicitement (plutôt qu'une
  // déstructuration de tableau) pour que TypeScript puisse vraiment
  // rétrécir chaque variable à ArticleLike (non undefined) au moment du
  // rendu, via un simple "x && <Comp article={x} />" — la longueur de
  // `heroes` seule ne suffit pas à le prouver côté typage.
  const heroSideA = heroes.length === 3 ? heroes[1] : undefined;
  const heroSideB = heroes.length === 3 ? heroes[2] : heroes.length === 2 ? heroes[1] : undefined;
  const heroIds = new Set(heroes.map((h) => h.id));
  const rest = articles.filter((a) => !heroIds.has(a.id));

  const MAX_PER_CATEGORY = 20;
  const byCategory = new Map<string, ArticleLike[]>();
  for (const article of rest) {
    const cat = article.category || "Autre";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(article);
  }
  for (const [cat, arts] of byCategory) {
    arts.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    byCategory.set(cat, arts.slice(0, MAX_PER_CATEGORY));
  }

  const orderIndex = new Map(categoryOrder.map((c, i) => [c.label, i]));
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = orderIndex.has(a) ? orderIndex.get(a)! : Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.has(b) ? orderIndex.get(b)! : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });

  return (
    <div>
      <p className="mb-4 text-center text-xs uppercase tracking-[0.35em] text-journal">
        ✦ Édition du jour ✦
      </p>

      {/* ——— Bandeau "à la une" : gros article encadré au centre, deux
          secondaires de part et d'autre — le nombre de colonnes s'adapte
          au nombre de héros réellement disponibles (1 à 3). */}
      {heroMain && (
        <div
          className={`mb-6 grid grid-cols-1 gap-4 ${
            heroes.length === 3 ? "md:grid-cols-[1fr_1.6fr_1fr]" : heroes.length === 2 ? "md:grid-cols-[1.6fr_1fr]" : ""
          }`}
        >
          {heroSideA && <SideHeroBox article={heroSideA} />}
          <MainHeroBox article={heroMain} />
          {heroSideB && <SideHeroBox article={heroSideB} />}
        </div>
      )}

      {/* ——— Rubriques en encadrés, en bas de page — la taille de chaque
          encadré s'adapte au volume d'articles qu'il contient : une
          rubrique bien fournie ce jour-là prend plus de place, une
          rubrique clairsemée reste compacte. */}
      {categories.length > 0 && (
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((cat) => {
            const arts = byCategory.get(cat)!;
            const big = arts.length >= 4;
            return <CategoryBox key={cat} label={cat} articles={arts} big={big} />;
          })}
        </div>
      )}

      <SpoonDivider />
    </div>
  );
}

function MainHeroBox({ article }: { article: ArticleLike }) {
  return (
    <article className="flex flex-col border-2 border-ink p-5">
      <h1 className="mb-3 text-center font-display text-2xl font-black leading-tight md:text-3xl">
        {article.headline}
      </h1>
      {article.imageUrl && (
        <ArticleLink
          href={article.sourceUrl}
          title={article.headline || article.sourceTitle}
          className="mb-3 block aspect-[16/9] w-full"
        >
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </ArticleLink>
      )}
      <p className="newsprint line-clamp-[10] flex-1 text-sm leading-snug text-neutral-800">
        {article.summary}
      </p>
      <div className="mt-3 border-t border-ink/30 pt-2">
        <SourceLine article={article} center showFavorite={false} />
      </div>
    </article>
  );
}

function SideHeroBox({ article }: { article: ArticleLike }) {
  return (
    <article className="border-2 border-ink p-4">
      <h2 className="mb-2 font-display text-base font-bold leading-snug">{article.headline}</h2>
      {article.imageUrl && (
        <ArticleLink
          href={article.sourceUrl}
          title={article.headline || article.sourceTitle}
          className="mb-2 block aspect-[4/3] w-full"
        >
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </ArticleLink>
      )}
      <p className="newsprint line-clamp-[8] text-xs leading-snug text-neutral-700">{article.summary}</p>
      <div className="mt-2">
        <SourceLine article={article} showFavorite={false} />
      </div>
    </article>
  );
}

function CategoryBox({ label, articles, big }: { label: string; articles: ArticleLike[]; big: boolean }) {
  const shown = articles.slice(0, big ? 6 : 3);
  return (
    <div className={`border-2 border-ink p-4 ${big ? "sm:col-span-2" : ""}`}>
      <h3 className="mb-3 border-b-2 border-ink pb-2 text-center font-display text-xs font-bold uppercase tracking-[0.25em]">
        {label}
      </h3>
      <div className="divide-y divide-ink/20">
        {shown.map((a) => (
          <div key={a.id} className="py-3 first:pt-0 last:pb-0">
            <ArticleLink
              href={a.sourceUrl}
              title={a.headline || a.sourceTitle}
              className="block font-display text-sm font-bold leading-snug hover:underline"
            >
              {a.headline}
            </ArticleLink>
            <p className="newsprint mt-1 line-clamp-3 text-xs leading-snug text-neutral-700">{a.summary}</p>
            <SourceLine article={a} showFavorite={false} />
          </div>
        ))}
      </div>
    </div>
  );
}
