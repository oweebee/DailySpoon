import { getSettings } from "./settings";
import { writeLog } from "./logger";

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

// Paramètres de SUIVI ajoutés par les flux RSS / réseaux sociaux, à retirer
// avant d'envoyer l'URL à Wallabag. Sans ça, l'URL n'est pas la forme canonique
// de l'article : certains sites (ex. korben.info avec ?utm_medium=feed) servent
// une variante "flux" dont Wallabag n'extrait AUCUN contenu, alors que la même
// URL nettoyée — celle qu'on ajouterait à la main — fonctionne. On ne touche
// qu'aux paramètres de tracking ; les paramètres fonctionnels (?p=123, ?id=…)
// sont conservés.
const TRACKING_PREFIX = /^(utm_|mc_|pk_|ga_|hsa_|_hs|matomo_|piwik_)/i;
const TRACKING_EXACT = new Set([
  "fbclid", "gclid", "dclid", "gbraid", "wbraid", "gclsrc", "msclkid", "yclid",
  "twclid", "ttclid", "igshid", "mkt_tok", "mc_cid", "mc_eid", "_hsenc", "_hsmi"
]);

/** Retire les paramètres de suivi d'une URL d'article (voir ci-dessus). Best
 *  effort : si l'URL est malformée, on la renvoie telle quelle. */
export function cleanArticleUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const kept = new URLSearchParams();
    for (const [k, v] of u.searchParams) {
      if (TRACKING_PREFIX.test(k) || TRACKING_EXACT.has(k.toLowerCase())) continue;
      kept.append(k, v);
    }
    const qs = kept.toString();
    u.search = qs ? `?${qs}` : "";
    return u.toString();
  } catch {
    return raw;
  }
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
async function postEntry(creds: WallabagCreds, token: string, url: string): Promise<void> {
  const res = await fetchWithTimeout(
    `${creds.baseUrl}/api/entries.json`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${token}`
      },
      body: JSON.stringify({ url, tags: WALLABAG_TAG })
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

  // URL nettoyée des paramètres de suivi (utm_*, fbclid…) pour que Wallabag
  // reçoive la forme canonique de l'article et l'extraie correctement.
  const cleanUrl = cleanArticleUrl(articleUrl);

  try {
    const token = await getAccessToken(creds);
    await postEntry(creds, token, cleanUrl);
    await writeLog("info", "wallabag", `Article envoyé à Wallabag : ${cleanUrl}`);
  } catch (err) {
    await writeLog(
      "warn",
      "wallabag",
      `Échec de l'envoi à Wallabag : ${(err as Error)?.message || "erreur inconnue"}`,
      cleanUrl
    );
  }
}
