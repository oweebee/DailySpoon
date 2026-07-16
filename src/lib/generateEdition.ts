import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories, fetchOgImage, faviconFallback, type RawItem } from "./freshrss";
import { processArticles, fallbackProcess, curateFrontPage, type ProcessedArticle } from "./ai";
import { stripHtml, looksLikeHtml, extractFirstImageSrc } from "./text";
import { getSettings } from "./settings";

// Nombre max d'articles déjà en base pour lesquels on va chercher une
// og:image manquante à CHAQUE génération. Ça évite qu'une base avec des
// centaines d'articles sans image ne déclenche des centaines de requêtes
// réseau vers autant de sites différents d'un coup — le rattrapage se fait
// alors progressivement, sur plusieurs générations successives.
const MAX_OG_BACKFILL_PER_RUN = 25;

// Coût IA : au plus ce nombre d'articles inclus PAR CATÉGORIE FreshRSS (celles
// choisies dans /admin/categories, connues avant même de lancer l'IA) passent
// réellement par l'IA à chaque génération. Les articles inclus au-delà de ce
// plafond restent affichés (traitement brut fallbackProcess, catégorie
// FreshRSS d'origine, sans coût IA) plutôt que d'être exclus purement et
// simplement — ils ne disparaissent pas, ils ne sont juste pas réécrits/notés
// par l'IA ce jour-là.
const MAX_AI_ITEMS_PER_CATEGORY = 5;

function todayDateOnly(): Date {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

/**
 * Répartit les items inclus par catégorie FreshRSS (categoryLabel — connue
 * avant tout appel IA, indépendante de la rubrique que l'IA attribuera
 * ensuite) et ne garde que les `max` plus récents de chaque catégorie pour le
 * traitement IA ; le reste part dans overflowItems (traitement brut, sans
 * coût). Les items sans categoryLabel forment leur propre groupe ("Autre").
 */
function capPerCategory(items: RawItem[], max: number): { aiItems: RawItem[]; overflowItems: RawItem[] } {
  const byCategory = new Map<string, RawItem[]>();
  for (const item of items) {
    const key = item.categoryLabel || "Autre";
    if (!byCategory.has(key)) byCategory.set(key, []);
    byCategory.get(key)!.push(item);
  }

  const aiItems: RawItem[] = [];
  const overflowItems: RawItem[] = [];

  for (const group of byCategory.values()) {
    const sorted = [...group].sort((a, b) => {
      const ta = a.publishedAt ? new Date(a.publishedAt).getTime() : 0;
      const tb = b.publishedAt ? new Date(b.publishedAt).getTime() : 0;
      return tb - ta;
    });
    aiItems.push(...sorted.slice(0, max));
    overflowItems.push(...sorted.slice(max));
  }

  return { aiItems, overflowItems };
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

  // Seuls les articles "included" (flux non exclu, catégorie sélectionnée)
  // passent par l'IA (ou l'heuristique gratuite si pas de clé) — les autres
  // sont stockés avec un traitement brut systématique, sans jamais
  // consommer l'API payante, puisqu'ils ne sont de toute façon pas destinés
  // à être affichés dans l'édition normale (juste trouvables en recherche).
  const includedItems = rawItems.filter((r) => r.included);
  const hiddenItems = rawItems.filter((r) => !r.included);

  // Plafond de coût par catégorie : seuls les MAX_AI_ITEMS_PER_CATEGORY items
  // les plus récents de chaque catégorie FreshRSS partent réellement à l'IA ;
  // le reste (overflowItems) est quand même stocké et affiché, juste sans
  // réécriture IA (fallbackProcess), comme les articles non "included".
  const { aiItems, overflowItems } = capPerCategory(includedItems, MAX_AI_ITEMS_PER_CATEGORY);

  const processedAi = aiItems.length > 0 ? await processArticles(aiItems, options) : [];

  const resultByItemId = new Map<string, ProcessedArticle>();
  aiItems.forEach((raw, i) => resultByItemId.set(raw.freshrssItemId, processedAi[i]));
  overflowItems.forEach((raw) => resultByItemId.set(raw.freshrssItemId, fallbackProcess(raw)));
  hiddenItems.forEach((raw) => resultByItemId.set(raw.freshrssItemId, fallbackProcess(raw)));

  for (const raw of rawItems) {
    const ai = resultByItemId.get(raw.freshrssItemId)!;

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
        included: raw.included,
        headline: ai.headline,
        summary: ai.summary,
        category: ai.category,
        priorityScore: ai.priorityScore,
        editionId: edition.id
      }
    });
  }

  await syncMedalFlags();

  // Une passe IA dédiée, une seule fois par génération (jamais en mode
  // "Aspirer les news" sans IA) : recalcule priorityScore sur TOUS les
  // articles inclus de l'édition en les comparant vraiment entre eux,
  // plutôt que par lots isolés de 12 comme processArticles — c'est ce score
  // qui détermine ensuite les articles "à la une" sur la page d'accueil.
  if (!options.forceNoAi) {
    await curateFrontPageScores(edition.id);
  }

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
 * Purge les articles plus vieux que la rétention réglée dans
 * /admin/settings (6 mois à 5 ans, par défaut 2 ans ; 0 = illimité, aucune
 * purge), sur la date de publication d'origine (ou de récupération si elle
 * est inconnue). Les articles marqués favoris sont exclus de la purge, quel
 * que soit leur âge — un favori mis de côté ne doit jamais disparaître tout
 * seul.
 */
