import { prisma } from "@/lib/prisma";
import { Masthead } from "@/components/Masthead";
import { DirectView } from "@/components/DirectView";
import { getSettings } from "@/lib/settings";

export const dynamic = "force-dynamic";

export default async function DirectPage() {
  const { freshrssEnabled } = await getSettings();

  // Même agrégation que la page d'accueil : on ne filtre pas sur l'édition
  // du jour, sinon toute catégorie sans nouveauté aujourd'hui apparaît vide
  // et tout ce qui a été aspiré hier disparaît dès minuit. On prend les
  // articles les plus récents toutes éditions confondues ; EditionView ne
  // plafonne plus par catégorie (l'encart "Afficher plus d'articles" sur
  // desktop défile en interne dans tout ce qui est chargé ici).
  //
  // FreshRSS désactivé (voir /admin/settings) : les articles FreshRSS déjà
  // en base restent en base (pour la recherche, /api/articles/search, qui
  // interroge la table sans ce filtre) mais n'apparaissent plus ici — sur
  // demande explicite, pour ne pas mélanger du contenu "figé" (plus jamais
  // rafraîchi tant que c'est désactivé) avec les flux perso toujours actifs.
  // Un article FreshRSS a un feedId = item.origin.streamId (voir
  // fetchNewItemsFromSelectedCategories) ; un article de flux perso a
  // toujours un feedId préfixé "custom-feed:" (voir customFeedFreshrssId) —
  // feedId null (rare, cas dégradé) reste affiché par prudence, plutôt que
  // de risquer de cacher un article dont l'origine est ambiguë.
  const [latestEdition, articles, selectedCategories] = await Promise.all([
    // "generatedAt" en second critère : plusieurs éditions peuvent désormais
    // partager la même date (une par régénération), sinon l'ordre entre
    // elles n'est pas garanti et le masthead pourrait afficher une date
    // correcte mais issue d'une édition qui n'est pas vraiment la dernière.
    prisma.edition.findFirst({ orderBy: [{ date: "desc" }, { generatedAt: "desc" }] }),
    prisma.article.findMany({
      where: {
        processed: true,
        included: true,
        ...(freshrssEnabled ? {} : { OR: [{ feedId: null }, { feedId: { startsWith: "custom-feed:" } }] })
      },
      orderBy: { publishedAt: "desc" },
      take: 1000
    }),
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } })
  ]);
  const categoryOrder = selectedCategories.map((c) => ({ freshrssId: c.freshrssId, label: c.label }));
  const editionDate = latestEdition?.date ?? new Date();

  return (
    <main className="paper-panel mx-auto w-full lg:w-3/4 rounded-sm px-6 py-10 shadow-[0_10px_60px_-15px_rgba(26,26,26,0.35)] ring-1 ring-ink/10 md:px-10 md:py-14">
      {/* Masqué en mobile : chaque page du carrousel de colonnes (voir
          MobilePagedSection, via EditionView/CategoryGrid) y affiche sa
          propre copie du menu, donc ce Masthead unique ne reste utile qu'en
          desktop/tablette. */}
      <div className="hidden md:block">
        <Masthead date={editionDate} />
      </div>
      {/* Preuve visuelle que le filtre ci-dessus tourne bien avec la
          version de code actuellement déployée (sert aussi à diagnostiquer
          un doute sur un déploiement pas encore pris en compte) — pas
          seulement un message de debug : utile en soi pour comprendre
          pourquoi certaines rubriques semblent vides après désactivation. */}
      {!freshrssEnabled && (
        <p className="mb-4 text-center text-xs italic text-sepia">
          FreshRSS désactivé — seuls les articles de flux personnalisés (et les articles sans
          origine identifiée) sont affichés ici. {articles.length} article
          {articles.length > 1 ? "s" : ""} affiché{articles.length > 1 ? "s" : ""}.
        </p>
      )}
      <DirectView initialArticles={articles} categoryOrder={categoryOrder} date={editionDate} />
    </main>
  );
}
