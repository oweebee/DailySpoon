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

  const heroGridClass = `grid grid-cols-1 gap-8 ${
    heroes.length === 3
      ? "md:grid-cols-[1fr_1.7fr_1fr] md:divide-x md:divide-ink/30"
      : heroes.length === 2
        ? "md:grid-cols-[1.7fr_1fr] md:divide-x md:divide-ink/30"
        : ""
  }`;

  return (
    <div>
      {/* ——— Desktop/tablette : "à la une" en bloc fixe au-dessus des
          rubriques, comme avant. Sur mobile ce même contenu devient la
          PREMIÈRE page du carrousel swipe ci-dessous, pas un bloc séparé. */}
      {heroMain && (
        <div className="mb-10 hidden border-2 border-ink p-6 sm:block md:p-8">
          <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">✦ À la une ✦</p>
          <div className={heroGridClass}>
            {heroSideA && <SideHeroBox article={heroSideA} className="md:pr-8" />}
            <MainHeroBox article={heroMain} className={heroSideA ? "md:px-8" : heroSideB ? "md:pr-8" : ""} />
            {heroSideB && <SideHeroBox article={heroSideB} className="md:pl-8" />}
          </div>
        </div>
      )}

      {/* ——— Mobile : UN SEUL carrousel swipe (scroll-snap natif, pas de
          librairie JS) — "à la une" est sa propre page dédiée en premier,
          puis une page dédiée par rubrique ensuite. Chaque page fait
          exactement 100% de la largeur (pas de "peek" du voisin, pas de
          gap) : on ne doit jamais voir la page suivante en lisant l'actuelle. */}
      {(heroMain || categories.length > 0) && (
        <div className="-mx-6 mb-10 flex snap-x snap-mandatory overflow-x-auto sm:hidden">
          {heroMain && (
            <div className="w-full shrink-0 snap-center px-6">
              <div className="border-2 border-ink p-6">
                <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">
                  ✦ À la une ✦
                </p>
                <div className={heroGridClass}>
                  {heroSideA && <SideHeroBox article={heroSideA} />}
                  <MainHeroBox article={heroMain} />
                  {heroSideB && <SideHeroBox article={heroSideB} />}
                </div>
              </div>
            </div>
          )}
          {categories.map((cat, i) => (
            <div key={cat} className="w-full shrink-0 snap-center px-6">
              <StaticCategorySection label={cat} articles={byCategory.get(cat)!} tone={i % 3} />
            </div>
          ))}
        </div>
      )}

      {/* ——— Tablette/desktop : rubriques en colonnes CSS (le contenu
          s'écoule colonne par colonne sans laisser de gros blancs quand une
          rubrique est plus courte que sa voisine — un grid classique aligne
          les rangées et crée ces vides). */}
      {categories.length > 0 && (
        <div className="hidden sm:block sm:columns-2 sm:gap-6 lg:columns-3">
          {categories.map((cat, i) => (
            <div key={cat} className="mb-6 break-inside-avoid">
              <StaticCategorySection label={cat} articles={byCategory.get(cat)!} tone={i % 3} />
            </div>
          ))}
        </div>
      )}

      <SpoonDivider />
    </div>
  );
}

// La une doit aller à l'essentiel : frontPageSummary (produit par
// curateFrontPage, 1-2 phrases) prime sur summary partout sur cette page ;
// repli sur summary si la curation n'a pas tourné (pas de clé IA, échec...).
function frontText(article: ArticleLike): string {
  return article.frontPageSummary || article.summary || "";
}

function MainHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={`flex flex-col text-center ${className}`}>
      <h1 className="mx-auto mb-4 max-w-2xl font-display text-xl font-black leading-tight md:text-2xl">
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
      <p className="newsprint mx-auto max-w-xl text-left text-base leading-snug text-neutral-800">
        {frontText(article)}
      </p>
    </article>
  );
}

function SideHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={className}>
      <h2 className="mb-2 font-display text-sm font-bold leading-snug">{article.headline}</h2>
      {article.imageUrl && (
        <div className="mb-2 aspect-[4/3] w-full">
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            className="h-full w-full"
          />
        </div>
      )}
      <p className="newsprint text-sm leading-snug text-neutral-700">{frontText(article)}</p>
    </article>
  );
}

// Trois traitements d'encadré qui tournent d'une rubrique à l'autre (au lieu
// d'un unique style répété partout) — bordure simple/double et padding
// différents, mais toujours à plat, sans ombre ni coin arrondi, pour rester
// dans le langage papier déjà établi plutôt que de repartir sur des cartes
// modernes. Fond assombri (teinte d'encre) plutôt que bg-paper : ça détache
// nettement chaque encadré du fond de page, qui reste lui en bg-paper/70.
const CATEGORY_BOX_TONES = [
  "border-2 border-ink bg-ink/[0.07] p-5",
  "border border-ink/70 bg-ink/[0.1] p-6",
  "border-4 border-double border-ink bg-ink/[0.07] p-5"
];

/**
 * Rubrique encadrée, en deux temps façon vraie page de journal : un article
 * vedette en tête (illustré si une photo est disponible, en ligne image+texte
 * plutôt qu'empilés) puis le reste en "brèves" — juste titre + résumé
 * concis, sans photo, pour garder l'encadré lisible et éviter un mur de
 * vignettes. Plafonné à 5 articles quelle que soit la rubrique : en colonnes
 * CSS (voir FrontPageView), un encadré trop long déséquilibrerait la colonne
 * qui l'accueille et créerait justement les gros vides que ce format évite.
 */
function StaticCategorySection({
  label,
  articles,
  tone
}: {
  label: string;
  articles: ArticleLike[];
  tone: number;
}) {
  const shown = articles.slice(0, 5);
  const [lead, ...briefs] = shown;
  if (!lead) return null;

  return (
    <section className={CATEGORY_BOX_TONES[tone % CATEGORY_BOX_TONES.length]}>
      <h3 className="mb-4 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">{label}</h3>

      <article className={`mb-3 pb-3 border-b border-ink/20 ${lead.imageUrl ? "flex gap-4" : ""}`}>
        {lead.imageUrl && (
          <div className="aspect-square w-24 shrink-0 sm:w-28">
            <ArticleImage src={lead.imageUrl} alt={lead.headline || lead.sourceTitle} className="h-full w-full" />
          </div>
        )}
        <div className="min-w-0">
          <h4 className="font-display text-sm font-bold leading-snug">{lead.headline}</h4>
          <p className="newsprint mt-1 text-sm leading-snug text-neutral-700">{frontText(lead)}</p>
        </div>
      </article>

      {briefs.length > 0 && (
        <div className="divide-y divide-ink/20">
          {briefs.map((a) => (
            <div key={a.id} className="py-2.5 first:pt-0 last:pb-0">
              <h4 className="font-display text-xs font-bold leading-snug">{a.headline}</h4>
              <p className="newsprint mt-1 text-sm leading-snug text-neutral-700">{frontText(a)}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
