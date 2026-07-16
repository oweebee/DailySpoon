import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories, fetchOgImage, faviconFallback } from "./freshrss";
import { processArticles } from "./ai";
import { stripHtml, looksLikeHtml, extractFirstImageSrc } from "./text";

// Nombre max d'articles déjà en base pour lesquels on va chercher une
// og:image manquante à CHAQUE génération. Ça évite qu'une base avec des
// centaines d'articles sans image ne déclenche des centaines de requêtes
// réseau vers autant de sites différents d'un coup — le rattrapage se fait
// alors progressivement, sur plusieurs générations successives.
const MAX_OG_BACKFILL_PER_RUN = 25;

// Rétention de l'historique (page "En direct", recherche, accueil — tout
// partage la même table Article) : 2 ans. Un article marqué favori n'est
// jamais purgé, quel que soit son âge.
const RETENTION_DAYS = 730;

function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Full daily pipeline: pull new items from the FreshRSS categories the user
 * selected, process them with AI (rewrite + categorize + prioritize), and
 * assemble today's edition. Safe to re-run the same day: new articles get
 * appended to the existing edition and the hero headline is recomputed.
 */
export async function generateDailyEdition(options: { forceNoAi?: boolean } = {}) {
  const date = todayDateOnly();

  const edition = await prisma.edition.upsert({
    where: { date },
    update: {},
    create: { date, status: "draft" }
  });

  await cleanExistingHtmlArtifacts();
  await pruneOldArticles();

  const rawItems = await fetchNewItemsFromSelectedCategories();
  console.log(`[edition] Fetched ${rawItems.length} new items from FreshRSS.`);

  if (rawItems.length === 0 && (await prisma.article.count({ where: { editionId: edition.id } })) === 0) {
    console.log("[edition] No new items and no existing articles — leaving edition as draft.");
    return { editionId: edition.id, articleCount: 0 };
  }

  const processed = rawItems.length > 0 ? await processArticles(rawItems, options) : [];

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const ai = processed[i];

    await prisma.article.upsert({
      where: { freshrssItemId: raw.freshrssItemId },
      update: {},
      create: {
        freshrssItemId: raw.freshrssItemId,
        feedId: raw.feedId,
        feedTitle: raw.feedTitle,
        categoryLabel: raw.categoryLabel,
        sourceUrl: raw.sourceUrl,
        sourceTitle: raw.sourceTitle,
        sourceExcerpt: raw.sourceExcerpt,
        imageUrl: raw.imageUrl,
        publishedAt: raw.publishedAt,
        processed: true,
        headline: ai.headline,
        summary: ai.summary,
        category: ai.category,
        priorityScore: ai.priorityScore,
        editionId: edition.id
      }
    });
  }

  await syncMedalFlags();

  const heroArticle = await prisma.article.findFirst({
    where: { editionId: edition.id },
    orderBy: { priorityScore: "desc" }
  });

  const articleCount = await prisma.article.count({ where: { editionId: edition.id } });

  await prisma.edition.update({
    where: { id: edition.id },
    data: {
      headline: heroArticle?.headline ?? edition.headline,
      status: articleCount > 0 ? "published" : "draft"
    }
  });

  console.log(`[edition] Edition ${date.toISOString().slice(0, 10)} ready with ${articleCount} articles.`);

  return { editionId: edition.id, articleCount };
}

/**
 * Purge les articles plus vieux que RETENTION_DAYS (2 ans), sur la date de
 * publication d'origine (ou de récupération si elle est inconnue). Les
 * articles marqués favoris sont exclus de la purge, quel que soit leur âge —
 * un favori mis de côté ne doit jamais disparaître tout seul.
 */
async function pruneOldArticles(): Promise<void> {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const { count } = await prisma.article.deleteMany({
    where: {
      favorite: false,
      OR: [{ publishedAt: { lt: cutoff } }, { publishedAt: null, fetchedAt: { lt: cutoff } }]
    }
  });
  if (count > 0) {
    console.log(`[edition] Rétention (${RETENTION_DAYS} j) : ${count} article(s) purgé(s).`);
  }
}

