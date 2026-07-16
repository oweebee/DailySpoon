import { ArticleImage } from "./ArticleImage";
import { type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { SpoonDivider } from "./SpoonDivider";

/**
 * Vraie "une" de journal, figée : ce qu'affiche cette page est exactement le
 * contenu de la dernière impression (Article.editionId = dernière Edition),
 * pas un flux qui bouge tout seul — voir la requête dans app/page.tsx. Elle
 * ne change qu'à la prochaine impression (bouton manuel ou horaire réglé
 * dans /admin/settings), jamais au simple rechargement de la page.
 *
 * Page statique façon vrai journal imprimé : ni lien externe, ni source, ni
 * favori, ni médaille, ni tampon-date sur les photos — juste les articles,
 * réécrits par l'IA, à lire sur place. Pas de "lire la suite" non plus (donc
 * pas de troncature de texte) puisqu'il n'y a plus de clic possible pour
 * ouvrir l'article ailleurs. Composant dédié, distinct de EditionView/
 * CategoryGrid (toujours utilisés tels quels sur /direct, où le clic vers la
 * source reste le point central).
 *
 * Sélection des articles "à la une" : purement algorithmique (médaille puis
 * priorityScore), mais ce priorityScore est désormais recalculé par une
 * passe IA dédiée (curateFrontPage, dans generateEdition.ts) qui compare
 * tous les articles du jour entre eux plutôt que par lots isolés — c'est
 * elle qui "définit les news marquantes du jour", pas un algorithme local.
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

      {/* ——— Rubriques, en colonnes statiques : juste le texte, pas de
          composant partagé avec /direct (qui a besoin des liens/sources). */}
      {categories.length > 0 && (
        <div className="grid grid-cols-1 gap-x-10 gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {categories.map((cat) => {
            const arts = byCategory.get(cat)!;
            const big = arts.length >= 4;
            return <StaticCategorySection key={cat} label={cat} articles={arts} big={big} />;
          })}
        </div>
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
        <div className="mb-4 aspect-[16/9] w-full">
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </div>
      )}
      <p className="newsprint mx-auto max-w-xl text-left text-sm leading-snug text-neutral-800">
        {article.summary}
      </p>
    </article>
  );
}

function SideHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={className}>
      <h2 className="mb-2 font-display text-base font-bold leading-snug">{article.headline}</h2>
      {article.imageUrl && (
        <div className="mb-2 aspect-[4/3] w-full">
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </div>
      )}
      <p className="newsprint text-xs leading-snug text-neutral-700">{article.summary}</p>
    </article>
  );
}

function StaticCategorySection({ label, articles, big }: { label: string; articles: ArticleLike[]; big: boolean }) {
  const shown = articles.slice(0, big ? 6 : 3);
  return (
    <section className={big ? "sm:col-span-2" : ""}>
      <h3 className="mb-3 border-y-2 border-ink py-1.5 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">
        {label}
      </h3>
      <div className="divide-y divide-ink/20">
        {shown.map((a) => (
          <div key={a.id} className="py-3 first:pt-0 last:pb-0">
            <h4 className="font-display text-sm font-bold leading-snug">{a.headline}</h4>
            <p className="newsprint mt-1 text-xs leading-snug text-neutral-700">{a.summary}</p>
          </div>
        ))}
      </div>
    </section>
  );
}
