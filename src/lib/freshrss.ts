import { prisma } from "./prisma";
import { getSettings } from "./settings";
import { stripHtml, extractFirstImageSrc } from "./text";

export type RawItem = {
  freshrssItemId: string;
  feedId: string | null;
  feedTitle: string;
  categoryLabel: string | null;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string | null;
  imageUrl: string | null;
  publishedAt: Date | null;
};

export type FreshRssCategory = {
  freshrssId: string; // e.g. "user/1005921/label/Tech"
  label: string;
};

export type FreshRssFeed = {
  freshrssId: string; // subscription/feed stream id, matches item.origin.streamId
  title: string;
  categoryLabels: string[];
};

async function config() {
  const { freshrssBaseUrl: baseUrl, freshrssUsername: username, freshrssApiPassword: password } =
    await getSettings();
  if (!baseUrl || !username || !password) {
    throw new Error(
      "FreshRSS n'est pas configuré : renseigne l'URL, l'identifiant et le mot de passe API dans " +
        "/admin/settings (ou FRESHRSS_BASE_URL / FRESHRSS_USERNAME / FRESHRSS_API_PASSWORD)."
    );
  }
  return { baseUrl: baseUrl.replace(/\/+$/, ""), username, password };
}

/**
 * Authenticate against FreshRSS's Google Reader-compatible API and return
 * a bearer token to use on subsequent requests.
 * https://freshrss.github.io/FreshRSS/en/developers/06_GoogleReader_API.html
 */
