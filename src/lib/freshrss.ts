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
 * Best-effort illustration for an article, dans l'ordre : un media enclosure
 * si le flux en déclare un (podcasts/certains flux), sinon le premier <img>
 * trouvé dans le résumé OU le contenu complet brut (avant stripHtml) — on
 * regarde les deux champs séparément, certains flux ne mettent l'image que
 * dans l'un des deux.
 */
function extractImageUrl(item: any): string | null {
  const enclosures: any[] = item.enclosure || [];
  const imageEnclosure = enclosures.find((e) => {
    if (typeof e?.type === "string" && e.type.startsWith("image/")) return true;
    // Certains flux ne renseignent pas le type MIME de l'enclosure — on
    // se rabat sur l'extension du fichier pointé.
    return typeof e?.href === "string" && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(e.href);
  });
  if (imageEnclosure?.href) return imageEnclosure.href;

  const fromSummary = extractFirstImageSrc(item.summary?.content || null);
  if (fromSummary) return fromSummary;

  const fromContent = extractFirstImageSrc(item.content?.content || null);
  if (fromContent) return fromContent;

  return null;
}

/**
 * Filet de sécurité quand le flux RSS ne fournit vraiment aucune image :
 * on va chercher la balise og:image (ou à défaut twitter:image) directement
 * sur la page source de l'article, comme le fait un aperçu de lien classique.
 * On ne télécharge qu'un extrait du HTML (la balise est presque toujours
 * dans le <head>) et on abandonne proprement si le site ne répond pas vite
 * ou refuse la requête — une image manquante reste acceptable, un import
 * bloqué ne l'est pas.
 */
async function fetchOgImage(url: string): Promise<string | null> {
  if (!url) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let res: Response;
    try {
      res = await fetch(url, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; DailySpoonBot/1.0; +https://dailyspoon)" }
      });
    } finally {
      clearTimeout(timeout);
    }
    if (!res.ok) return null;

    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      const MAX_BYTES = 200_000;
      let bytesRead = 0;
      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
        if (/<\/head>/i.test(html)) break;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }

    const match =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    if (!match) return null;
    let imageUrl = match[1].trim();
    if (imageUrl.startsWith("//")) imageUrl = "https:" + imageUrl;
    return imageUrl || null;
  } catch (err) {
    console.warn(`[freshrss] og:image indisponible pour ${url}:`, (err as Error)?.message);
    return null;
  }
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

    const rawExcerpt: string | null = item.summary?.content || item.content?.content || null;
    const excerpt = rawExcerpt ? stripHtml(rawExcerpt) : null;

    let imageUrl = extractImageUrl(item);
    if (!imageUrl && canonicalUrl) {
      // Rien dans le flux — dernier recours, on va chercher l'og:image sur
      // la page source (uniquement pour les nouveaux articles, jamais
      // re-tenté pour ceux déjà en base).
      imageUrl = await fetchOgImage(canonicalUrl);
    }

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
