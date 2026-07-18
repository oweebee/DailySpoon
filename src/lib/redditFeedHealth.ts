import { getSettings } from "./settings";
import { REDLIB_INSTANCES, isRedditHostname } from "./reddit";

/**
 * Contournement automatique du blocage Reddit AU NIVEAU DU FLUX RSS
 * lui-même (pas seulement à la lecture d'un article individuel, déjà géré
 * par /api/article-proxy) : FreshRSS interroge périodiquement l'URL RSS
 * configurée pour chaque abonnement Reddit — si Reddit bloque ces requêtes
 * (403), FreshRSS n'obtient simplement plus aucun nouvel article de ce flux,
 * silencieusement, sans qu'on s'en aperçoive avant longtemps.
 *
 * Ce module (appelé périodiquement par worker/index.ts, zéro coût IA) teste
 * chaque abonnement FreshRSS pointant directement vers reddit.com : si
 * l'URL configurée répond correctement, on ne touche à rien. Si elle
 * échoue, on teste chacun des miroirs Redlib (même liste que
 * article-proxy) jusqu'à en trouver un qui répond, puis on bascule
 * l'abonnement FreshRSS dessus — réabonnement sur le miroir DANS LA MÊME
 * CATÉGORIE, puis désabonnement de l'ancienne URL seulement une fois le
 * nouvel abonnement confirmé (pour ne jamais perdre le flux si la bascule
 * échoue à mi-chemin).
 */

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

async function config(): Promise<{ baseUrl: string; username: string; password: string } | null> {
  const { freshrssBaseUrl: baseUrl, freshrssUsername: username, freshrssApiPassword: password } =
    await getSettings();
  if (!baseUrl || !username || !password) return null;
  return { baseUrl: baseUrl.replace(/\/+$/, ""), username, password };
}

async function login(): Promise<{ baseUrl: string; token: string } | null> {
  const cfg = await config();
  if (!cfg) return null;
  const { baseUrl, username, password } = cfg;
  const res = await fetch(`${baseUrl}/api/greader.php/accounts/ClientLogin`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ Email: username, Passwd: password }).toString()
  });
  if (!res.ok) return null;
  const text = await res.text();
  const authLine = text.split("\n").find((line) => line.startsWith("Auth="));
  if (!authLine) return null;
  return { baseUrl, token: authLine.slice("Auth=".length).trim() };
}

type FeedRow = { streamId: string; url: string; title: string; categoryLabel: string | null };

async function listFeedsWithUrl(baseUrl: string, token: string): Promise<FeedRow[]> {
  const res = await fetch(`${baseUrl}/api/greader.php/reader/api/0/subscription/list?output=json`, {
    headers: { Authorization: `GoogleLogin auth=${token}` }
  });
  if (!res.ok) return [];
  const data: any = await res.json();
  return (data.subscriptions || []).map((sub: any) => ({
    streamId: sub.id, // déjà au format "feed/<id>", cf. subscriptionList() côté FreshRSS
    url: sub.url || "",
    title: sub.title || "",
    // FreshRSS n'autorise qu'une seule catégorie par flux (contrairement au
    // format Google Reader qui permet un tableau) — le premier élément
    // suffit toujours.
    categoryLabel: sub.categories?.[0]?.label ?? null
  }));
}

// Sonde légère : on ne cherche pas à parser le flux, juste à vérifier que la
// réponse ressemble à du XML RSS/Atom valide plutôt qu'à une page de
// blocage (403, challenge anti-bot HTML...).
async function probeFeedUrl(url: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": USER_AGENT,
        Accept: "application/rss+xml, application/atom+xml, application/xml, text/xml, */*;q=0.8"
      }
    });
    if (!res.ok) return false;
    const text = await res.text();
    if (text.length < 200) return false;
    if (/anubis|checking your browser|cf-browser-verification/i.test(text)) return false;
    return /<rss|<feed[\s>]/i.test(text.slice(0, 2000));
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** Reconstruit la même URL de flux (chemin + query) sur un autre hôte — ex.
 *  https://redlib.catsarch.com + /r/france/.rss depuis
 *  https://www.reddit.com/r/france/.rss */
