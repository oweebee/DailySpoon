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
//
// SIMPLE PAR CONCEPTION : on envoie juste l'URL (nettoyée de ses paramètres de
// suivi, voir cleanArticleUrl) et on laisse WALLABAG faire son propre fetch +
// extraction — c'est son métier, il a son propre moteur (readability +
// fichiers de config par site). Une tentative précédente d'extraire l'article
// nous-mêmes côté serveur (fetch + Readability + nettoyage de chrome) s'est
// avérée inutile ET plus fragile : vérifié en direct, Wallabag récupère très
// bien ces mêmes articles quand l'URL est propre — le vrai bug n'était jamais
// "Wallabag n'y arrive pas", c'était l'URL polluée par ?utm_medium=feed qui
// perturbait son parseur basé sur des règles par domaine.

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

function escapeForHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Poste une entrée sur Wallabag (créée OU mise à jour : Wallabag déduplique
 *  par URL, un second POST sur la même URL met juste à jour l'entrée
 *  existante plutôt que d'en créer une seconde). Renvoie la longueur du
 *  contenu que WALLABAG a réussi à en tirer, pour savoir si son propre fetch
 *  a fonctionné. */
async function postEntry(
  creds: WallabagCreds,
  token: string,
  url: string,
  content?: string,
  title?: string | null
): Promise<{ contentLen: number }> {
  const payload: Record<string, unknown> = { url, tags: WALLABAG_TAG };
  if (content) {
    payload.content = content;
    if (title) payload.title = title;
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
 * Envoie best-effort un lien d'article à Wallabag, à partir des réglages
 * enregistrés (getSettings). NE LÈVE JAMAIS : conçu pour être appelé depuis la
 * route de mise en favori sans jamais faire échouer cette dernière — un
 * problème Wallabag (mal configuré, hors-ligne...) ne doit pas empêcher de
 * mettre un article en favori localement. En cas d'échec, on trace juste un
 * avertissement dans /admin/logs. Ne fait rien (silencieusement) si
 * l'intégration n'est pas configurée.
 *
 * Envoie l'URL SEULE d'abord — Wallabag fait son propre fetch/extraction
 * (vérifié en direct : ça marche très bien une fois l'URL nettoyée de ses
 * paramètres de suivi). Si son fetch échoue quand même (contenu vide/trop
 * court en retour), on retente en fournissant `fallback.excerpt` (déjà en
 * base, capturé sans réseau à l'ingestion) comme filet de sécurité — mieux
 * qu'une entrée totalement vide, sans machinerie d'extraction côté serveur.
 */
export async function sendFavoriteToWallabag(
  articleUrl: string,
  fallback?: { title?: string | null; excerpt?: string | null }
): Promise<void> {
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

  // URL nettoyée des paramètres de suivi (utm_*, fbclid…) : c'est cette forme
  // canonique que le parseur de Wallabag sait exploiter.
  const cleanUrl = cleanArticleUrl(articleUrl);

  try {
    const token = await getAccessToken(creds);
    const first = await postEntry(creds, token, cleanUrl);

    if (first.contentLen >= MIN_WALLABAG_CONTENT) {
      await writeLog("info", "wallabag", `Article envoyé à Wallabag : ${cleanUrl}`, `Wallabag a extrait le contenu (${first.contentLen}o)`);
      return;
    }

    // Wallabag n'a rien pu tirer de son côté : filet de sécurité avec
    // l'extrait déjà en base, si on en a un.
    if (fallback?.excerpt?.trim()) {
      await postEntry(creds, token, cleanUrl, `<p>${escapeForHtml(fallback.excerpt.trim())}</p>`, fallback.title);
      await writeLog(
        "warn",
        "wallabag",
        `Article envoyé à Wallabag : ${cleanUrl}`,
        `Wallabag n'a rien extrait (${first.contentLen}o) — extrait du flux fourni en repli`
      );
    } else {
      await writeLog(
        "warn",
        "wallabag",
        `Article envoyé à Wallabag : ${cleanUrl}`,
        `Wallabag n'a rien extrait (${first.contentLen}o) et aucun extrait de repli disponible`
      );
    }
  } catch (err) {
    await writeLog(
      "warn",
      "wallabag",
      `Échec de l'envoi à Wallabag : ${(err as Error)?.message || "erreur inconnue"}`,
      cleanUrl
    );
  }
}
