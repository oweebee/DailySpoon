import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { getSettings } from "./settings";
import { writeLog } from "./logger";
import { cleanArticleUrl } from "./text";

// Intégration Wallabag (read-it-later auto-hébergé). Wallabag n'expose pas de
// simple clé API : chaque appel exige un access_token OAuth2 obtenu via un
// "password grant" (client id/secret créés dans Wallabag → API clients
// management, PLUS l'identifiant/mot de passe du compte). On récupère donc
// d'abord un token, puis on poste l'URL de l'article sur /api/entries.json.
//
// Volontairement SANS cache de token entre les appels : un favori est un
// événement rare et isolé (un clic humain), pas une boucle à haut débit —
// re-demander un token à chaque envoi coûte un aller-retour négligeable et
// évite tout la complexité (invalidation, expiration, concurrence) d'un cache
// de token à durée de vie limitée (expires_in ~1h).

export type WallabagCreds = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  username: string;
  password: string;
};

export type WallabagResult = { ok: boolean; message: string };

/** true seulement si les 5 champs nécessaires sont renseignés — sinon
 *  l'intégration est considérée comme inactive (le favori ne fait rien de
 *  plus qu'avant, aucun appel réseau tenté). */
export function isWallabagConfigured(creds: Partial<WallabagCreds>): creds is WallabagCreds {
  return Boolean(
    creds.baseUrl && creds.clientId && creds.clientSecret && creds.username && creds.password
  );
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

/** Obtient un access_token OAuth2 (password grant). Lève une Error avec un
 *  message lisible (repris tel quel dans le bouton "Tester la connexion") en
 *  cas d'échec — identifiants faux, instance injoignable, etc. */
async function getAccessToken(creds: WallabagCreds): Promise<string> {
  // Corps en application/x-www-form-urlencoded : le format le plus largement
  // accepté par le point /oauth/v2/token de Wallabag (le JSON n'est pas
  // garanti selon les versions).
  const body = new URLSearchParams({
    grant_type: "password",
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    username: creds.username,
    password: creds.password
  });

  let res: Response;
  try {
    res = await fetchWithTimeout(
      `${creds.baseUrl}/oauth/v2/token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body
      },
      12000
    );
  } catch (err) {
    throw new Error(`Instance Wallabag injoignable (${(err as Error)?.message || "réseau"}).`);
  }

  const data: any = await res.json().catch(() => ({}));
  if (!res.ok || !data?.access_token) {
    // Wallabag renvoie souvent un "error_description" explicite (ex.
    // "Invalid credentials.", "The client credentials are invalid.")
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`Authentification Wallabag refusée : ${detail}`);
  }
  return data.access_token as string;
}

// User-Agent "navigateur" pour l'extraction : certains sites renvoient une
// page vide/allégée à un UA inconnu (c'est justement ce qui fait échouer le
// fetch interne de Wallabag sur des sites comme korben.info/gamekult).
const BROWSER_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const MIN_EXTRACTED_TEXT = 200; // en-deçà, on considère l'extraction ratée

export type ExtractedArticle = { title: string | null; content: string };

/** Récupère la page et en extrait l'article propre (Readability, même techno
 *  que /api/article-proxy et Firefox Reader View). Renvoie le HTML de l'article
 *  + son titre, ou null si le fetch échoue ou si le contenu extrait est trop
 *  maigre. Best effort : ne lève jamais. */
async function extractArticle(url: string): Promise<ExtractedArticle | null> {
  let res: Response;
  try {
    res = await fetchWithTimeout(
      url,
      { headers: { "User-Agent": BROWSER_UA, Accept: "text/html,application/xhtml+xml,*/*" } },
      12000
    );
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const ct = res.headers.get("content-type") || "";
  if (ct && !/text\/html|xml/i.test(ct)) return null;

  let html: string;
  try {
    html = await res.text();
  } catch {
    return null;
  }
  if (!html || html.length < 500) return null;

  try {
    const dom = new JSDOM(html, { url });
    const article = new Readability(dom.window.document).parse();
    const text = article?.content?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim() || "";
    if (article?.content && text.length >= MIN_EXTRACTED_TEXT) {
      return { title: article.title?.trim() || null, content: article.content };
    }
  } catch {
    /* Readability/jsdom en échec : on renverra null (envoi URL seule). */
  }
  return null;
}

// Tag posé sur chaque entrée créée depuis DailySpoon — permet de retrouver/
// filtrer dans Wallabag tout ce qui vient d'ici (l'API accepte "tags" en
// chaîne de libellés séparés par des virgules ; un seul ici). Wallabag crée
// le tag automatiquement s'il n'existe pas encore.
const WALLABAG_TAG = "DailySpoon";

/** Poste une URL d'article sur Wallabag (l'archive/le "traite" côté Wallabag,
 *  avec sa propre extraction de contenu), en le marquant du tag DailySpoon.
 *  Wallabag déduplique lui-même par URL : renvoyer deux fois la même URL ne
 *  crée pas de doublon, il met à jour l'entrée existante (et lui ajoute le tag
 *  s'il manquait) — donc re-cocher un favori déjà envoyé est sans risque. */
async function postEntry(
  creds: WallabagCreds,
  token: string,
  url: string,
  extracted?: ExtractedArticle | null
): Promise<void> {
  const payload: Record<string, unknown> = { url, tags: WALLABAG_TAG };
  // Si on a réussi à extraire l'article, on le fournit directement : Wallabag
  // l'enregistre tel quel SANS re-fetcher la page (cf. doc API, champ
  // "content") — ce qui règle le cas des sites dont SON fetch interne ne tire
  // rien (korben.info, gamekult…) alors que le nôtre y arrive.
  if (extracted?.content) {
    payload.content = extracted.content;
    if (extracted.title) payload.title = extracted.title;
  }
  const res = await fetchWithTimeout(
    `${creds.baseUrl}/api/entries.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify(payload)
    },
    12000
  );
  if (!res.ok) {
    const data: any = await res.json().catch(() => ({}));
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`Wallabag a refusé l'article : ${detail}`);
  }
}

