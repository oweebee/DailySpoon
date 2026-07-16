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
  /** false si le flux est exclu ou la catégorie non sélectionnée dans
   *  /admin/categories — l'article est quand même stocké (recherche), mais
   *  n'apparaît pas dans les vues normales ni ne passe par l'IA. */
  included: boolean;
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
export async function fetchOgImage(url: string): Promise<string | null> {
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
 * Dernier recours si ni le flux ni og:image n'ont donné d'illustration : le
 * favicon du site source, via le service public de Google (aucune clé
 * requise, quasi toujours disponible) — pour ne jamais laisser un article
 * sans image du tout plutôt que d'afficher rien.
 */
export function faviconFallback(pageUrl: string): string | null {
  try {
    const { hostname } = new URL(pageUrl);
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(hostname)}&sz=128`;
  } catch {
    return null;
  }
}

/**
 * Fetch recent items from FreshRSS's global reading list — TOUS les items,
 * pas seulement ceux d'une catégorie sélectionnée ou d'un flux non exclu.
 * Chaque item reçoit un flag "included" qui reflète l'état actuel des
 * réglages admin : les articles non "included" sont quand même stockés
 * (pour rester trouvables par la recherche même si leur flux est exclu ou
 * leur catégorie décochée), mais n'apparaissent pas dans les vues normales
 * et ne passent jamais par l'IA (voir generateEdition.ts). Dédoublonnage
 * par id FreshRSS ; le read/unread FreshRSS n'est jamais modifié.
 */
export async function fetchNewItemsFromSelectedCategories(): Promise<RawItem[]> {
  const [selected, excludedFeeds, allCategories] = await Promise.all([
    prisma.selectedCategory.findMany(),
    prisma.excludedFeed.findMany(),
    listAllCategories()
  ]);
  const selectedIds = new Set(selected.map((c) => c.freshrssId));
  const excludedFeedIds = new Set(excludedFeeds.map((f) => f.freshrssId));
  const categoryLabelById = new Map(allCategories.map((c) => [c.freshrssId, c.label]));

  const { baseUrl, token } = await login();
  const data = await authedFetch(
    baseUrl,
    token,
    "/reader/api/0/stream/contents/user/-/state/com.google/reading-list?output=json&n=500"
  );

  const items: RawItem[] = [];

  for (const item of data.items || []) {
    const categories: string[] = item.categories || [];
    const feedId: string | null = item.origin?.streamId || null;

    const isSelectedCategory = categories.some((c) => selectedIds.has(c));
    const isExcludedFeed = Boolean(feedId && excludedFeedIds.has(feedId));
    const included = isSelectedCategory && !isExcludedFeed;

    // Étiquette de rubrique pour l'affichage/la recherche : la catégorie
    // sélectionnée correspondante si possible, sinon la première catégorie
    // FreshRSS reconnue même non sélectionnée (contexte minimal utile dans
    // les résultats de recherche pour un article normalement masqué).
    const matchedSelected = selected.find((c) => categories.includes(c.freshrssId));
    const fallbackLabel = categories.map((c) => categoryLabelById.get(c)).find((l): l is string => Boolean(l));
    const categoryLabel = matchedSelected?.label ?? fallbackLabel ?? null;

    const exists = await prisma.article.findUnique({ where: { freshrssItemId: item.id } });
    if (exists) continue;

    const canonicalUrl = item.canonical?.[0]?.href || item.alternate?.[0]?.href || "";

    // Certains flux (ex. Korben) fournissent un "summary.content" qui n'est
    // que balisage (image, encart) sans texte réel — stripHtml renverrait
    // alors une chaîne vide alors que "content.content" contient, lui, du
    // vrai texte. On tente les deux et on garde le premier qui donne
    // effectivement du texte, plutôt que de figer le choix sur "summary"
    // et se retrouver avec un article totalement vide.
    const summaryText = item.summary?.content ? stripHtml(item.summary.content).trim() : "";
    const contentText = item.content?.content ? stripHtml(item.content.content).trim() : "";
    const excerpt = summaryText.length > 0 ? summaryText : contentText.length > 0 ? contentText : null;

    let imageUrl = extractImageUrl(item);
    if (!imageUrl && canonicalUrl && included) {
      // Requête réseau (og:image) — seulement pour les articles "included",
      // pour ne pas multiplier les appels sortants sur tout le flux
      // FreshRSS (des centaines d'items) à chaque génération.
      imageUrl = await fetchOgImage(canonicalUrl);
    }
    if (!imageUrl && canonicalUrl) {
      // Favicon : gratuit (juste une URL construite), toujours tenté même
      // pour les articles non "included".
      imageUrl = faviconFallback(canonicalUrl);
    }

    items.push({
      freshrssItemId: item.id,
      feedId,
      feedTitle: item.origin?.title || "FreshRSS",
      categoryLabel,
      sourceUrl: canonicalUrl,
      sourceTitle: item.title?.trim() || "(sans titre)",
      sourceExcerpt: excerpt,
      imageUrl,
      publishedAt: item.published ? new Date(item.published * 1000) : null,
      included
    });
  }

  return items;
}
