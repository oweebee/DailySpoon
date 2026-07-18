import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { SpoonDivider } from "@/components/SpoonDivider";
import { ArchiveSearch } from "@/components/ArchiveSearch";
import { usdToEur } from "@/lib/aiPricing";

export const dynamic = "force-dynamic";

// Étiquettes lisibles pour les tags affichés sous chaque édition archivée.
// "random" n'apparaît jamais ici : Edition.writingStyle stocke toujours la
// valeur déjà RÉSOLUE par resolveWritingStyle (src/lib/ai.ts), jamais le
// méta-choix "random" tel quel.
const WRITING_STYLE_LABELS: Record<string, string> = {
  normal: "Normal",
  ackboo: "Ackboo",
  darksasuke: "Dark Sasuke"
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Claude",
  gemini: "Gemini"
};

function formatCost(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

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
 * Liste des éditions archivées = exactement les générations qui ont laissé
 * au moins un article figé dans EditionArticle (voir generateEdition.ts —
 * déjà filtré à l'écriture sur included + aiRewritten + catégorie toujours
 * activée pour "Impression IA", donc un simple count suffit ici). Plusieurs
 * générations peuvent désormais partager le même jour calendaire (chaque
 * régénération est conservée, pas seulement la dernière) — chacune apparaît
 * comme sa propre entrée dans la liste, pas regroupée par jour.
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
  const grouped = await prisma.editionArticle.groupBy({
    by: ["editionId"],
    _count: { _all: true }
  });

  const countByEditionId = new Map(grouped.map((g) => [g.editionId, g._count._all]));
  const qualifyingIds = [...countByEditionId.keys()];

  const editions =
    qualifyingIds.length > 0
      ? await prisma.edition.findMany({
          where: { id: { in: qualifyingIds }, status: "published" },
          orderBy: [{ date: "desc" }, { generatedAt: "desc" }]
        })
      : [];

  const entries = editions.map((e) => ({
    key: e.id,
    date: e.date,
    generatedAt: e.generatedAt,
    year: e.date.getUTCFullYear(),
    month: e.date.getUTCMonth(), // 0-indexé
    count: countByEditionId.get(e.id) ?? 0,
    aiProvider: e.aiProvider,
    aiModel: e.aiModel,
    writingStyle: e.writingStyle,
    inputTokens: e.inputTokens,
    outputTokens: e.outputTokens,
    estimatedCostUsd: e.estimatedCostUsd
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
    .sort((a, b) => b.generatedAt.getTime() - a.generatedAt.getTime());

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
              const dayLabel = new Intl.DateTimeFormat("fr-FR", {
                weekday: "long",
                day: "numeric",
                month: "long",
                year: "numeric"
              }).format(entry.date);
              // Heure de génération — plusieurs éditions peuvent partager le
              // même jour désormais, c'est ce qui les distingue à l'affichage.
              const timeLabel = new Intl.DateTimeFormat("fr-FR", {
                timeZone: "Europe/Paris",
                hour: "2-digit",
                minute: "2-digit",
                hourCycle: "h23"
              }).format(entry.generatedAt);
              const modelTag =
                entry.aiProvider && entry.aiModel
                  ? `${PROVIDER_LABELS[entry.aiProvider] || entry.aiProvider} · ${entry.aiModel}`
                  : null;
              const styleTag = entry.writingStyle
                ? WRITING_STYLE_LABELS[entry.writingStyle] || entry.writingStyle
                : null;
              const tokensTotal =
                entry.inputTokens !== null && entry.outputTokens !== null
                  ? entry.inputTokens + entry.outputTokens
                  : null;
              const costTag =
                tokensTotal !== null && entry.estimatedCostUsd !== null
                  ? `${tokensTotal.toLocaleString("fr-FR")} tokens (≈${formatCost(usdToEur(entry.estimatedCostUsd))} €)`
                  : null;

              return (
                <li key={entry.key} className="border-b border-ink/30 py-3">
                  <div className="flex items-baseline justify-between">
                    <Link href={`/archive/${entry.key}`} className="font-display text-lg capitalize hover:underline">
                      {dayLabel} <span className="text-sm normal-case text-sepia">— {timeLabel}</span>
                    </Link>
                    <span className="text-sm italic text-sepia">
                      {entry.count} article{entry.count > 1 ? "s" : ""}
                    </span>
                  </div>
                  {(modelTag || styleTag || costTag) && (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {modelTag && (
                        <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                          {modelTag}
                        </span>
                      )}
                      {styleTag && (
                        <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                          Style : {styleTag}
                        </span>
                      )}
                      {costTag && (
                        <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
                          {costTag}
                        </span>
                      )}
                    </div>
                  )}
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
