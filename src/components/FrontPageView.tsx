import { ArticleImage } from "./ArticleImage";
import { type ArticleLike, type CategoryOrderEntry } from "./EditionView";
import { SpoonDivider } from "./SpoonDivider";
import { MobilePagedSection } from "./MobilePagedSection";

/**
 * Vraie "une" de journal, figée : ce qu'affiche cette page est exactement la
 * photo figée (EditionArticle) de la dernière impression, pas un flux qui
 * bouge tout seul et pas non plus la table Article "vivante" (dont
 * editionId ne pointe que vers la DERNIÈRE édition à avoir touché chaque
 * article) — voir la requête dans app/page.tsx et app/archive/[id]/page.tsx.
 * Elle ne change qu'à la prochaine impression (bouton manuel ou horaire
 * réglé dans /admin/settings), jamais au simple rechargement de la page.
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
  categoryOrder = [],
  date
}: {
  articles: ArticleLike[];
  categoryOrder?: CategoryOrderEntry[];
  /** Date de l'édition (Masthead) — dupliquée en haut de CHAQUE page du
   *  carrousel mobile (voir MobilePagedSection), puisque chaque rubrique y
   *  emporte sa propre copie du menu du haut plutôt que de partager celui
   *  affiché une seule fois au niveau de la page Next.js. */
  date: Date;
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

  // Pas de plafond ici : la limite à 5 (desktop, colonnes CSS équilibrées)
  // est appliquée uniquement au rendu desktop de StaticCategorySection (prop
  // "limit") — sur mobile, les rubriques sont empilées dans le flux normal
  // de la page (pas de page dédiée par rubrique), donc tous les articles de
  // la catégorie sont gardés ici.
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

  // Pages du carrousel mobile : "à la une" en premier (même contenu que le
  // bloc desktop ci-dessous), puis une page par rubrique.
  const mobilePages = [
    ...(heroMain
      ? [
          {
            key: "hero",
            content: (
              <div className="border-2 border-ink bg-ink/[0.07] p-6">
                <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">
                  ✦ À la une ✦
                </p>
                <div className={heroGridClass}>
                  {heroSideA && <SideHeroBox article={heroSideA} />}
                  <MainHeroBox article={heroMain} />
                  {heroSideB && <SideHeroBox article={heroSideB} />}
                </div>
              </div>
            )
          }
        ]
      : []),
    ...categories.map((cat, i) => ({
      key: cat,
      content: <StaticCategorySection label={cat} articles={byCategory.get(cat)!} tone={i % 3} />
    }))
  ];

  return (
    <div>
      {/* ——— Desktop/tablette : "à la une" en bloc fixe au-dessus des
          rubriques. Sur mobile, ce même contenu réapparaît en premier bloc
          de la pile ci-dessous (marqué "sm:hidden" ici, "hidden sm:block"
          n'existe pas — ce bloc-ci est masqué en mobile, l'équivalent
          mobile est rendu séparément juste après). */}
      {heroMain && (
        <div className="mb-10 hidden border-2 border-ink bg-ink/[0.07] p-6 sm:block md:p-8">
          <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">✦ À la une ✦</p>
          <div className={heroGridClass}>
            {heroSideA && <SideHeroBox article={heroSideA} className="md:pr-8" />}
            <MainHeroBox article={heroMain} className={heroSideA ? "md:px-8" : heroSideB ? "md:pr-8" : ""} />
            {heroSideB && <SideHeroBox article={heroSideB} className="md:pl-8" />}
          </div>
        </div>
      )}

      {/* ——— Mobile : une page par rubrique (dont "à la une" en premier),
          swipe horizontal — chaque page emporte sa PROPRE copie du menu du
          haut (Masthead), donc swiper déplace le menu avec le contenu comme
          un seul bloc. Plus de zone de défilement à hauteur fixée à
          l'intérieur d'une page : on descend normalement (défilement de
          page classique) pour tout explorer, y compris le chargement infini
          des rubriques. Voir MobilePagedSection. */}
      {(heroMain || categories.length > 0) && (
        <MobilePagedSection date={date} pages={mobilePages} className="mb-10 sm:hidden" />
      )}

      {/* ——— Tablette/desktop : rubriques en colonnes CSS (le contenu
          s'écoule colonne par colonne sans laisser de gros blancs quand une
          rubrique est plus courte que sa voisine — un grid classique aligne
          les rangées et crée ces vides). */}
      {categories.length > 0 && (
        <div className="hidden sm:block sm:columns-2 sm:gap-6 lg:columns-3">
          {categories.map((cat, i) => (
            <div key={cat} className="mb-6 break-inside-avoid">
              <StaticCategorySection label={cat} articles={byCategory.get(cat)!} tone={i % 3} limit={5} />
            </div>
          ))}
        </div>
      )}

      {/* Desktop/tablette seulement — le carrousel mobile n'a pas
          d'équivalent ici, chaque page y est déjà autonome (menu + contenu
          dupliqués, voir MobilePagedSection). */}
      <SpoonDivider className="mt-14 hidden text-center text-sepia sm:block" />
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
 * vignettes.
 *
 * "limit" est optionnel et seulement passé côté desktop (colonnes CSS) : un
 * encadré trop long y déséquilibrerait la colonne qui l'accueille et
 * créerait justement les gros vides que ce format évite. Sur mobile (blocs
 * empilés dans le flux normal de la page), pas de limite passée : tous les
 * articles de la rubrique sont affichés, jusqu'au bout de la rétention
 * configurée.
 */
function StaticCategorySection({
  label,
  articles,
  tone,
  limit
}: {
  label: string;
  articles: ArticleLike[];
  tone: number;
  limit?: number;
}) {
  const shown = typeof limit === "number" ? articles.slice(0, limit) : articles;
  const [lead, ...briefs] = shown;
  if (!lead) return null;

  return (
    <section className={CATEGORY_BOX_TONES[tone % CATEGORY_BOX_TONES.length]}>
      <h3 className="mb-4 text-center font-display text-sm font-bold uppercase tracking-[0.3em]">{label}</h3>

      {/* Photo à gauche ou à droite en alternance d'une rubrique à l'autre
          (tone impair -> à droite), plutôt que toujours du même côté. */}
      <article
        className={`mb-3 pb-3 border-b border-ink/20 ${
          lead.imageUrl ? `flex gap-4 ${tone % 2 === 1 ? "flex-row-reverse" : ""}` : ""
        }`}
      >
        {lead.imageUrl && (
          <div className="aspect-square w-24 shrink-0 sm:w-28">
            <ArticleImage src={lead.imageUrl} alt={lead.headline || lead.sourceTitle} className="h-full w-full" />
          </div>
        )}
        <div className="min-w-0">
          <h4 className="font-display text-base font-bold leading-snug">{lead.headline}</h4>
          <p className="newsprint mt-1 text-sm leading-snug text-neutral-700">{frontText(lead)}</p>
        </div>
      </article>

      {briefs.length > 0 && (
        <div className="divide-y divide-ink/20">
          {briefs.map((a, i) => (
            <div
              key={a.id}
              className={`py-2.5 first:pt-0 last:pb-0 ${
                a.imageUrl ? `flex items-start gap-4 ${i % 2 === 0 ? "flex-row-reverse" : ""}` : ""
              }`}
            >
              {a.imageUrl && (
                <div className="aspect-square w-24 shrink-0 sm:w-28">
                  <ArticleImage src={a.imageUrl} alt={a.headline || a.sourceTitle} className="h-full w-full" />
                </div>
              )}
              <div className="min-w-0">
                {/* Même taille que le titre vedette sur desktop (sm:) — la
                    différenciation (plus petit) ne reste que sur mobile. */}
                <h4 className="font-display text-xs font-bold leading-snug sm:text-base">{a.headline}</h4>
                <p className="newsprint mt-1 text-sm leading-snug text-neutral-700">{frontText(a)}</p>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
