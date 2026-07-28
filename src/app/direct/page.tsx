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
  // Un article de flux perso a TOUJOURS un feedId préfixé "custom-feed:"
  // (voir customFeedFreshrssId / customFeeds.ts, feedId jamais null pour eux)
  // — c'est le SEUL marqueur fiable d'un article perso, donc on ne garde QUE
  // ceux-là. Tout le reste (feedId FreshRSS, ou feedId null quand
  // item.origin.streamId manquait à l'ingestion) est du FreshRSS et doit
  // disparaître : un feedId null n'est jamais un flux perso, l'inclure "par
  // prudence" laissait justement passer tous les vieux articles FreshRSS.
  // Filtre commun à toutes les requêtes d'articles ci-dessous : voir plus haut
  // (FreshRSS désactivé -> uniquement les flux perso "custom-feed:").
  const feedFilter = freshrssEnabled ? {} : { feedId: { startsWith: "custom-feed:" } };

  const [latestEdition, selectedCategories, distinctLabels] = await Promise.all([
    // "generatedAt" en second critère : plusieurs éditions peuvent désormais
    // partager la même date (une par régénération), sinon l'ordre entre
    // elles n'est pas garanti et le masthead pourrait afficher une date
    // correcte mais issue d'une édition qui n'est pas vraiment la dernière.
    prisma.edition.findFirst({ orderBy: [{ date: "desc" }, { generatedAt: "desc" }] }),
    prisma.selectedCategory.findMany({ orderBy: { order: "asc" } }),
    // Les LIBELLÉS de catégorie distincts présents parmi les articles à
    // afficher — pour ensuite récupérer les plus récents CATÉGORIE PAR
    // CATÉGORIE (voir plus bas).
    prisma.article.findMany({
      where: { processed: true, included: true, ...feedFilter },
      select: { categoryLabel: true },
      distinct: ["categoryLabel"]
    })
  ]);

  // Récupération des plus récents PAR CATÉGORIE plutôt qu'un plafond global.
  // Avant, un simple `take: 1000` trié par date toutes catégories confondues
  // coupait la queue la plus ancienne — et une catégorie qui publie moins vite
  // (ex. un journal scientifique dont le dernier article date de plusieurs
  // jours) voyait TOUS ses articles tomber hors de ces 1000, donc disparaissait
  // ENTIÈREMENT d'« En direct » alors que ses articles étaient bien inclus (bug
  // "catégorie Science absente", constaté avec 1288 articles inclus > 1000).
  // Ici chaque catégorie est garantie représentée par ses propres articles
  // récents, quelle que soit sa cadence de publication. Le plafond par
  // catégorie reste large (bien au-delà de ce qu'une colonne affiche, même
  // déroulée) — c'est juste un garde-fou de volume, pas une curation.
  const PER_CATEGORY_LIMIT = 250;
  const perCategory = await Promise.all(
    distinctLabels.map((row) =>
      prisma.article.findMany({
        where: { processed: true, included: true, ...feedFilter, categoryLabel: row.categoryLabel },
        orderBy: { publishedAt: "desc" },
        take: PER_CATEGORY_LIMIT
      })
    )
  );
  const articles = perCategory.flat();
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
      <DirectView initialArticles={articles} categoryOrder={categoryOrder} date={editionDate} />
    </main>
  );
}
