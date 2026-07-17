import { CategoryGrid } from "./CategoryGrid";
import { ArticleLink } from "./ArticleLink";
import { ArticleImage } from "./ArticleImage";
import { FavoriteStar } from "./FavoriteStar";
import { SpoonDivider } from "./SpoonDivider";
import { todayRangeInTz } from "../lib/tz";

export type ArticleLike = {
  id: string;
  headline: string | null;
  summary: string | null;
  // Résumé concis dédié à la une IA (voir FrontPageView) — absent/inutilisé
  // partout ailleurs (En direct, favoris, archive gardent `summary`).
  frontPageSummary?: string | null;
  category: string | null;
  // Catégorie FreshRSS d'origine (celle choisie dans /admin/categories) —
  // distincte de "category" ci-dessus qui est la rubrique éditoriale
  // attribuée par l'IA (peut ne correspondre à aucune catégorie réellement
  // sélectionnée). Utilisée pour grouper "En direct" par les vraies
  // catégories FreshRSS plutôt que par la classification IA.
  categoryLabel?: string | null;
  priorityScore: number | null;
  sourceUrl: string;
  sourceTitle: string;
  feedTitle: string;
  imageUrl: string | null;
  publishedAt: Date | string | null;
  favorite: boolean;
  medal: boolean;
};

export type CategoryOrderEntry = { freshrssId: string; label: string };

