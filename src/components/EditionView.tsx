import { CategoryGrid } from "./CategoryGrid";
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

export type CategoryOrderEntry = { freshrssId: string; label: string };

export function EditionView({
  articles,
  categoryOrder = []
}: {
  articles: ArticleLike[];
  /** Ordre persisté (SelectedCategory.order, réglable en glissant le titre
   *  d'une colonne ici même, ou dans /admin/categories) des catégories
   *  FreshRSS. Les catégories absentes de cette liste (ex. rubriques
   *  éditoriales choisies par l'IA quand elle est activée) sont affichées
   *  après, par ordre alphabétique, et ne sont pas déplaçables (rien à
   *  persister pour elles). */
  categoryOrder?: CategoryOrderEntry[];
}) {
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

      {/* ——— Rubriques en colonnes avec filets verticaux ———
          Note : pas de "divide-x" ici. Cette classe ajoute un filet à
          gauche de chaque colonne sauf la 1ère du DOM, sans tenir compte
          des retours à la ligne de la grille (2 col en md, 4 en lg) — le
          filet réapparaît alors à gauche de la 1ère colonne de la rangée
          suivante au lieu de rester à droite. Les filets sont donc posés
          directement dans CategoryColumn, calculés par position réelle
          dans la rangée (nth-child) pour chaque taille d'écran. */}
      <CategoryGrid
        initialCategories={categories.map((cat) => ({
          label: cat,
          freshrssId: idByLabel.get(cat) ?? null,
          articles: byCategory.get(cat)!
        }))}
      />

      {/* Cul-de-lampe de fin d'édition */}
      <p className="mt-14 text-center text-xl tracking-[0.5em] text-sepia">❦ ❦ ❦</p>
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
