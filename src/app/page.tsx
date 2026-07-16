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
  //
  // Plusieurs éditions peuvent désormais partager la même date (chaque
  // régénération est conservée séparément) : trier uniquement par "date"
  // laissait l'ordre entre elles indéfini en cas d'égalité, et pouvait donc
  // faire remonter une édition vide/plus ancienne du même jour au lieu de la
  // toute dernière — d'où "generatedAt" en second critère, et le filtre sur
  // "published" pour ignorer les brouillons vides (rien de neuf à récupérer
  // ce jour-là, aucun article qualifiant...).
  const latestEdition = await prisma.edition.findFirst({
    where: { status: "published" },
    orderBy: [{ date: "desc" }, { generatedAt: "desc" }]
  });

  const [selectedCategories, settings] = await Promise.all([
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } }),
    getSettings()
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));

  // La une lit désormais la photo figée (EditionArticle) de cette édition,
  // pas la table Article "vivante" : Article.editionId pointe seulement vers
  // la DERNIÈRE édition ayant touché cet article, et serait donc réattribué
  // (voire vidé) dès la génération suivante si on continuait à s'en servir
  // ici. EditionArticle ne change plus jamais après coup — voir
  // schema.prisma et generateEdition.ts.
  const snapshot = latestEdition
    ? await prisma.editionArticle.findMany({
        where: { editionId: latestEdition.id },
        orderBy: { publishedAt: "desc" }
      })
    : [];

  const articles = snapshot.map((a) => ({
    id: a.id,
    headline: a.headline,
    summary: a.summary,
    frontPageSummary: a.frontPageSummary,
    category: a.category,
    priorityScore: a.priorityScore,
    sourceUrl: a.sourceUrl,
    sourceTitle: a.sourceTitle,
    feedTitle: a.feedTitle,
    imageUrl: a.imageUrl,
    publishedAt: a.publishedAt,
    favorite: false,
    medal: a.medal
  }));

  const editionDate = latestEdition?.date ?? new Date();

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      {/* Masqué en mobile : chaque page du carrousel de FrontPageView y
          affiche sa propre copie du menu (voir MobilePagedSection), donc ce
          Masthead unique ne reste utile qu'en desktop/tablette. */}
      <div className="hidden sm:block">
        <Masthead date={editionDate} />
      </div>
      {/* Planning désactivé dans /admin/settings : pas de génération auto,
          donc on donne un bouton pour lancer l'impression à la main. */}
      {!settings.editionScheduleEnabled && <PrintStampButton provider={settings.aiProvider} />}
      {articles.length > 0 ? (
        <FrontPageView articles={articles} categoryOrder={categoryOrder} date={editionDate} />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucune édition générée pour l’instant. Sélectionne des catégories FreshRSS dans l’admin
          puis lance une génération.
        </p>
      )}
    </main>
  );
}