function rehostUrl(originalUrl: string, newBase: string): string | null {
  try {
    const parsed = new URL(originalUrl);
    return `${newBase}${parsed.pathname}${parsed.search}`;
  } catch {
    return null;
  }
}

async function findWorkingMirror(originalUrl: string): Promise<string | null> {
  for (const instance of REDLIB_INSTANCES) {
    const candidate = rehostUrl(originalUrl, instance);
    if (!candidate) continue;
    if (await probeFeedUrl(candidate)) return candidate;
  }
  return null;
}

// subscription/edit (action subscribe/unsubscribe) n'exige PAS le jeton
// anti-CSRF "T=" côté FreshRSS (contrairement à edit-tag/mark-all-as-read/
// rename-tag) — vérifié dans le code source officiel (p/api/greader.php,
// case 'edit' du switch subscription ne passe jamais par checkToken()) : le
// seul en-tête requis reste l'Authorization GoogleLogin habituel.
async function switchFeedUrl(baseUrl: string, token: string, feed: FeedRow, newUrl: string): Promise<boolean> {
  const subscribeBody = new URLSearchParams({ ac: "subscribe", s: `feed/${newUrl}`, t: feed.title });
  if (feed.categoryLabel) subscribeBody.set("a", `user/-/label/${feed.categoryLabel}`);

  const subscribeRes = await fetch(`${baseUrl}/api/greader.php/reader/api/0/subscription/edit`, {
    method: "POST",
    headers: { Authorization: `GoogleLogin auth=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: subscribeBody.toString()
  }).catch(() => null);
  if (!subscribeRes || !subscribeRes.ok) return false;

  // Le nouvel abonnement est confirmé : on ne perd donc rien à retirer
  // l'ancien, même si cette étape échoue (best-effort, juste un doublon à
  // nettoyer manuellement dans ce cas plutôt qu'un flux perdu).
  const unsubBody = new URLSearchParams({ ac: "unsubscribe", s: feed.streamId });
  await fetch(`${baseUrl}/api/greader.php/reader/api/0/subscription/edit`, {
    method: "POST",
    headers: { Authorization: `GoogleLogin auth=${token}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: unsubBody.toString()
  }).catch(() => {});

  return true;
}

/**
 * Point d'entrée appelé périodiquement par le worker (voir worker/index.ts),
 * indépendamment du planning IA (mode auto/manuel) — zéro coût de token,
 * juste de la maintenance réseau. Ne touche qu'aux abonnements pointant
 * directement vers reddit.com : un abonnement déjà basculé sur un miroir
 * Redlib n'est pas re-testé ici (si ce miroir tombe à son tour à l'avenir,
 * ça remontera plutôt comme "plus de nouveaux articles Reddit" à surveiller
 * manuellement, plutôt que de faire sauter un abonnement en boucle).
 */
export async function healthCheckRedditFeeds(): Promise<{ checked: number; switched: string[] }> {
  const auth = await login();
  if (!auth) return { checked: 0, switched: [] };
  const { baseUrl, token } = auth;

  const feeds = await listFeedsWithUrl(baseUrl, token);
  const redditFeeds = feeds.filter((f) => {
    try {
      return isRedditHostname(new URL(f.url).hostname);
    } catch {
      return false;
    }
  });

  const switched: string[] = [];
  for (const feed of redditFeeds) {
    if (await probeFeedUrl(feed.url)) continue; // toujours accessible, rien à faire

    console.log(`[reddit-feed-health] "${feed.title}" (${feed.url}) ne répond plus — recherche d'un miroir…`);
    const mirror = await findWorkingMirror(feed.url);
    if (!mirror) {
      console.warn(`[reddit-feed-health] Aucun miroir Redlib disponible pour "${feed.title}".`);
      continue;
    }

    const success = await switchFeedUrl(baseUrl, token, feed, mirror);
    if (success) {
      console.log(`[reddit-feed-health] "${feed.title}" basculé vers ${mirror}`);
      switched.push(feed.title);
    } else {
      console.warn(`[reddit-feed-health] Échec du basculement de "${feed.title}" vers ${mirror}.`);
    }
  }

  return { checked: redditFeeds.length, switched };
}
