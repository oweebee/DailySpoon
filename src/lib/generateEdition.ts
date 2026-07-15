import { prisma } from "./prisma";
import { fetchNewItemsFromSelectedCategories } from "./freshrss";
import { processArticles } from "./ai";

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
export async function generateDailyEdition() {
  const date = todayDateOnly();

  const edition = await prisma.edition.upsert({
    where: { date },
    update: {},
    create: { date, status: "draft" }
  });

  const rawItems = await fetchNewItemsFromSelectedCategories();
  console.log(`[edition] Fetched ${rawItems.length} new items from FreshRSS.`);

  if (rawItems.length === 0 && (await prisma.article.count({ where: { editionId: edition.id } })) === 0) {
    console.log("[edition] No new items and no existing articles — leaving edition as draft.");
    return { editionId: edition.id, articleCount: 0 };
  }

  const processed = rawItems.length > 0 ? await processArticles(rawItems) : [];

  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const ai = processed[i];

    await prisma.article.upsert({
      where: { freshrssItemId: raw.freshrssItemId },
      update: {},
      create: {
        freshrssItemId: raw.freshrssItemId,
        feedTitle: raw.feedTitle,
        categoryLabel: raw.categoryLabel,
        sourceUrl: raw.sourceUrl,
        sourceTitle: raw.sourceTitle,
        sourceExcerpt: raw.sourceExcerpt,
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
