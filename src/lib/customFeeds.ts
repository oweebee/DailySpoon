import Parser from "rss-parser";
import { prisma } from "./prisma";
import { getSettings } from "./settings";
import { stripHtml, extractFirstImageSrc, stripLeadingChrome } from "./text";
import { fetchOgImage, faviconFallback, type RawItem } from "./freshrss";
import { ingestRawItems } from "./generateEdition";

/**
 * Flux RSS/Atom ajoutés à la main depuis /admin/categories (CustomFeed),
 * SANS passer par FreshRSS — utile pour un flux qu'on ne veut pas gérer
 * côté FreshRSS, ou en dépannage si FreshRSS est indisponible. Récupérés au
 * même intervalle GLOBAL pour tous (Settings.customFeedsIntervalMinutes),
 * et retraités exactement comme les items FreshRSS (même RawItem, même
 * fallbackProcess en aval, voir generateEdition.ts) — traités "au même
 * titre" partout dans l'app.
 *
 * Id synthétiques réutilisés directement comme freshrssId dans les tables
 * de réglages existantes (SelectedCategory/ExcludedFeed/MedalFeed/
 * AiPrintCategory), pour éviter toute logique parallèle en aval :
 *   - catégorie personnalisée -> "custom-cat:<CustomCategory.id>"
 *   - flux personnalisé       -> "custom-feed:<CustomFeed.id>"
 */
export function customCategoryFreshrssId(categoryId: string): string {
  return `custom-cat:${categoryId}`;
}
export function customFeedFreshrssId(feedId: string): string {
  return `custom-feed:${feedId}`;
}

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
  }
});

/** Meilleur contenu disponible dans un item rss-parser : content:encoded
 *  (texte complet, souvent absent des flux minimalistes) sinon content
 *  (mappé depuis <description> par rss-parser) sinon summary. */
function bestRawContent(item: Parser.Item): string {
  const withEncoded = item as unknown as { "content:encoded"?: string };
  return withEncoded["content:encoded"] || item.content || item.summary || "";
}

function bestImageUrl(item: Parser.Item, rawContent: string): string | null {
  const enclosureUrl = item.enclosure?.url;
  if (enclosureUrl && (!item.enclosure?.type || item.enclosure.type.startsWith("image/"))) {
    return enclosureUrl;
  }
  return extractFirstImageSrc(rawContent);
}

/**
 * Récupère TOUS les nouveaux items de TOUS les flux personnalisés, avec le
 * même filtrage/formatage que côté FreshRSS (stripHtml, stripLeadingChrome,
 * repli og:image puis favicon). Auto-gaté par l'intervalle global : ne fait
 * réellement une requête réseau que si Settings.customFeedsLastFetchedAt +
 * customFeedsIntervalMinutes est dépassé — sinon retourne [] immédiatement.
 * Peut donc être appelé souvent (chaque tick du worker) sans surcharger les
 * flux sources.
 */
export async function fetchCustomFeedItems(): Promise<RawItem[]> {
  const settings = await getSettings();
  const settingsRow = await prisma.settings.findUnique({ where: { id: "singleton" } });
  const lastFetchedAt = settingsRow?.customFeedsLastFetchedAt ?? null;
  const intervalMs = settings.customFeedsIntervalMinutes * 60_000;

  if (lastFetchedAt && Date.now() - lastFetchedAt.getTime() < intervalMs) {
    return []; // pas encore l'heure
  }

  const feeds = await prisma.customFeed.findMany({ include: { category: true } });
  if (feeds.length === 0) {
    // Rien à faire, mais on marque quand même le passage pour ne pas
    // re-tester à chaque tick tant qu'aucun flux personnalisé n'existe.
    await prisma.settings.upsert({
      where: { id: "singleton" },
      update: { customFeedsLastFetchedAt: new Date() },
      create: { id: "singleton", customFeedsLastFetchedAt: new Date() }
    });
    return [];
  }

  const [selected, excludedFeeds] = await Promise.all([
    prisma.selectedCategory.findMany({ select: { freshrssId: true } }),
    prisma.excludedFeed.findMany({ select: { freshrssId: true } })
  ]);
  const selectedIds = new Set(selected.map((c) => c.freshrssId));
  const excludedFeedIds = new Set(excludedFeeds.map((f) => f.freshrssId));

  const items: RawItem[] = [];

  for (const feed of feeds) {
    const feedFreshrssId = customFeedFreshrssId(feed.id);
    const categoryFreshrssId = customCategoryFreshrssId(feed.categoryId);
    const included = selectedIds.has(categoryFreshrssId) && !excludedFeedIds.has(feedFreshrssId);

    try {
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items) {
        const guid = item.guid || item.link || item.title;
        if (!guid) continue;
        const freshrssItemId = `${feedFreshrssId}:${guid}`;

        const exists = await prisma.article.findUnique({ where: { freshrssItemId }, select: { id: true } });
        if (exists) continue;

        const rawContent = bestRawContent(item);
        let excerpt = rawContent ? stripHtml(rawContent).trim() : (item.contentSnippet || "").trim();
        if (excerpt) excerpt = stripLeadingChrome(excerpt);

        const canonicalUrl = item.link || "";
        let imageUrl = bestImageUrl(item, rawContent);
        if (!imageUrl && canonicalUrl && included) imageUrl = await fetchOgImage(canonicalUrl);
        if (!imageUrl && canonicalUrl) imageUrl = faviconFallback(canonicalUrl);

        items.push({
          freshrssItemId,
          feedId: feedFreshrssId,
          feedTitle: feed.title,
          categoryLabel: feed.category.label,
          sourceUrl: canonicalUrl,
          sourceTitle: item.title?.trim() || "(sans titre)",
          sourceExcerpt: excerpt || null,
          imageUrl,
          publishedAt: item.isoDate ? new Date(item.isoDate) : item.pubDate ? new Date(item.pubDate) : null,
          included
        });
      }

      await prisma.customFeed.update({ where: { id: feed.id }, data: { lastFetchedAt: new Date() } });
    } catch (err) {
      console.warn(`[customFeeds] Échec pour "${feed.title}" (${feed.url}):`, (err as Error)?.message);
    }
  }

  await prisma.settings.upsert({
    where: { id: "singleton" },
    update: { customFeedsLastFetchedAt: new Date() },
    create: { id: "singleton", customFeedsLastFetchedAt: new Date() }
  });

  return items;
}

/**
 * Point d'entrée appelé périodiquement par le worker (voir worker/index.ts)
 * — récupère (si l'intervalle global est écoulé, sinon no-op immédiat) puis
 * stocke directement les nouveaux items en traitement brut, SANS créer de
 * ligne Edition (voir ingestRawItems) : ce balayage tourne sur son propre
 * intervalle, potentiellement bien plus fréquent que le cycle normal
 * d'impression (IA ou aspiration de secours), zéro coût IA dans tous les cas.
 */
export async function syncCustomFeeds(): Promise<{ fetched: number }> {
  const items = await fetchCustomFeedItems();
  if (items.length > 0) await ingestRawItems(items, null);
  return { fetched: items.length };
}
