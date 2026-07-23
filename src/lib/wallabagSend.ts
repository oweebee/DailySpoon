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
//
// LE PLUS SIMPLE POSSIBLE, PAR CONCEPTION : on envoie le lien de l'article
// EXACTEMENT comme il est stocké (article.sourceUrl), SANS AUCUNE
// modification (ni nettoyage de paramètres, ni contenu de repli fourni à sa
// place) — Wallabag reçoit le même lien que si on le collait à la main ou
// via l'extension Wallabagger en navigant normalement, et fait 100% du
// travail lui-même (son propre fetch + extraction, avec ses fichiers de
// config par site). Si son fetch échoue, on réessaie plusieurs fois (lui
// redonner sa chance, pas lui substituer notre propre texte) ; s'il échoue
// quand même après ça, l'entrée reste dans l'état où Wallabag lui-même
// l'aurait laissée (page "impossible de récupérer le contenu", avec son
// bouton "Réessayer" natif) — DailySpoon ne réécrit jamais le contenu à sa
// place.

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

// Tag posé sur chaque entrée créée depuis DailySpoon — permet de retrouver/
// filtrer dans Wallabag tout ce qui vient d'ici (l'API accepte "tags" en
// chaîne de libellés séparés par des virgules ; un seul ici). Wallabag crée
// le tag automatiquement s'il n'existe pas encore.
const WALLABAG_TAG = "DailySpoon";

const MIN_WALLABAG_CONTENT = 200; // en-deçà, on considère que le fetch de Wallabag a échoué

/** Poste le lien tel quel sur Wallabag (créé OU mis à jour : Wallabag
 *  déduplique par URL, un second POST sur la même URL met juste à jour
 *  l'entrée existante plutôt que d'en créer une seconde). AUCUN champ
 *  "content" n'est jamais envoyé : Wallabag fait TOUJOURS son propre fetch.
 *  Renvoie la longueur du contenu qu'il en a tiré, pour savoir si ça a
 *  marché. */
async function postEntry(creds: WallabagCreds, token: string, url: string): Promise<{ contentLen: number }> {
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
    15000
  );
  const data: any = await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data?.error_description || data?.error || `HTTP ${res.status}`;
    throw new Error(`Wallabag a refusé l'article : ${detail}`);
  }
  return { contentLen: (data?.content || "").length };
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
 * Envoie best-effort le lien D'ORIGINE d'un article à Wallabag, à partir des
 * réglages enregistrés (getSettings). NE LÈVE JAMAIS : conçu pour être appelé
 * depuis la route de mise en favori sans jamais faire échouer cette dernière
 * — un problème Wallabag (mal configuré, hors-ligne...) ne doit pas empêcher
 * de mettre un article en favori localement. En cas d'échec, on trace juste
 * un avertissement dans /admin/logs. Ne fait rien (silencieusement) si
 * l'intégration n'est pas configurée.
 *
 * Le lien envoyé est EXACTEMENT `article.sourceUrl`, sans aucune
 * modification. Si le fetch de Wallabag échoue, on lui redonne sa chance
 * plusieurs fois (espacé, en tâche de fond, jamais attendu par le clic
 * favori) — jamais on ne lui substitue un contenu maison.
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

  try {
    const token = await getAccessToken(creds);

    // korben.info (entre autres) bloque parfois l'IP du serveur de façon
    // intermittente — prouvé : le même lien a réussi puis échoué à quelques
    // heures d'écart. sendFavoriteToWallabag tourne en tâche de fond (jamais
    // attendu par la réponse HTTP du clic favori) : on peut donc redonner sa
    // chance à Wallabag plusieurs fois, espacé, sans ralentir l'interface.
    const RETRY_DELAYS_MS = [5000, 15000, 30000];
    let attempt = await postEntry(creds, token, articleUrl);
    let tries = 1;
    for (const delay of RETRY_DELAYS_MS) {
      if (attempt.contentLen >= MIN_WALLABAG_CONTENT) break;
      await new Promise((r) => setTimeout(r, delay));
      attempt = await postEntry(creds, token, articleUrl);
      tries++;
    }

    if (attempt.contentLen >= MIN_WALLABAG_CONTENT) {
      await writeLog(
        "info",
        "wallabag",
        `Article envoyé à Wallabag : ${articleUrl}`,
        `Wallabag a extrait le contenu lui-même (${attempt.contentLen}o, essai ${tries}/${RETRY_DELAYS_MS.length + 1})`
      );
    } else {
      // Échec définitif : on laisse Wallabag dans l'état où il se serait mis
      // tout seul (page "impossible de récupérer le contenu" + son propre
      // bouton "Réessayer") — jamais de contenu de repli imposé à sa place.
      await writeLog(
        "warn",
        "wallabag",
        `Article envoyé à Wallabag : ${articleUrl}`,
        `Wallabag n'a rien pu extraire après ${tries} essais (${attempt.contentLen}o) — laissé tel quel, réessayable depuis Wallabag`
      );
    }
  } catch (err) {
    await writeLog(
      "warn",
      "wallabag",
      `Échec de l'envoi à Wallabag : ${(err as Error)?.message || "erreur inconnue"}`,
      articleUrl
    );
  }
}
