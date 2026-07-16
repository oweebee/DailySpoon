import { ArticleLink } from "./ArticleLink";
import { ArticleImage } from "./ArticleImage";
import { SourceLine, type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { CategoryGrid } from "./CategoryGrid";
import { SpoonDivider } from "./SpoonDivider";

/**
 * Vraie mise en page de "une" de journal : gros article vedette au centre
 * avec ses deux secondaires flanqués par un simple filet vertical (même
 * langage visuel que le bandeau "à la une" de EditionView — pas de boîtes
 * encadrées partout, qui alourdissaient trop la page), puis les rubriques en
 * colonnes classiques (CategoryGrid, réutilisé tel quel pour rester cohérent
 * avec /direct) en bas de page. /direct garde EditionView inchangé.
 *
 * "Adapté au mieux" par l'IA sans appel supplémentaire : aucune requête IA
 * dédiée à la mise en page — le nombre de héros affichés s'adapte simplement
 * aux signaux déjà produits par le traitement IA existant (priorityScore,
 * médaille), qui varient naturellement à chaque impression.
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
  const idByLabel = new Map(categoryOrder.map((c) => [c.label, c.freshrssId]));
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = orderIndex.has(a) ? orderIndex.get(a)! : Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.has(b) ? orderIndex.get(b)! : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });

  return (
    <div>
      {/* ——— Bandeau "à la une" : gros article vedette au centre, ses
          secondaires de part et d'autre séparés par un simple filet
          vertical — même langage que le bandeau "à la une" de EditionView,
          pas une boîte encadrée par article. Le nombre de colonnes s'adapte
          au nombre de héros réellement disponibles (1 à 3). */}
      {heroMain && (
        <div className="mb-12 border-b-2 border-ink pb-10">
          <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">
            ✦ À la une ✦
          </p>
          <div
            className={`grid grid-cols-1 gap-8 ${
              heroes.length === 3
                ? "md:grid-cols-[1fr_1.7fr_1fr] md:divide-x md:divide-ink/30"
                : heroes.length === 2
                  ? "md:grid-cols-[1.7fr_1fr] md:divide-x md:divide-ink/30"
                  : ""
            }`}
          >
            {heroSideA && <SideHeroBox article={heroSideA} className="md:pr-8" />}
            <MainHeroBox article={heroMain} className={heroSideA ? "md:px-8" : heroSideB ? "md:pr-8" : ""} />
            {heroSideB && <SideHeroBox article={heroSideB} className="md:pl-8" />}
          </div>
        </div>
      )}

      {/* ——— Rubriques en colonnes classiques (même composant que /direct),
          sans médaille/tampon-date/favoris : notions qui n'ont pas leur
          place sur une page toujours à la date du jour. */}
      {categories.length > 0 && (
        <CategoryGrid
          initialCategories={categories.map((cat) => ({
            label: cat,
            freshrssId: idByLabel.get(cat) ?? null,
            articles: byCategory.get(cat)!
          }))}
          clampSummary
          showMedal={false}
          showDateStamp={false}
          showFavorite={false}
        />
      )}

      <SpoonDivider />
    </div>
  );
}

function MainHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={`flex flex-col text-center ${className}`}>
      <h1 className="mx-auto mb-4 max-w-2xl font-display text-2xl font-black leading-tight md:text-3xl">
        {article.headline}
      </h1>
      {article.imageUrl && (
        <ArticleLink
          href={article.sourceUrl}
          title={article.headline || article.sourceTitle}
          className="mb-4 block aspect-[16/9] w-full"
        >
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </ArticleLink>
      )}
      <p className="newsprint mx-auto max-w-xl line-clamp-[10] text-left text-sm leading-snug text-neutral-800">
        {article.summary}
      </p>
      <div className="mt-3">
        <SourceLine article={article} center showFavorite={false} />
      </div>
    </article>
  );
}

function SideHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={className}>
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
