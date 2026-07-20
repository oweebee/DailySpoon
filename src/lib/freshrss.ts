import { prisma } from "./prisma";
import { getSettings } from "./settings";
import { stripHtml, extractFirstImageSrc, stripLeadingChrome, isAlreadyMorssUrl } from "./text";
import { writeLog } from "./logger";

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
  const {
    freshrssBaseUrl: baseUrl,
    freshrssUsername: username,
    freshrssApiPassword: password,
    freshrssEnabled
  } = await getSettings();
  // Interrupteur explicite en premier : même si l'URL/identifiant/mot de
  // passe sont renseignés (en base ou via les variables d'environnement
  // FRESHRSS_*), on refuse tant que la case "Activer FreshRSS" n'est pas
  // cochée dans /admin/settings — voir settings.ts. Évite qu'un simple
  // redeploy (qui conserve les variables d'environnement Coolify) ne
  // réactive tout seul une intégration explicitement coupée.
  if (!freshrssEnabled) {
    throw new Error(
      "FreshRSS n'est pas activé : coche « Activer FreshRSS » dans /admin/settings pour utiliser cette " +
        "intégration."
    );
  }
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
 * Renomme une catégorie/label FreshRSS via l'API Google Reader
 * (rename-tag) — nécessite un jeton d'écriture séparé (endpoint /token,
 * protection CSRF côté FreshRSS), en plus du jeton d'auth déjà utilisé pour
 * la lecture. IMPORTANT : côté FreshRSS, l'id d'une catégorie ENCODE son
 * libellé (ex. "user/1005921/label/Tech") — renommer change donc aussi
 * l'id, ce n'est jamais une simple mise à jour de champ. On relit la liste
 * des catégories après coup pour récupérer l'id EXACT tel que FreshRSS l'a
 * réellement construit, plutôt que de le deviner/reconstruire ici (le
 * numéro d'utilisateur dans l'id n'est pas forcément prévisible).
 */
export async function renameCategory(freshrssId: string, newLabel: string): Promise<{ newFreshrssId: string }> {
  const { baseUrl, token } = await login();

  const tokenRes = await fetch(`${baseUrl}/api/greader.php/reader/api/0/token`, {
    headers: { Authorization: `GoogleLogin auth=${token}` }
  });
  if (!tokenRes.ok) {
    throw new Error(`[freshrss] Impossible d'obtenir un jeton d'écriture (${tokenRes.status} ${tokenRes.statusText}).`);
  }
  const writeToken = (await tokenRes.text()).trim();

  const res = await fetch(`${baseUrl}/api/greader.php/reader/api/0/rename-tag`, {
    method: "POST",
    headers: {
      Authorization: `GoogleLogin auth=${token}`,
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body: new URLSearchParams({ s: freshrssId, dest: `user/-/label/${newLabel}`, T: writeToken }).toString()
  });
  if (!res.ok) {
    throw new Error(`[freshrss] Échec du renommage (${res.status} ${res.statusText}).`);
  }

  const categories = await listAllCategories();
  const renamed = categories.find((c) => c.label === newLabel);
  if (!renamed) {
    throw new Error(
      "Renommage envoyé à FreshRSS mais la nouvelle catégorie reste introuvable — vérifie directement dans FreshRSS."
    );
  }
  return { newFreshrssId: renamed.freshrssId };
}

/**
 * Best-effort illustration for an article, dans l'ordre : un media enclosure
 * si le flux en déclare un (podcasts/certains flux), sinon le premier <img>
 * trouvé dans le résumé OU le contenu complet brut (avant stripHtml) — on
 * regarde les deux champs séparément, certains flux ne mettent l'image que
 * dans l'un des deux.
 */
function extractImageUrl(item: any, baseUrl?: string | null): string | null {
  const enclosures: any[] = item.enclosure || [];
  const imageEnclosure = enclosures.find((e) => {
    if (typeof e?.type === "string" && e.type.startsWith("image/")) return true;
    // Certains flux ne renseignent pas le type MIME de l'enclosure — on
    // se rabat sur l'extension du fichier pointé.
    return typeof e?.href === "string" && /\.(jpe?g|png|gif|webp|avif)(\?|$)/i.test(e.href);
  });
  if (imageEnclosure?.href) return imageEnclosure.href;

  const fromSummary = extractFirstImageSrc(item.summary?.content || null, baseUrl);
  if (fromSummary) return fromSummary;

  const fromContent = extractFirstImageSrc(item.content?.content || null, baseUrl);
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
function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/&nbsp;/gi, " ");
}

/**
 * Récupère og:image, le VRAI titre de la page (og:title, sinon twitter:title,
 * sinon <title>) ET une description (og:description, sinon meta description,
 * sinon twitter:description) en UN SEUL aller-retour réseau — utilisé quand
 * un flux ne fournit ni image ni titre exploitable par item (ex. dépêches AFP
 * redistribuées, vu en usage réel sur fonction-publique.gouv.fr : l'article
 * ouvert en grand affiche bien un titre correct puisqu'il vient de ce même
 * scraping, alors que le flux RSS lui-même n'a aucun <title>). La description
 * sert de FILET DE SECOURS pour l'extrait affiché ("en direct", accueil)
 * quand le flux ne fournit vraiment aucun texte exploitable (ni content:encoded,
 * ni summary, ni contentSnippet) — sans ça l'article retombe sur le texte
 * générique "Aucun aperçu fourni par le flux" alors qu'une vraie description
 * existe sur la page source elle-même.
 * fetchOgImage ci-dessous reste un simple alias pour les appelants qui n'ont
 * besoin que de l'image.
 */

/** Résout une URL d'image trouvée dans le HTML d'une page (og:image,
 *  twitter:image, <img> WordPress...) contre l'URL de CETTE page — gère les
 *  trois formes rencontrées en pratique : URL déjà absolue (inchangée),
 *  protocole-relative ("//cdn.example.com/x.jpg"), et chemin relatif
 *  ("/wp-content/uploads/x.jpg" ou "x.jpg"). Sans cette résolution, un
 *  og:image en chemin relatif (vu en usage réel sur Korben, servi via morss)
 *  était stocké tel quel — une "image" qui pointe en fait vers le domaine de
 *  DailySpoon, jamais chargeable (voir aussi extractFirstImageSrc dans
 *  text.ts, même classe de bug côté flux RSS). */
function resolveImageUrl(raw: string, pageUrl: string): string | null {
  if (!raw) return null;
  try {
    return new URL(raw, pageUrl).toString();
  } catch {
    return raw;
  }
}

const OG_META_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

/** Un seul essai de récupération de page (direct OU via une URL morss déjà
 *  construite) — factorisé pour être appelé deux fois par
 *  fetchPageHtmlWithMorssFallback ci-dessous sans dupliquer la lecture par
 *  morceaux (streaming, borné à MAX_BYTES). */
async function fetchHtmlOnce(url: string): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Certains sites (ex. jeuxvideo.com) renvoient un 403 dès qu'ils
      // reconnaissent un User-Agent "bot" dans l'en-tête, même pour une
      // simple requête d'aperçu de lien (og:image, publique dans le
      // <head> de toute façon) — un User-Agent de navigateur classique,
      // déjà utilisé ailleurs dans l'appli (article-proxy), passe sans
      // problème.
      headers: { "User-Agent": OG_META_USER_AGENT }
    });
    if (!res.ok) return null;

    // On ne s'arrête plus à la fin du <head> : certains sites (ex.
    // Geekzone/WordPress sans plugin SEO configuré sur tous les articles)
    // n'ont tout simplement PAS de balise og:image, même quand une image
    // est bien présente dans le corps de l'article — s'arrêter au <head>
    // ne laissait alors aucune chance au filet de secours ci-dessous.
    // MAX_BYTES relevé en conséquence pour couvrir une partie du corps de
    // page (têtes de thème WordPress comprises), tout en restant borné.
    const reader = res.body?.getReader();
    let html = "";
    if (reader) {
      const decoder = new TextDecoder();
      const MAX_BYTES = 350_000;
      let bytesRead = 0;
      while (bytesRead < MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        html += decoder.decode(value, { stream: true });
        bytesRead += value.length;
      }
      reader.cancel().catch(() => {});
    } else {
      html = await res.text();
    }
    return html;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

