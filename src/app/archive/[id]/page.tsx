import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FrontPageView } from "@/components/FrontPageView";
import { DeleteEditionButton } from "@/components/DeleteEditionButton";
import { usdToEur } from "@/lib/aiPricing";

export const dynamic = "force-dynamic";

// Voir /archive (liste) pour le même mapping — dupliqué ici volontairement
// plutôt qu'exporté/partagé : deux petites constantes, pas la peine d'un
// fichier commun pour ça.
const WRITING_STYLE_LABELS: Record<string, string> = {
  normal: "Normal",
  ackboo: "Ackboo",
  darksasuke: "Dark Sasuke"
};
const PROVIDER_LABELS: Record<string, string> = { anthropic: "Claude", gemini: "Gemini" };
function formatCost(n: number): string {
  return n < 0.01 ? n.toFixed(4) : n.toFixed(2);
}

/**
 * Archive d'une édition donnée (identifiée par son id, plus par sa date —
 * plusieurs générations peuvent désormais partager le même jour calendaire,
 * chacune conservée séparément) : montre exactement la même chose que
 * l'impression IA du jour (FrontPageView), figée telle qu'elle était au
 * moment de CETTE génération précise, via la photo figée EditionArticle
 * plutôt que la table Article "vivante" (qui, elle, ne garde qu'un pointeur
 * vers la DERNIÈRE édition ayant touché chaque article — voir
 * schema.prisma). Les archives "en direct" ne sont pas consultables ici
 * volontairement : on y retrouve un article brut via /direct (recherche +
 * date), pas via /archive, qui ne montre que le résultat d'une impression.
 */
export default async function ArchiveEditionPage({ params }: { params: { id: string } }) {
  const edition = await prisma.edition.findUnique({ where: { id: params.id } });
  if (!edition) notFound();

  const [snapshot, selectedCategories] = await Promise.all([
    // Le contenu réel est sur ArticleSnapshotContent (déduplication entre
    // régénérations d'un même jour), d'où le "include" ci-dessous.
    prisma.editionArticle.findMany({
      where: { editionId: edition.id },
      include: { content: true },
      orderBy: { content: { publishedAt: "desc" } }
    }),
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } })
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));

  const articles = snapshot.map((a) => ({
    id: a.id,
    headline: a.content.headline,
    summary: a.content.summary,
    frontPageSummary: a.content.frontPageSummary,
    category: a.content.category,
    priorityScore: a.content.priorityScore,
    sourceUrl: a.content.sourceUrl,
    sourceTitle: a.content.sourceTitle,
    feedTitle: a.content.feedTitle,
    imageUrl: a.content.imageUrl,
    publishedAt: a.content.publishedAt,
    favorite: false,
    medal: a.content.medal
  }));

  // Heure de génération affichée en plus de la date, pour distinguer les
  // éditions d'un même jour entre elles.
  const timeLabel = new Intl.DateTimeFormat("fr-FR", {
    timeZone: "Europe/Paris",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23"
  }).format(edition.generatedAt);

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      {/* Masqué en mobile : chaque page du carrousel de FrontPageView y
          affiche sa propre copie du menu (voir MobilePagedSection), donc ce
          Masthead unique ne reste utile qu'en desktop/tablette. */}
      <div className="hidden sm:block">
        <Masthead date={edition.date} />
      </div>
      <p className="mb-6 text-center text-xs uppercase tracking-[0.3em] text-sepia">
        <Link href="/archive" className="hover:underline">
          ← Retour aux archives
        </Link>
        {" · "}Édition de {timeLabel}
        {" · "}
        {articles.length} article{articles.length > 1 ? "s" : ""}
        {edition.sourcePoolCount != null && edition.sourcePoolCount !== articles.length && (
          <> (sur {edition.sourcePoolCount} récupéré{edition.sourcePoolCount > 1 ? "s" : ""})</>
        )}
        {" · "}
        <DeleteEditionButton
          editionId={edition.id}
          label={new Intl.DateTimeFormat("fr-FR", { dateStyle: "long" }).format(edition.date) + ` — ${timeLabel}`}
          redirectTo="/archive"
        />
      </p>
      {(edition.aiProvider || edition.writingStyle || (edition.inputTokens !== null && edition.estimatedCostUsd !== null)) && (
        <div className="mb-6 flex flex-wrap justify-center gap-1.5">
          {edition.aiProvider && edition.aiModel && (
            <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
              {(PROVIDER_LABELS[edition.aiProvider] || edition.aiProvider) + " · " + edition.aiModel}
            </span>
          )}
          {edition.writingStyle && (
            <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
              Style : {WRITING_STYLE_LABELS[edition.writingStyle] || edition.writingStyle}
            </span>
          )}
          {edition.inputTokens !== null && edition.outputTokens !== null && edition.estimatedCostUsd !== null && (
            <span className="rounded-sm border border-ink/30 px-1.5 py-0.5 text-[0.55rem] uppercase tracking-[0.15em] text-sepia">
              {(edition.inputTokens + edition.outputTokens).toLocaleString("fr-FR")} tokens (≈
              {formatCost(usdToEur(edition.estimatedCostUsd))} €)
            </span>
          )}
        </div>
      )}
      {articles.length > 0 ? (
        <FrontPageView articles={articles} categoryOrder={categoryOrder} date={edition.date} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucun article IA disponible pour cette édition (rétention expirée ou aucune impression IA
          générée ce jour-là).
        </p>
      )}
    </main>
  );
}