export function EditionView({
  articles,
  categoryOrder = [],
  clampSummary = false,
  date
}: {
  articles: ArticleLike[];
  /** Dupliquée en haut de chaque page du carrousel mobile — voir
   *  CategoryGrid/MobilePagedSection. */
  date: Date;
  /** Ordre persisté (SelectedCategory.order, réglable en glissant le titre
   *  d'une colonne ici même, ou dans /admin/categories) des catégories
   *  FreshRSS. Les catégories absentes de cette liste (ex. rubriques
   *  éditoriales choisies par l'IA quand elle est activée) sont affichées
   *  après, par ordre alphabétique, et ne sont pas déplaçables (rien à
   *  persister pour elles). */
  categoryOrder?: CategoryOrderEntry[];
  /** Limite l'aperçu de texte à 10 lignes (page "En direct") — pour lire la
   *  suite, on ouvre l'article via la photo ou le lien source. */
  clampSummary?: boolean;
}) {
  if (articles.length === 0) {
    return (
      <p className="py-24 text-center italic text-sepia">
        Aucun article dans cette édition pour l’instant.
      </p>
    );
  }

  // "À la une" affiche les 3 dernières news (par date de publication) des
  // flux "médaillés" (décoration réglée dans /admin/categories, à côté du
  // flux) — plutôt que les 3 mieux priorisées par l'IA. S'il y a moins de 3
  // articles médaillés disponibles, on complète avec les mieux priorisés
  // (comportement précédent) pour ne jamais laisser un emplacement vide.
  //
  // Uniquement des news DU JOUR (heure de Paris, comme le reste de l'app) :
  // "En direct" n'affiche jamais un article périmé en "à la une" simplement
  // parce que c'est le plus récent d'un flux médaillé — si son dernier
  // article date d'il y a 2 jours, ce flux n'apparaît tout simplement pas
  // dans le bloc "à la une" plutôt que d'y montrer du contenu qui n'est plus
  // d'actualité (repli sur les mieux priorisés) idem, restreint à aujourd'hui.
  const todayRange = todayRangeInTz("Europe/Paris");
  const isToday = (a: ArticleLike) => {
    if (!a.publishedAt) return false;
    const t = new Date(a.publishedAt).getTime();
    return t >= todayRange.gte.getTime() && t < todayRange.lt.getTime();
  };
  const byRecency = (a: ArticleLike, b: ArticleLike) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  };
  const medaledArticles = [...articles].filter((a) => a.medal && isToday(a)).sort(byRecency);
  const fallbackArticles = [...articles]
    .filter((a) => !a.medal && isToday(a))
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
  const [heroA, heroB, heroC] = [...medaledArticles, ...fallbackArticles];
  const heroes = [heroA, heroB, heroC].filter((a): a is ArticleLike => Boolean(a));
  const heroIds = new Set(heroes.map((h) => h.id));
  const rest = articles.filter((a) => !heroIds.has(a.id));

  // Regroupement par vraie catégorie FreshRSS (categoryLabel), pas par la
  // rubrique éditoriale attribuée par l'IA (category) : "En direct" est censé
  // refléter tel quel les catégories choisies dans /admin/categories, or un
  // article déjà passé par l'IA lors d'une génération précédente (même si
  // "En direct" ne consomme jamais l'IA lui-même) garde la rubrique que l'IA
  // lui a assignée à l'époque — ce qui faisait apparaître ici des colonnes
  // ("Culture", "Autre"...) ne correspondant à aucune catégorie réellement
  // sélectionnée par l'utilisateur.
  const byCategory = new Map<string, ArticleLike[]>();
  for (const article of rest) {
    const cat = article.categoryLabel || article.category || "Autre";
    if (!byCategory.has(cat)) byCategory.set(cat, []);
    byCategory.get(cat)!.push(article);
  }

  // Les plus récents d'abord, toutes sources confondues. Pas de plafond ici :
  // sur desktop, CategoryColumn bascule maintenant en encart à défilement
  // interne (hauteur figée) une fois "Afficher plus d'articles" cliqué, donc
  // la colonne peut faire défiler tout l'historique déjà chargé (borné en
  // amont par le "take: 1000" de la requête) sans jamais grandir elle-même.
  for (const [cat, arts] of byCategory) {
    arts.sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
  }

  const orderIndex = new Map(categoryOrder.map((c, i) => [c.label, i]));
  const idByLabel = new Map(categoryOrder.map((c) => [c.label, c.freshrssId]));
  const categories = [...byCategory.keys()].sort((a, b) => {
    const ia = orderIndex.has(a) ? orderIndex.get(a)! : Number.MAX_SAFE_INTEGER;
    const ib = orderIndex.has(b) ? orderIndex.get(b)! : Number.MAX_SAFE_INTEGER;
    if (ia !== ib) return ia - ib;
    return a.localeCompare(b);
  });

  // "À la une" en colonne swipable : uniquement sur mobile (voir isHero dans
  // CategoryGrid, qui l'exclut de la grille desktop). Sur desktop, la une
  // garde son grand encart large ci-dessous, comme avant.
  const columns = [
    ...(heroes.length > 0 ? [{ label: "À la une", freshrssId: null, articles: heroes, isHero: true }] : []),
    ...categories.map((cat) => ({
      label: cat,
      freshrssId: idByLabel.get(cat) ?? null,
      articles: byCategory.get(cat)!
    }))
  ];

  // Répartition gauche/centre/droite du grand encart desktop — même logique
  // que FrontPageView (héros principal au centre, 1 ou 2 articles annexes de
  // part et d'autre selon le nombre de médaillés/priorisés disponibles).
  const heroMain = heroes[0];
  const heroSideA = heroes.length === 3 ? heroes[1] : undefined;
  const heroSideB = heroes.length === 3 ? heroes[2] : heroes.length === 2 ? heroes[1] : undefined;
  const heroGridClass = `grid grid-cols-1 gap-8 ${
    heroes.length === 3
      ? "md:grid-cols-[1fr_1.7fr_1fr] md:divide-x md:divide-ink/30"
      : heroes.length === 2
        ? "md:grid-cols-[1.7fr_1fr] md:divide-x md:divide-ink/30"
        : ""
  }`;

  return (
    <div>
      {/* ——— Mobile : cuillères placées au-dessus des colonnes plutôt qu'en
          bas de page, pour marquer la transition avec l'en-tête. */}
      <SpoonDivider className="mb-6 text-center text-sepia md:hidden" />

      {/* ——— Desktop/tablette : grand encart "à la une" fixe au-dessus des
          rubriques (comme avant) — sur mobile, "À la une" redevient une
          simple colonne swipable parmi les autres (voir isHero plus bas). */}
      {heroMain && (
        <div className="mb-10 hidden border-2 border-ink bg-ink/[0.07] p-6 md:block md:p-8">
          <p className="mb-6 text-center text-xs uppercase tracking-[0.35em] text-journal">✦ À la une ✦</p>
          <div className={heroGridClass}>
            {heroSideA && <SideHeroBox article={heroSideA} className="md:pr-8" />}
            <MainHeroBox article={heroMain} className={heroSideA ? "md:px-8" : heroSideB ? "md:pr-8" : ""} />
            {heroSideB && <SideHeroBox article={heroSideB} className="md:pl-8" />}
          </div>
        </div>
      )}

      {/* ——— Rubriques (dont "À la une" sur mobile) en colonnes avec filets verticaux
          ——— Note : pas de "divide-x" ici. Cette classe ajoute un filet à
          gauche de chaque colonne sauf la 1ère du DOM, sans tenir compte
          des retours à la ligne de la grille (2 col en md, 4 en lg) — le
          filet réapparaît alors à gauche de la 1ère colonne de la rangée
          suivante au lieu de rester à droite. Les filets sont donc posés
          directement dans CategoryColumn, calculés par position réelle
          dans la rangée (nth-child) pour chaque taille d'écran. */}
      <CategoryGrid initialCategories={columns} clampSummary={clampSummary} date={date} />

      {/* Cul-de-lampe de fin d'édition — desktop seulement (mobile l'a déjà
          au-dessus des colonnes, voir plus haut). */}
      <SpoonDivider className="mt-14 hidden text-center text-sepia md:block" />
    </div>
  );
}

