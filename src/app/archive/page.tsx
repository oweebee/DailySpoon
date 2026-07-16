import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { SpoonDivider } from "@/components/SpoonDivider";
import { ArchiveSearch } from "@/components/ArchiveSearch";

export const dynamic = "force-dynamic";

const MONTH_LABELS = [
  "Janvier",
  "Février",
  "Mars",
  "Avril",
  "Mai",
  "Juin",
  "Juillet",
  "Août",
  "Septembre",
  "Octobre",
  "Novembre",
  "Décembre"
];

/**
 * Liste des jours archivés = exactement les jours où une impression IA a
 * laissé au moins un article qualifiant (included + aiRewritten + catégorie
 * toujours activée pour "Impression IA") — pas tous les jours où une édition
 * existe. Naturellement bornée par la rétention configurée : un jour dont
 * tous les articles ont été purgés (favoris exclus) disparaît de lui-même de
 * cette liste, sans logique de rétention séparée à maintenir ici.
 *
 * Navigation par année/mois (années et mois cliquables en haut, défaut =
 * mois/année en cours), pas de vue "En direct" ici — pour retrouver un
 * article brut d'un jour donné, on passe par /direct + la recherche datée,
 * volontairement pas par ici.
 */
export default async function ArchivePage({
  searchParams
}: {
  searchParams: { year?: string; month?: string };
}) {
  const disabledCategories = await prisma.selectedCategory.findMany({
    where: { frontPageEnabled: false },
    select: { label: true }
  });
  const disabledLabels = disabledCategories.map((c) => c.label);

  const grouped = await prisma.article.groupBy({
    by: ["editionId"],
    where: {
      processed: true,
      included: true,
      aiRewritten: true,
      editionId: { not: null },
      ...(disabledLabels.length > 0 ? { NOT: { categoryLabel: { in: disabledLabels } } } : {})
    },
    _count: { _all: true }
  });

  const countByEditionId = new Map(grouped.map((g) => [g.editionId as string, g._count._all]));
  const qualifyingIds = [...countByEditionId.keys()];

  const editions =
    qualifyingIds.length > 0
      ? await prisma.edition.findMany({
          where: { id: { in: qualifyingIds }, status: "published" },
          orderBy: { date: "desc" }
        })
      : [];

  const entries = editions.map((e) => ({
    key: e.date.toISOString().slice(0, 10),
    date: e.date,
    year: e.date.getUTCFullYear(),
    month: e.date.getUTCMonth(), // 0-indexé
    count: countByEditionId.get(e.id) ?? 0
  }));

  const now = new Date();
  const currentYear = now.getUTCFullYear();
  const currentMonth = now.getUTCMonth();

  const years = [...new Set(entries.map((e) => e.year))].sort((a, b) => b - a);

  const yearParam = searchParams.year ? parseInt(searchParams.year, 10) : NaN;
  const selectedYear = years.includes(yearParam) ? yearParam : years.includes(currentYear) ? currentYear : years[0];

  const monthsInYear = [...new Set(entries.filter((e) => e.year === selectedYear).map((e) => e.month))].sort(
    (a, b) => a - b
  );

  const monthParam = searchParams.month ? parseInt(searchParams.month, 10) - 1 : NaN;
  const selectedMonth = monthsInYear.includes(monthParam)
    ? monthParam
    : selectedYear === currentYear && monthsInYear.includes(currentMonth)
      ? currentMonth
      : monthsInYear[monthsInYear.length - 1];

  const editionsInMonth = entries
    .filter((e) => e.year === selectedYear && e.month === selectedMonth)
    .sort((a, b) => (a.key < b.key ? 1 : -1));

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={new Date()} />
      <h1 className="mb-8 text-center font-display text-3xl font-black uppercase tracking-[0.2em]">Archives</h1>

      <ArchiveSearch />

      {years.length === 0 ? (
        <p className="py-8 text-center italic text-sepia">Aucune édition archivée pour l’instant.</p>
      ) : (
        <>
          {/* ——— Nav années/mois, cliquable, façon onglets de reliure. */}
          <div className="mb-4 flex flex-wrap justify-center gap-2">
            {years.map((y) => (
              <Link
                key={y}
                href={`/archive?year=${y}`}
                className={`border px-3 py-1 font-display text-sm uppercase tracking-[0.1em] transition-colors ${
                  y === selectedYear
                    ? "border-ink bg-ink text-paper"
                    : "border-ink/40 text-ink hover:border-ink"
                }`}
              >
                {y}
              </Link>
            ))}
          </div>
          <div className="mb-8 flex flex-wrap justify-center gap-2 border-b-2 border-ink pb-6">
            {monthsInYear.map((m) => (
              <Link
                key={m}
                href={`/archive?year=${selectedYear}&month=${m + 1}`}
                className={`border px-2.5 py-1 text-xs uppercase tracking-[0.1em] transition-colors ${
                  m === selectedMonth
                    ? "border-journal bg-journal text-paper"
                    : "border-ink/30 text-sepia hover:border-ink hover:text-ink"
                }`}
              >
                {MONTH_LABELS[m]}
              </Link>
            ))}
          </div>

          <ul className="border-t-2 border-ink">
            {editionsInMonth.map((entry) => {
              const label = new Intl.DateTimeFormat("fr-FR", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
              }).format(entry.date);
              return (
                <li key={entry.key} className="flex items-baseline justify-between border-b border-ink/30 py-3">
                  <Link href={`/archive/${entry.key}`} className="font-display text-lg capitalize hover:underline">
                    {label}
                  </Link>
                  <span className="text-sm italic text-sepia">
                    {entry.count} article{entry.count > 1 ? "s" : ""}
                  </span>
                </li>
              );
            })}
            {editionsInMonth.length === 0 && (
              <li className="py-8 text-center italic text-sepia">Aucune édition ce mois-ci.</li>
            )}
          </ul>
        </>
      )}

      <SpoonDivider />
    </main>
  );
}
