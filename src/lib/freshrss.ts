import { prisma } from "./prisma";
import { getSettings } from "./settings";

export type RawItem = {
  freshrssItemId: string;
  feedTitle: string;
  categoryLabel: string | null;
  sourceUrl: string;
  sourceTitle: string;
  sourceExcerpt: string | null;
  publishedAt: Date | null;
};

export type FreshRssCategory = {
  freshrssId: string; // e.g. "user/1005921/label/Tech"
  label: string;
};

/**
 * FreshRSS's summary/content fields are raw HTML straight from the source
 * feed (paragraphs, links, embedded images, sometimes whole <figure> blocks).
 * Strip it down to plain text so articles read cleanly instead of showing
 * literal tags — both for direct display (no-AI fallback mode) and as
 * cleaner input to the AI rewrite prompt.
 */
function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

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
 * List every category/label that exists across the user's FreshRSS
 * subscriptions — used by the admin UI to let the user pick which ones
 * DailySpoon should pull articles from.
 */
export async function listAllCategories(): Promise<FreshRssCategory[]> {
  const { baseUrl, token } = await login();
  const data = await authedFetch(baseUrl, token, "/reader/api/0/subscription/list?output=json");

  const byId = new Map<string, FreshRssCategory>();
  for (const sub of data.subscriptions || []) {
    for (const cat of sub.categories || []) {
      if (!byId.has(cat.id)) {
        byId.set(cat.id, { freshrssId: cat.id, label: cat.label });
      }
    }
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Fetch recent items from FreshRSS's global reading list, then keep only
 * the ones tagged with a category the user has selected in DailySpoon's admin,
 * and that we haven't already stored (dedup by FreshRSS item id).
 * Read/unread state in FreshRSS is never modified.
 */
export async function fetchNewItemsFromSelectedCategories(): Promise<RawItem[]> {
  const selected = await prisma.selectedCategory.findMany();
  if (selected.length === 0) {
    console.warn("[freshrss] No category selected in admin — nothing to fetch.");
    return [];
  }
  const selectedIds = new Set(selected.map((c) => c.freshrssId));

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

    const matchedCategory = selected.find((c) => categories.includes(c.freshrssId));

    const exists = await prisma.article.findUnique({ where: { freshrssItemId: item.id } });
    if (exists) continue;

    const canonicalUrl = item.canonical?.[0]?.href || item.alternate?.[0]?.href || "";
    const rawExcerpt: string | null = item.summary?.content || item.content?.content || null;
    const excerpt = rawExcerpt ? stripHtml(rawExcerpt) : null;

    items.push({
      freshrssItemId: item.id,
      feedTitle: item.origin?.title || "FreshRSS",
      categoryLabel: matchedCategory?.label ?? null,
      sourceUrl: canonicalUrl,
      sourceTitle: item.title?.trim() || "(sans titre)",
      sourceExcerpt: excerpt,
      publishedAt: item.published ? new Date(item.published * 1000) : null
    });
  }

  return items;
}