// IMPORTANT: le fuseau horaire doit être fixé explicitement ici.
// Sans "timeZone", Intl.DateTimeFormat utilise le fuseau du runtime :
// UTC côté serveur (Node) mais Europe/Paris côté navigateur, ce qui produit
// une heure différente entre le rendu serveur et l'hydratation client
// -> erreur d'hydratation React -> les boutons de la page cessent de répondre.
// On force donc le même fuseau des deux côtés, et on assemble la chaîne
// nous-mêmes à partir de formatToParts pour éviter aussi tout écart de
// caractères d'espacement entre les implémentations ICU serveur/navigateur.
const DISPLAY_TZ = "Europe/Paris";

function getFrDateParts(date: Date) {
  const parts = new Intl.DateTimeFormat("fr-FR", {
    timeZone: DISPLAY_TZ,
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return {
    day: get("day"),
    month: get("month").replace(".", ""),
    year: get("year"),
    hour: get("hour"),
    minute: get("minute")
  };
}

export function formatPublished(d: Date | string | null): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  const p = getFrDateParts(date);
  return `${p.day} ${p.month} ${p.year}, ${p.hour}:${p.minute}`;
}

/** Short caps format for the on-photo "stamp", e.g. "15 JUIL 2026 14:32". */
export function formatStamp(d: Date | string | null): string | null {
  if (!d) return null;
  const date = new Date(d);
  if (isNaN(date.getTime())) return null;
  const p = getFrDateParts(date);
  return `${p.day} ${p.month} ${p.year} ${p.hour}:${p.minute}`.toUpperCase();
}

export function SourceLine({
  article,
  showDate = true,
  center = false,
  showFavorite = true
}: {
  article: ArticleLike;
  showDate?: boolean;
  /** Centre la ligne au lieu de la caler à gauche — utilisé pour les 3
   *  articles "à la une", dont le reste du bloc est déjà centré. */
  center?: boolean;
  /** Masque l'étoile favori — la page d'accueil (FrontPageView) n'a pas
   *  cette notion, seuls /direct et /favoris l'utilisent. */
  showFavorite?: boolean;
}) {
  const formatted = showDate ? formatPublished(article.publishedAt) : null;
  return (
    <p
      className={`mt-1 flex items-center gap-1.5 text-xs italic text-sepia ${
        center ? "justify-center" : ""
      }`}
    >
      {formatted && <span>{formatted} · </span>}
      <ArticleLink href={article.sourceUrl} title={article.headline || article.sourceTitle} className="hover:underline">
        Source : {article.feedTitle || article.sourceTitle}
      </ArticleLink>
      {showFavorite && <FavoriteStar articleId={article.id} initialFavorite={article.favorite} />}
    </p>
  );
}

/** Grand encart "à la une" (desktop uniquement) — héros central, cliquable
 *  vers la source comme partout ailleurs sur /direct (contrairement à
 *  FrontPageView, statique, cet encart garde photo tamponnée/médaille et
 *  lien source). */
function MainHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={`flex flex-col text-center ${className}`}>
      <h2 className="mx-auto mb-4 max-w-2xl font-display text-xl font-black leading-tight md:text-2xl">
        <ArticleLink href={article.sourceUrl} title={article.headline || article.sourceTitle} className="hover:underline">
          {article.headline}
        </ArticleLink>
      </h2>
      {article.imageUrl && (
        <ArticleLink href={article.sourceUrl} title={article.headline || article.sourceTitle} className="mb-4 block aspect-[16/9] w-full">
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            dateLabel={formatStamp(article.publishedAt)}
            medal={article.medal}
            className="h-full w-full"
          />
        </ArticleLink>
      )}
      <p className="newsprint mx-auto max-w-xl text-left text-base leading-snug text-neutral-800">{article.summary}</p>
      <SourceLine article={article} center />
    </article>
  );
}

function SideHeroBox({ article, className = "" }: { article: ArticleLike; className?: string }) {
  return (
    <article className={className}>
      <h3 className="mb-2 font-display text-sm font-bold leading-snug">
        <ArticleLink href={article.sourceUrl} title={article.headline || article.sourceTitle} className="hover:underline">
          {article.headline}
        </ArticleLink>
      </h3>
      {article.imageUrl && (
        <ArticleLink href={article.sourceUrl} title={article.headline || article.sourceTitle} className="mb-2 block aspect-[4/3] w-full">
          <ArticleImage
            src={article.imageUrl}
            alt={article.headline || article.sourceTitle}
            dateLabel={formatStamp(article.publishedAt)}
            medal={article.medal}
            className="h-full w-full"
          />
        </ArticleLink>
      )}
      <p className="newsprint text-sm leading-snug text-neutral-700">{article.summary}</p>
      <SourceLine article={article} />
    </article>
  );
}
