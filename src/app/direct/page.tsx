import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { DirectView } from "@/components/DirectView";

export const dynamic = "force-dynamic";

export default async function DirectPage() {
  // Même agrégation que la page d'accueil : on ne filtre pas sur l'édition
  // du jour, sinon toute catégorie sans nouveauté aujourd'hui apparaît vide
  // et tout ce qui a été aspiré hier disparaît dès minuit. On prend les
  // articles les plus récents toutes éditions confondues ; EditionView
  // plafonne déjà à 20 par catégorie.
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
      <DirectView initialArticles={articles} categoryOrder={categoryOrder} />
    </main>
  );
}