async function pruneOldArticles(): Promise<void> {
  const { retentionDays } = await getSettings();
  if (!retentionDays || retentionDays <= 0) return; // illimité

  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
  const { count } = await prisma.article.deleteMany({
    where: {
      favorite: false,
      OR: [{ publishedAt: { lt: cutoff } }, { publishedAt: null, fetchedAt: { lt: cutoff } }]
    }
  });
  if (count > 0) {
    console.log(`[edition] Rétention (${retentionDays} j) : ${count} article(s) purgé(s).`);
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
 * Demande à l'IA de définir les news marquantes de la journée : relit tous
 * les articles inclus de l'édition (déjà réécrits) EN UNE FOIS et leur
 * attribue un score d'importance cohérent sur l'ensemble du jour, plutôt que
 * le score par lot de 12 posé par processArticles. Silencieux et sans effet
 * si aucune clé IA n'est configurée pour le fournisseur choisi (curateFrontPage
 * renvoie alors une Map vide) — les scores existants restent tels quels.
 */
async function curateFrontPageScores(editionId: string): Promise<void> {
  // Carte "Impression IA" de /admin/categories : les catégories décochées là
  // ne doivent même pas être soumises à cette passe (ni affichées sur la une,
  // ni comparées aux autres) — inutile de dépenser des tokens dessus.
  const disabledCategories = await prisma.selectedCategory.findMany({
    where: { frontPageEnabled: false },
    select: { label: true }
  });
  const disabledLabels = disabledCategories.map((c) => c.label);

  const todaysArticles = await prisma.article.findMany({
    where: {
      editionId,
      included: true,
      processed: true,
      ...(disabledLabels.length > 0 ? { NOT: { categoryLabel: { in: disabledLabels } } } : {})
    },
    select: { id: true, headline: true, summary: true, category: true, feedTitle: true }
  });
  if (todaysArticles.length === 0) return;

  const scores = await curateFrontPage(
    todaysArticles.map((a) => ({
      id: a.id,
      headline: a.headline || "",
      summary: a.summary || "",
      category: a.category || "Autre",
      source: a.feedTitle || ""
    }))
  );
  if (scores.size === 0) return;

  await prisma.$transaction(
    [...scores.entries()].map(([id, result]) =>
      prisma.article.update({
        where: { id },
        data: { priorityScore: result.priorityScore, frontPageSummary: result.frontPageSummary }
      })
    )
  );
  console.log(`[edition] Une du jour recalculée par l'IA pour ${scores.size} article(s).`);
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
