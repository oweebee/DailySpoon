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
  // schema.prisma et generateEdition.ts. Le contenu réel est sur
  // ArticleSnapshotContent (déduplication entre régénérations d'un même
  // jour), d'où le "include" ci-dessous.
  const snapshot = latestEdition
    ? await prisma.editionArticle.findMany({
        where: { editionId: latestEdition.id },
        include: { content: true },
        orderBy: { content: { publishedAt: "desc" } }
      })
    : [];

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
      {/* Compte d'articles affiché en permanence (pas seulement dans le
          message transitoire du bouton d'impression, qui peut ne jamais
          s'afficher si la requête traîne au-delà du timeout du proxy) —
          voir aussi /archive/[id] pour l'équivalent sur une édition passée. */}
      {latestEdition && articles.length > 0 && (
        <p className="mb-6 -mt-6 text-center text-xs uppercase tracking-[0.3em] text-sepia">
          {articles.length} article{articles.length > 1 ? "s" : ""}
        </p>
      )}
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
