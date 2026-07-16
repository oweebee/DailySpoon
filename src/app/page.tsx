import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { EditionView } from "@/components/EditionView";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // Le journal ne doit pas se limiter aux articles de l'édition du jour :
  // chaque jour calendaire crée une nouvelle Edition, donc si on filtrait par
  // une seule édition, tout ce qui a été aspiré la veille (ou avant)
  // disparaissait de la page dès minuit. On agrège plutôt les articles les
  // plus récents toutes éditions confondues ; EditionView se charge déjà de
  // plafonner à 20 par catégorie.
  const [latestEdition, articles, selectedCategories] = await Promise.all([
    prisma.edition.findFirst({ orderBy: { date: "desc" } }),
    prisma.article.findMany({
      where: { processed: true, included: true },
      orderBy: { publishedAt: "desc" },
      take: 1000
    }),
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } })
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={latestEdition?.date ?? new Date()} />
      {articles.length > 0 ? (
        <EditionView articles={articles} categoryOrder={categoryOrder} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucune édition générée pour l’instant. Sélectionne des catégories FreshRSS dans l’admin
          puis lance une génération.
        </p>
      )}
    </main>
  );
}
