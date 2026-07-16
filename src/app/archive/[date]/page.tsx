import Link from "next/link";
import { notFound } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FrontPageView } from "@/components/FrontPageView";

export const dynamic = "force-dynamic";

/**
 * Archive d'un jour donné : montre exactement la même chose que l'impression
 * IA du jour (FrontPageView), figée telle qu'elle était — pas un flux "En
 * direct" avec tous les articles bruts. Les archives "en direct" ne sont pas
 * consultables ici volontairement : on y retrouve un article via /direct
 * (recherche + date), pas via /archive, qui ne montre que le résultat de
 * l'impression du jour.
 */
export default async function ArchiveDatePage({ params }: { params: { date: string } }) {
  const date = new Date(`${params.date}T00:00:00.000Z`);
  if (isNaN(date.getTime())) notFound();

  const edition = await prisma.edition.findUnique({ where: { date } });
  if (!edition) notFound();

  const disabledCategories = await prisma.selectedCategory.findMany({
    where: { frontPageEnabled: false },
    select: { label: true }
  });
  const disabledLabels = disabledCategories.map((c) => c.label);

  const [articles, selectedCategories] = await Promise.all([
    prisma.article.findMany({
      where: {
        editionId: edition.id,
        processed: true,
        included: true,
        aiRewritten: true,
        ...(disabledLabels.length > 0 ? { NOT: { categoryLabel: { in: disabledLabels } } } : {})
      },
      orderBy: { publishedAt: "desc" }
    }),
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } })
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={edition.date} />
      <p className="mb-6 text-center text-xs uppercase tracking-[0.3em] text-sepia">
        <Link href="/archive" className="hover:underline">
          ← Retour aux archives
        </Link>
      </p>
      {articles.length > 0 ? (
        <FrontPageView articles={articles} categoryOrder={categoryOrder} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucun article IA disponible pour cette édition (rétention expirée ou aucune impression IA
          générée ce jour-là).
        </p>
      )}
    </main>
  );
}