/**
 * Réconcilie Article.medal avec la liste des flux "médaillés" réglée dans
 * /admin/categories. Recalculé à chaque génération (pas seulement au moment
 * du toggle admin, qui le fait déjà pour les articles déjà en base) pour
 * couvrir aussi les articles insérés juste avant dans cette même run.
 *
 * Le rapprochement se fait par feedId, mais certains articles plus anciens
 * n'en ont pas (champ ajouté après coup, ou absent de la réponse FreshRSS
 * pour ce flux) — on les rattrape par titre de flux, comme pour l'exclusion
 * de flux (ExcludedFeed) qui a le même souci.
 */
async function syncMedalFlags(): Promise<void> {
  const medalFeeds = await prisma.medalFeed.findMany({ select: { freshrssId: true, label: true } });
  const medalFeedIds = medalFeeds.map((f) => f.freshrssId);
  const medalTitles = medalFeeds.map((f) => f.label);

  const matchCondition = {
    OR: [{ feedId: { in: medalFeedIds } }, { feedId: null, feedTitle: { in: medalTitles } }]
  };

  await prisma.article.updateMany({
    where: { AND: [matchCondition, { medal: false }] },
    data: { medal: true }
  });
  await prisma.article.updateMany({
    where: { medal: true, NOT: matchCondition },
    data: { medal: false }
  });
}

/**
 * One-off retroactive fix: articles fetched before stripHtml() existed still
 * have raw HTML (tables, <img>, tracking links) sitting in their text
 * fields. Clean them in place on every generation run instead of requiring
 * a manual wipe-and-refetch. Checked across every article in the DB (not
 * just the edition being generated today) since the site now shows recent
 * articles across all editions, not just today's.
 *
 * Sert aussi de rattrapage pour l'illustration : les articles stockés avant
 * que l'extraction d'image existe (ou dont le flux n'en fournissait aucune
 * à l'époque) sont maintenant retentés — d'abord depuis le HTML déjà en
 * base, puis via og:image sur la page source si besoin (plafonné par
 * MAX_OG_BACKFILL_PER_RUN pour ne pas déclencher une rafale de requêtes).
 */
async function cleanExistingHtmlArtifacts(): Promise<void> {
  const candidates = await prisma.article.findMany({
    select: {
      id: true,
      sourceTitle: true,
      sourceExcerpt: true,
      sourceUrl: true,
      headline: true,
      summary: true,
      imageUrl: true
    }
  });

  let ogBackfillsUsed = 0;

  for (const article of candidates) {
    const dirty =
      looksLikeHtml(article.sourceTitle) ||
      looksLikeHtml(article.sourceExcerpt) ||
      looksLikeHtml(article.headline) ||
      looksLikeHtml(article.summary);

    // Backfill the illustration for articles fetched before imageUrl
    // existed, extracted from the still-dirty excerpt before it gets
    // stripped below.
    let backfilledImage = !article.imageUrl ? extractFirstImageSrc(article.sourceExcerpt) : null;

    // Toujours rien trouvé dans le HTML déjà stocké — og:image sur la page
    // source, avec un plafond par run (vraie requête réseau sortante).
    if (!article.imageUrl && !backfilledImage && article.sourceUrl && ogBackfillsUsed < MAX_OG_BACKFILL_PER_RUN) {
      ogBackfillsUsed++;
      backfilledImage = await fetchOgImage(article.sourceUrl);
    }

    // Toujours rien — favicon du site en dernier recours (pas de requête
    // réseau de notre côté, juste une URL construite, donc pas de plafond
    // nécessaire ici : tous les articles restants sont couverts d'un coup).
    if (!article.imageUrl && !backfilledImage && article.sourceUrl) {
      backfilledImage = faviconFallback(article.sourceUrl);
    }

    if (!dirty && !backfilledImage) continue;

    await prisma.article.update({
      where: { id: article.id },
      data: {
        sourceTitle: article.sourceTitle ? stripHtml(article.sourceTitle) : article.sourceTitle,
        sourceExcerpt: article.sourceExcerpt ? stripHtml(article.sourceExcerpt) : article.sourceExcerpt,
        headline: article.headline ? stripHtml(article.headline) : article.headline,
        summary: article.summary ? stripHtml(article.summary) : article.summary,
        imageUrl: article.imageUrl ?? backfilledImage ?? undefined
      }
    });
  }

  if (candidates.length > 0) {
    console.log(
      `[edition] Checked ${candidates.length} existing article(s) for leftover HTML` +
        (ogBackfillsUsed > 0 ? ` (${ogBackfillsUsed} og:image lookup(s) attempted).` : ".")
    );
  }
}
