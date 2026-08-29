// Page "Journal IA" — la "une" quotidienne, figée, produite par l'IA à
// l'impression. C'était l'accueil du site jusqu'à la V1 ; l'accueil est
// désormais "En direct" (voir src/app/page.tsx), qui est la page consultée au
// quotidien. Cette page-ci se rejoint par l'entrée "Journal IA" du menu.
import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { FrontPageView } from "@/components/FrontPageView";
import { PrintStampButton } from "@/components/PrintStampButton";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function JournalPage() {
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

  // Libellé du compte d'articles, calculé une fois : il s'affiche à DEUX
  // endroits selon la largeur — sur sa propre ligne en desktop, et à droite du
  // titre dans le bandeau compact du carrousel en PWA.
  const countLabel = (
    <>
      {articles.length} article{articles.length > 1 ? "s" : ""}
      {latestEdition?.sourcePoolCount != null && latestEdition.sourcePoolCount !== articles.length && (
        <> (sur {latestEdition.sourcePoolCount} récupéré{latestEdition.sourcePoolCount > 1 ? "s" : ""})</>
      )}
    </>
  );

  return (
    <main
      // "shell-sm" : coquille plein écran SOUS 640 px, seuil auquel le
      // carrousel mobile remplace les colonnes ici (l'accueil, lui, bascule à
      // 768 px — d'où deux variantes, voir globals.css).
      className="shell-sm paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-4 py-4 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 sm:px-6 sm:py-10 md:px-10 md:py-14">
      {/* Masqué en mobile : chaque page du carrousel de FrontPageView y
          affiche sa propre copie du menu (voir MobilePagedSection), donc ce
          Masthead unique ne reste utile qu'en desktop/tablette.
          Le timbre d'impression est passé en "action" : il s'affiche calé à
          droite sur la ligne du titre, au lieu de l'ancien gros bloc centré
          au-dessus du bandeau. Planning désactivé dans /admin/settings : pas
          de génération auto, donc on propose ce déclenchement manuel — sinon
          aucun timbre d'action, le worker s'en charge tout seul. */}
      <div className="hidden sm:block">
        <Masthead
          date={editionDate}
          action={
            settings.editionScheduleEnabled ? undefined : <PrintStampButton provider={settings.aiProvider} />
          }
        />
      </div>
      {/* Compte d'articles affiché en permanence (pas seulement dans le
          message transitoire du bouton d'impression, qui peut ne jamais
          s'afficher si la requête traîne au-delà du timeout du proxy) — avec
          le vivier de départ (avant plafond IA par catégorie) entre
          parenthèses quand il diffère du compte final retenu sur la une.
          Voir aussi /archive/[id] pour l'équivalent sur une édition passée.
          Masqué SOUS sm : en PWA, ce compte est affiché à droite du titre
          dans le bandeau du carrousel (voir titleAside plus bas) plutôt que
          sur une ligne à lui — le laisser ici aussi le ferait apparaître deux
          fois. */}
      {latestEdition && articles.length > 0 && (
        <p className="mb-3 hidden text-center text-xs uppercase tracking-[0.3em] text-sepia sm:mb-6 sm:-mt-6 sm:block">
          {countLabel}
        </p>
      )}
      {articles.length > 0 ? (
        <FrontPageView
          articles={articles}
          categoryOrder={categoryOrder}
          date={editionDate}
          mastheadAction={
            settings.editionScheduleEnabled ? undefined : <PrintStampButton provider={settings.aiProvider} />
          }
          mastheadTitleAside={
            latestEdition ? (
              <span className="shrink-0 whitespace-nowrap text-[0.6rem] uppercase tracking-[0.2em] text-sepia">
                {countLabel}
              </span>
            ) : undefined
          }
        />
      ) : (
        <p className="py-24 text-center italic text-sepia">
          Aucune édition générée pour l’instant. Sélectionne des catégories FreshRSS dans l’admin
          puis lance une génération.
        </p>
      )}
    </main>
  );
}
