import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories } from "./freshrss";
import { processArticles } from "./ai";
import { stripHtml, looksLikeHtml, extractFirstImageSrc } from "./text";

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
 * One-off retroactive fix: articles fetched before stripHtml() existed still
 * have raw HTML (tables, <img>, tracking links) sitting in their text
 * fields. Clean them in place on every generation run instead of requiring
 * a manual wipe-and-refetch. Checked across every article in the DB (not
 * just the edition being generated today) since the site now shows recent
 * articles across all editions, not just today's.
 */
async function cleanExistingHtmlArtifacts(): Promise<void> {
  const candidates = await prisma.article.findMany({
    select: {
      id: true,
      sourceTitle: true,
      sourceExcerpt: true,
      headline: true,
      summary: true,
      imageUrl: true
    }
  });

  for (const article of candidates) {
    const dirty =
      looksLikeHtml(article.sourceTitle) ||
      looksLikeHtml(article.sourceExcerpt) ||
      looksLikeHtml(article.headline) ||
      looksLikeHtml(article.summary);

    // Backfill the illustration for articles fetched before imageUrl
    // existed, extracted from the still-dirty excerpt before it gets
    // stripped below.
    const backfilledImage = !article.imageUrl ? extractFirstImageSrc(article.sourceExcerpt) : null;

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
    console.log(`[edition] Checked ${candidates.length} existing article(s) for leftover HTML.`);
  }
}