async function login(): Promise<{ baseUrl: string; token: string }> {
  const { baseUrl, username, password } = await config();

  const res = await fetch(`${baseUrl}/api/greader.php/accounts/ClientLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Email: username, Passwd: password }).toString()
  });

  if (!res.ok) {
    throw new Error(`[freshrss] Login failed: ${res.status} ${res.statusText}`);
  }

  const text = await res.text();
  const authLine = text.split("\n").find((line) => line.startsWith("Auth="));
  if (!authLine) {
    throw new Error("[freshrss] Login response did not contain an Auth token.");
  }

  return { baseUrl, token: authLine.slice("Auth=".length).trim() };
}

async function authedFetch(baseUrl: string, token: string, path: string) {
  const res = await fetch(`${baseUrl}/api/greader.php${path}`, {
    headers: { Authorization: `GoogleLogin auth=${token}` }
  });
  if (!res.ok) {
    throw new Error(`[freshrss] Request to ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

/**
 * Single call to FreshRSS's subscription list, split into the two shapes the
 * admin UI needs: categories (labels) and individual feeds — so choosing
 * either what categories or what specific feeds to include/exclude both
 * read from the same source of truth.
 */
async function listSubscriptions(): Promise<{ categories: FreshRssCategory[]; feeds: FreshRssFeed[] }> {
  const { baseUrl, token } = await login();
  const data = await authedFetch(baseUrl, token, "/reader/api/0/subscription/list?output=json");

  const categoriesById = new Map<string, FreshRssCategory>();
  const feeds: FreshRssFeed[] = [];

  for (const sub of data.subscriptions || []) {
    const categoryLabels: string[] = [];
    for (const cat of sub.categories || []) {
      if (!categoriesById.has(cat.id)) {
        categoriesById.set(cat.id, { freshrssId: cat.id, label: cat.label });
      }
      categoryLabels.push(cat.label);
    }
    feeds.push({ freshrssId: sub.id, title: sub.title, categoryLabels });
  }

  return {
    categories: [...categoriesById.values()].sort((a, b) => a.label.localeCompare(b.label)),
    feeds: feeds.sort((a, b) => a.title.localeCompare(b.title))
  };
}

/**
 * List every category/label that exists across the user's FreshRSS
 * subscriptions — used by the admin UI to let the user pick which ones
 * DailySpoon should pull articles from.
 */
export async function listAllCategories(): Promise<FreshRssCategory[]> {
  const { categories } = await listSubscriptions();
  return categories;
}

/**
 * List every individual feed (subscription) — used by the admin UI to let
 * the user exclude specific feeds regardless of category (e.g. a noisy or
 * badly-formatted feed within an otherwise-wanted category).
 */
export async function listAllFeeds(): Promise<FreshRssFeed[]> {
  const { feeds } = await listSubscriptions();
  return feeds;
}

/**
 * Reddit-sourced RSS feeds wrap everything in nested <table>/<img>/tracking-
 * link markup (and sometimes entity-encode it on top) — even after cleanup
 * the "content" is often just a thumbnail with no real article text. Rather
 * than keep patching around it, skip these feeds entirely by default (the
 * user can also exclude any other feed explicitly from /admin/categories).
 */
function isRedditSource(item: any, canonicalUrl: string): boolean {
  const haystack = [item.origin?.htmlUrl, item.origin?.streamId, canonicalUrl]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes("reddit.com");
}

/**
 * Best-effort illustration for an article: a media enclosure if the feed
 * declares one (podcasts/some feeds), otherwise the first <img> found in the
 * raw (pre-stripHtml) content/summary HTML — most feeds lead with a
 * thumbnail image before any text.
 */
function extractImageUrl(item: any, rawHtml: string | null): string | null {
  const enclosures: any[] = item.enclosure || [];
  const imageEnclosure = enclosures.find((e) => typeof e?.type === "string" && e.type.startsWith("image/"));
  if (imageEnclosure?.href) return imageEnclosure.href;

  return extractFirstImageSrc(rawHtml);
}

/**
 * Fetch recent items from FreshRSS's global reading list, then keep only
 * the ones tagged with a category the user has selected in DailySpoon's
 * admin, that aren't from a feed the user explicitly excluded, and that we
 * haven't already stored (dedup by FreshRSS item id). Read/unread state in
 * FreshRSS is never modified.
 */
export async function fetchNewItemsFromSelectedCategories(): Promise<RawItem[]> {
  const [selected, excludedFeeds] = await Promise.all([
    prisma.selectedCategory.findMany(),
    prisma.excludedFeed.findMany()
  ]);
  if (selected.length === 0) {
    console.warn("[freshrss] No category selected in admin — nothing to fetch.");
    return [];
  }
  const selectedIds = new Set(selected.map((c) => c.freshrssId));
  const excludedFeedIds = new Set(excludedFeeds.map((f) => f.freshrssId));

  const { baseUrl, token } = await login();
  const data = await authedFetch(
    baseUrl,
    token,
    "/reader/api/0/stream/contents/user/-/state/com.google/reading-list?output=json&n=500"
  );

  const items: RawItem[] = [];

  for (const item of data.items || []) {
    const categories: string[] = item.categories || [];
    if (!categories.some((c) => selectedIds.has(c))) continue;

    const feedId: string | null = item.origin?.streamId || null;
    if (feedId && excludedFeedIds.has(feedId)) continue;

    const matchedCategory = selected.find((c) => categories.includes(c.freshrssId));

    const exists = await prisma.article.findUnique({ where: { freshrssItemId: item.id } });
    if (exists) continue;

    const canonicalUrl = item.canonical?.[0]?.href || item.alternate?.[0]?.href || "";
    if (isRedditSource(item, canonicalUrl)) continue;

    const rawExcerpt: string | null = item.summary?.content || item.content?.content || null;
    const excerpt = rawExcerpt ? stripHtml(rawExcerpt) : null;
    const imageUrl = extractImageUrl(item, rawExcerpt);

    items.push({
      freshrssItemId: item.id,
      feedId,
      feedTitle: item.origin?.title || "FreshRSS",
      categoryLabel: matchedCategory?.label ?? null,
      sourceUrl: canonicalUrl,
      sourceTitle: item.title?.trim() || "(sans titre)",
      sourceExcerpt: excerpt,
      imageUrl,
      publishedAt: item.published ? new Date(item.published * 1000) : null
    });
  }

  return items;
}