/** Teste la connexion (bouton de /admin/settings) : tente juste d'obtenir un
 *  token, SANS envoyer d'article. Prend les identifiants du formulaire (pas
 *  forcément déjà enregistrés), comme le reste de /admin/settings. */
export async function testWallabagConnection(creds: WallabagCreds): Promise<WallabagResult> {
  try {
    await getAccessToken(creds);
    return { ok: true, message: "Connexion réussie — identifiants OAuth2 valides." };
  } catch (err) {
    return { ok: false, message: (err as Error)?.message || "Échec de la connexion." };
  }
}

/**
 * Envoie best-effort un lien d'article à Wallabag, à partir des réglages
 * enregistrés (getSettings). NE LÈVE JAMAIS : conçu pour être appelé depuis la
 * route de mise en favori sans jamais faire échouer cette dernière — un
 * problème Wallabag (mal configuré, hors-ligne...) ne doit pas empêcher de
 * mettre un article en favori localement. En cas d'échec, on trace juste un
 * avertissement dans /admin/logs. Ne fait rien (silencieusement) si
 * l'intégration n'est pas configurée.
 */
export async function sendFavoriteToWallabag(articleUrl: string): Promise<void> {
  if (!articleUrl) return;
  const s = await getSettings();
  const creds: Partial<WallabagCreds> = {
    baseUrl: s.wallabagBaseUrl,
    clientId: s.wallabagClientId,
    clientSecret: s.wallabagClientSecret,
    username: s.wallabagUsername,
    password: s.wallabagPassword
  };
  if (!isWallabagConfigured(creds)) return; // intégration inactive : aucun appel

  // URL nettoyée des paramètres de suivi (utm_*, fbclid…) : forme canonique.
  const cleanUrl = cleanArticleUrl(articleUrl);

  // On extrait le contenu nous-mêmes pour le fournir à Wallabag (voir
  // postEntry). D'abord en direct ; si ça échoue et qu'une instance morss est
  // configurée, on retente via morss (qui fetch depuis SA propre IP, utile
  // quand le site bloque les requêtes serveur directes). Si tout échoue, on
  // enverra quand même l'URL seule et Wallabag tentera son propre fetch.
  let extracted = await extractArticle(cleanUrl);
  if (!extracted && s.morssBaseUrl) {
    extracted = await extractArticle(`${s.morssBaseUrl}/${cleanUrl}`);
  }

  try {
    const token = await getAccessToken(creds);
    await postEntry(creds, token, cleanUrl, extracted);
    await writeLog(
      "info",
      "wallabag",
      `Article envoyé à Wallabag : ${cleanUrl}`,
      extracted ? "contenu extrait fourni (pas de re-fetch Wallabag)" : "URL seule (extraction échouée, Wallabag fetchera)"
    );
  } catch (err) {
    await writeLog(
      "warn",
      "wallabag",
      `Échec de l'envoi à Wallabag : ${(err as Error)?.message || "erreur inconnue"}`,
      cleanUrl
    );
  }
}
