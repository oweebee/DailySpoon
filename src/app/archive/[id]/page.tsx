import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FrontPageView } from "@/components/FrontPageView";

export const dynamic = "force-dynamic";

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
      </p>
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
