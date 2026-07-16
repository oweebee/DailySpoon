import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FrontPageView } from "@/components/FrontPageView";
import { PrintStampButton } from "@/components/PrintStampButton";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  // La une ne montre QUE les articles de la dernière impression (l'édition
  // la plus récente) — pas un flot glissant toutes éditions confondues comme
  // avant. Elle reste donc figée telle quelle jusqu'à la prochaine
  // impression, plutôt que de bouger toute seule au fil des aspirations en
  // arrière-plan.
  const latestEdition = await prisma.edition.findFirst({ orderBy: { date: "desc" } });

  const [selectedCategories, settings] = await Promise.all([
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } }),
    getSettings()
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));

  // Carte "Impression IA" de /admin/categories : les catégories décochées là
  // (frontPageEnabled = false) restent visibles ailleurs (En direct,
  // recherche) mais n'apparaissent jamais sur la une générée par IA.
  const frontPageDisabledLabels = selectedCategories.filter((c) => !c.frontPageEnabled).map((c) => c.label);

  const articles = latestEdition
    ? await prisma.article.findMany({
        where: {
          editionId: latestEdition.id,
          processed: true,
          included: true,
          ...(frontPageDisabledLabels.length > 0
            ? { NOT: { categoryLabel: { in: frontPageDisabledLabels } } }
            : {})
        },
        orderBy: { publishedAt: "desc" }
      })
    : [];

  return (
    <main className="mx-auto w-full lg:w-3/4 rounded-sm bg-paper/70 px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      <Masthead date={latestEdition?.date ?? new Date()} />
      {/* Planning désactivé dans /admin/settings : pas de génération auto,
          donc on donne un bouton pour lancer l'impression à la main. */}
      {!settings.editionScheduleEnabled && <PrintStampButton provider={settings.aiProvider} />}
      {articles.length > 0 ? (
        <FrontPageView articles={articles} categoryOrder={categoryOrder} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucune édition générée pour l’instant. Sélectionne des catégories FreshRSS dans l’admin
          puis lance une génération.
        </p>
      )}
    </main>
  );
}