/** Repli via morss (voir /admin/settings) quand la requête DIRECTE vers la
 *  page échoue — même raisonnement que partout ailleurs dans l'app
 *  (customFeeds.ts, article-proxy) : un site qui bloque les requêtes
 *  serveur-à-serveur (anti-bot, Cloudflare...) laisse quand même passer
 *  morss. Sans ce repli, le rattrapage rétroactif d'image (voir
 *  generateEdition.ts) échouait en boucle, à chaque génération, sur
 *  n'importe quel site bloquant ce type de requête — vu en usage réel sur
 *  korben.info. Ne retente pas si l'URL est déjà une URL morss (l'échec
 *  viendrait alors de morss lui-même, pas la peine de le relayer deux fois).
 */
async function fetchPageHtmlWithMorssFallback(url: string): Promise<string | null> {
  const direct = await fetchHtmlOnce(url);
  if (direct) return direct;

  const { morssBaseUrl } = await getSettings();
  if (!morssBaseUrl || isAlreadyMorssUrl(url, morssBaseUrl)) return null;

  const strippedUrl = url.replace(/^https?:\/\//, "");
  const viaMorss = await fetchHtmlOnce(`${morssBaseUrl}/${strippedUrl}`);
  if (!viaMorss) {
    await writeLog(
      "warn",
      "custom-feeds",
      `Repli image (og:image) : échec direct ET via morss — ${url}`
    );
  }
  return viaMorss;
}

export async function fetchOgMeta(
  url: string
): Promise<{ imageUrl: string | null; title: string | null; description: string | null }> {
  if (!url) return { imageUrl: null, title: null, description: null };
  try {
    const html = await fetchPageHtmlWithMorssFallback(url);
    if (!html) return { imageUrl: null, title: null, description: null };

    const imageMatch =
      html.match(/<meta[^>]+property=["']og:image(?::secure_url)?["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image(?::secure_url)?["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);

    let imageUrl: string | null = null;
    if (imageMatch) {
      imageUrl = resolveImageUrl(imageMatch[1].trim(), url);
    } else {
      // Filet de secours WordPress : pas de balise og:image, mais l'image de
      // l'article est presque toujours servie depuis /wp-content/uploads/
      // (contenu réellement uploadé pour ce post), contrairement aux images
      // de thème/logo/icônes qui viennent de /wp-content/themes/ ou
      // /plugins/ — heuristique fiable pour cibler la vraie image
      // d'illustration sans risquer d'attraper un logo ou une icône de nav.
      //
      // Recherche restreinte à ce qui suit <article ...> quand la balise
      // existe : sur certains thèmes (ex. fdesouche.com), plusieurs images
      // d'en-tête (logo, bandeau don, pub) sont AUSSI servies depuis
      // /wp-content/uploads/ et apparaissent AVANT l'image de l'article dans
      // le HTML — sans ce recadrage, "le premier match" attrapait presque
      // toujours l'une d'elles au lieu de l'illustration réelle. Repli sur le
      // HTML entier si aucune balise <article> n'est trouvée.
      const articleStart = html.search(/<article[\s>]/i);
      const scope = articleStart >= 0 ? html.slice(articleStart) : html;

      // Beaucoup de thèmes WordPress chargent les images en lazy-load : le
      // vrai src est alors dans data-src/data-lazy-src/data-srcset (avec un
      // src= vide ou un minuscule placeholder), donc une recherche limitée à
      // l'attribut src= ratait l'image la plupart du temps — cas concret
      // observé sur fdesouche.com. On essaie d'abord un <img> portant la
      // classe "wp-post-image" (image mise en avant WordPress standard),
      // puis n'importe quel <img> /wp-content/uploads/, en testant chaque
      // attribut susceptible de contenir la vraie URL.
      const attrPattern = "(?:src|data-src|data-lazy-src|srcset|data-srcset)";
      const wpMatch =
        scope.match(
          new RegExp(`<img[^>]+class=["'][^"']*wp-post-image[^"']*["'][^>]+${attrPattern}=["']([^"'\\s]+)`, "i")
        ) ||
        scope.match(
          new RegExp(`<img[^>]+${attrPattern}=["']([^"'\\s]*\\/wp-content\\/uploads\\/[^"'\\s]+)`, "i")
        );
      if (wpMatch) {
        imageUrl = resolveImageUrl(wpMatch[1].trim(), url);
      }
    }

    const titleMatch =
      html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:title["']/i) ||
      html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch ? decodeHtmlEntities(titleMatch[1]).trim() : null;

    const descMatch =
      html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i) ||
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i) ||
      html.match(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:description["']/i);
    const description = descMatch ? decodeHtmlEntities(descMatch[1]).trim() : null;

    return { imageUrl: imageUrl || null, title: title || null, description: description || null };
  } catch (err) {
    console.warn(`[freshrss] og:image/og:title/og:description indisponible pour ${url}:`, (err as Error)?.message);
    return { imageUrl: null, title: null, description: null };
  }
}

/**
 * Alias historique pour les appelants qui n'ont besoin que de l'image (voir
 * fetchOgMeta ci-dessus pour récupérer aussi le titre en un seul aller-retour).
 */
export async function fetchOgImage(url: string): Promise<string | null> {
  return (await fetchOgMeta(url)).imageUrl;
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
    // vrai texte. D'autres (ex. jeuxvideo.com via un proxy morss qui enrichit
    // le flux avec l'article complet) ont les DEUX champs remplis, mais
    // "summary" ne garde que le court chapô d'origine tandis que "content"
    // contient tout l'article — toujours préférer le champ qui donne le PLUS
    // de texte, plutôt que de figer le choix sur "summary" dès qu'il n'est
    // pas vide, ce qui écrasait silencieusement le contenu enrichi par un
    // simple résumé d'une phrase.
    const summaryText = item.summary?.content ? stripHtml(item.summary.content).trim() : "";
    const contentText = item.content?.content ? stripHtml(item.content.content).trim() : "";
    let excerpt =
      contentText.length > summaryText.length ? contentText : summaryText.length > 0 ? summaryText : null;
    // Certains flux (voir stripLeadingChrome) collent le chrome de la page
    // AVANT le vrai texte de l'article — sans ça, l'extrait affiché en
    // aperçu (accueil, "En direct") n'est que pub/tags/boutons, sans aucun
    // vrai texte.
    if (excerpt) excerpt = stripLeadingChrome(excerpt);

    let imageUrl = extractImageUrl(item, canonicalUrl || null);
    // Un seul aller-retour réseau (fetchOgMeta) couvre image manquante ET/OU
    // extrait manquant — un flux "lien seul" (aucun content:encoded/summary
    // réel) tombait sinon systématiquement sur le texte générique "Aucun
    // aperçu fourni par le flux" alors que la page source a presque toujours
    // une vraie meta description exploitable.
    if ((!imageUrl || !excerpt) && canonicalUrl && included) {
      // Requête réseau — seulement pour les articles "included", pour ne pas
      // multiplier les appels sortants sur tout le flux FreshRSS (des
      // centaines d'items) à chaque génération.
      const meta = await fetchOgMeta(canonicalUrl);
      if (!imageUrl) imageUrl = meta.imageUrl;
      if (!excerpt && meta.description) excerpt = meta.description;
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
