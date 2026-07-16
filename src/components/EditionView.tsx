import { CategoryGrid } from "./CategoryGrid";
import { ArticleLink } from "./ArticleLink";
import { FavoriteStar } from "./FavoriteStar";
import { SpoonDivider } from "./SpoonDivider";

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
  const byRecency = (a: ArticleLike, b: ArticleLike) => {
    const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
    const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
    return tb - ta;
  };
  const medaledArticles = [...articles].filter((a) => a.medal).sort(byRecency);
  const fallbackArticles = [...articles]
    .filter((a) => !a.medal)
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

  // "À la une" devient elle-même une colonne (même rendu que les rubriques :
  // titre encadré, liste d'articles avec photo/source, "afficher plus"/
  // défilement infini), toujours placée en tête plutôt que dans un bloc à
  // part avec sa propre mise en page spéciale.
  const columns = [
    ...(heroes.length > 0 ? [{ label: "À la une", freshrssId: null, articles: heroes }] : []),
    ...categories.map((cat) => ({
      label: cat,
      freshrssId: idByLabel.get(cat) ?? null,
      articles: byCategory.get(cat)!
    }))
  ];

  return (
    <div>
      {/* ——— Mobile : cuillères placées au-dessus des colonnes plutôt qu'en
          bas de page, pour marquer la transition avec l'en-tête. */}
      <SpoonDivider className="mb-6 text-center text-sepia md:hidden" />

      {/* ——— Rubriques (dont "À la une") en colonnes avec filets verticaux
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
