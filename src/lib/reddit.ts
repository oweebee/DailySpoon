import { prisma } from "./prisma";

/**
 * Miroirs publics Redlib (front-end alternatif à Reddit, scrape sa propre
 * infrastructure) — partagés entre la lecture d'un article individuel
 * (article-proxy), le flux perso pointant directement vers reddit.com
 * (customFeeds.ts) et le contournement de blocage au niveau d'un ABONNEMENT
 * FreshRSS (redditFeedHealth.ts). Reddit bloque désormais la quasi-totalité
 * des requêtes serveur-à-serveur (RSS compris) avec un 403, quel que soit le
 * User-Agent — blocage réseau/IP, pas seulement JS.
 *
 * La liste change de fiabilité dans le temps (une instance publique peut
 * tomber, se mettre derrière Cloudflare/Anubis, etc.) — voir
 * getRedlibInstances() plus bas, qui la rafraîchit automatiquement au lieu
 * de dépendre d'une liste figée en dur.
 */

export function isRedditHostname(hostname: string): boolean {
  return /(^|\.)reddit\.com$/i.test(hostname);
}

// Les posts Reddit à média (image/vidéo) donnent souvent, dans le flux RSS
// (surtout via un miroir Redlib), un lien direct vers le CDN média de
// Reddit comme URL canonique de l'item — plutôt que le lien de la
// discussion (reddit.com/.../comments/...). Ces domaines ne sont ni des
// pages HTML classiques (Readability n'y trouve rien) ni embarquables en
// iframe (Reddit bloque X-Frame-Options même sur ces sous-domaines) : il
// faut les détecter à part pour les afficher directement plutôt que de
// tomber sur la page de repli iframe (cassée, voir article-proxy).
export function isRedditImageHostname(hostname: string): boolean {
  return /(^|\.)i\.redd\.it$/i.test(hostname) || /(^|\.)preview\.redd\.it$/i.test(hostname);
}

export function isRedditVideoHostname(hostname: string): boolean {
  return /(^|\.)v\.redd\.it$/i.test(hostname);
}

/** Reconstruit la même URL (chemin + query) sur un autre hôte — ex.
 *  https://redlib.catsarch.com + /r/france/.rss depuis
 *  https://www.reddit.com/r/france/.rss. Partagé entre redditFeedHealth.ts
 *  (bascule des abonnements FreshRSS) et customFeeds.ts (repli à la volée
 *  pour un flux personnalisé pointant directement vers reddit.com).
 *
 *  Force le suffixe ".rss" : les deux appelants sont des contextes de FLUX,
 *  or on colle très souvent l'URL de la PAGE Reddit telle qu'affichée dans
 *  le navigateur (".../r/SurvivalGaming/top/?t=week", sans ".rss"). Sans
 *  cette normalisation, le miroir répond du HTML tout à fait valide, que
 *  rss-parser rejette ensuite par "Feed not recognized as RSS 1 or 2" —
 *  erreur trompeuse qui ressemble à un miroir cassé alors que c'est juste
 *  la mauvaise URL qui a été demandée. La query (?t=week, tri temporel) est
 *  conservée telle quelle : Redlib la comprend aussi bien sur le flux. */
export function rehostRedditUrl(originalUrl: string, newBase: string): string | null {
  try {
    const parsed = new URL(originalUrl);
    let path = parsed.pathname;
    if (!/\.rss$/i.test(path)) {
      path = path.endsWith("/") ? `${path}.rss` : `${path}/.rss`;
    }
    return `${newBase}${path}${parsed.search}`;
  } catch {
    return null;
  }
}

// --- Cache auto-rafraîchi (RedlibInstanceCache) -----------------------

const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const OFFICIAL_INSTANCES_URL = "https://raw.githubusercontent.com/redlib-org/redlib-instances/main/instances.json";

// 6h : même cadence que healthCheckRedditFeeds (voir worker/index.ts), qui
// appelle refreshRedlibInstanceCache() juste avant de tester les abonnements
// FreshRSS eux-mêmes — la liste est donc toujours fraîche au moment où on en
// a besoin, sans jamais faire de sondage réseau depuis le chemin d'une
// requête utilisateur (voir getRedlibInstances(), qui ne fait que LIRE ce
// cache).
const REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

// Combien d'instances saines on garde au maximum, et combien de candidats on
// sonde au pire avant d'abandonner (liste officielle + repli statique) —
// borne dure pour qu'un rafraîchissement reste raisonnablement rapide même
// si la liste officielle grossit.
const MAX_HEALTHY_INSTANCES = 4;
const MAX_CANDIDATES_PROBED = 8;
const PROBE_TIMEOUT_MS = 6000;

// Dernier repli si TOUT échoue (cache vide ET liste officielle injoignable
// ET aucun candidat sondé ne répond) — vérifiée manuellement le 20/07/2026
// comme servant du vrai contenu Reddit (les 4 précédentes de cette liste —
// catsarch/privacyredirect/orangenet/privadency — ne répondaient plus DU
// TOUT à ce moment-là). Absente de la liste officielle
// (github.com/redlib-org/redlib-instances), ajoutée manuellement en tête des
// candidats sondés à chaque rafraîchissement.
const STATIC_FALLBACK = ["https://safereddit.com"];

async function fetchOfficialInstanceCandidates(): Promise<string[]> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch(OFFICIAL_INSTANCES_URL, { signal: controller.signal });
      if (!res.ok) return [];
      const data: any = await res.json();
      const list = Array.isArray(data?.instances) ? data.instances : [];
      return list
        // "cloudflare: true" = challenge JS quasi systématique pour une
        // requête serveur-à-serveur sans navigateur réel — inutile de
        // gaspiller un sondage dessus, voir aussi le filtre "anubis" dans
        // probeRedlibInstance ci-dessous pour les instances qui ne
        // l'annoncent pas mais le font quand même.
        .filter((entry: any) => typeof entry.url === "string" && !entry.cloudflare)
        .map((entry: any) => (entry.url as string).replace(/\/+$/, ""));
    } finally {
      clearTimeout(timeout);
    }
  } catch {
    return [];
  }
}

// Sonde légère : vérifie qu'une instance sert bien du vrai flux RSS/Atom
// (pas une page de challenge anti-bot) sur un chemin toujours public
// (r/popular), sans dépendre d'un abonnement particulier.
async function probeRedlibInstance(baseUrl: string): Promise<boolean> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/r/popular/.rss`, {
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

function safeParseList(json: string | null | undefined): string[] | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) && parsed.every((v) => typeof v === "string") && parsed.length > 0
      ? parsed
      : null;
  } catch {
    return null;
  }
}

/**
 * Sonde la liste officielle + le repli statique, et écrit le résultat dans
 * RedlibInstanceCache. Fait du réseau (jusqu'à MAX_CANDIDATES_PROBED sondages
 * de PROBE_TIMEOUT_MS chacun, au pire) — appelée UNIQUEMENT depuis le worker
 * (voir worker/index.ts, même créneau toutes les 6h que
 * healthCheckRedditFeeds), jamais depuis le chemin d'une requête utilisateur.
 * Best-effort : ne lève jamais, garde l'ancien cache si le rafraîchissement
 * ne trouve rien de sain.
 */
export async function refreshRedlibInstanceCache(): Promise<{ healthy: string[] }> {
  const existing = await prisma.redlibInstanceCache.findUnique({ where: { id: "singleton" } }).catch(() => null);

  const officialCandidates = await fetchOfficialInstanceCandidates();
  const candidates = [...STATIC_FALLBACK, ...officialCandidates].slice(0, MAX_CANDIDATES_PROBED);

  const healthy: string[] = [];
  for (const candidate of candidates) {
    if (healthy.length >= MAX_HEALTHY_INSTANCES) break;
    if (await probeRedlibInstance(candidate)) healthy.push(candidate);
  }

  const result = healthy.length > 0 ? healthy : safeParseList(existing?.instancesJson) ?? STATIC_FALLBACK;

  await prisma.redlibInstanceCache
    .upsert({
      where: { id: "singleton" },
      update: { instancesJson: JSON.stringify(result), checkedAt: new Date() },
      create: { id: "singleton", instancesJson: JSON.stringify(result), checkedAt: new Date() }
    })
    .catch(() => {});

  return { healthy: result };
}

/**
 * Lecture SEULE (pas de réseau) de la liste de miroirs Redlib actuellement
 * sains, pour tous les appelants (customFeeds.ts, article-proxy,
 * redditFeedHealth.ts). Si le cache n'a encore jamais été rempli (tout
 * premier démarrage, avant le premier tick du worker à minute 5) ou est trop
 * vieux (le worker semble à l'arrêt), retombe sur le repli statique plutôt
 * que de bloquer l'appelant avec un sondage réseau synchrone.
 */
export async function getRedlibInstances(): Promise<string[]> {
  const cached = await prisma.redlibInstanceCache.findUnique({ where: { id: "singleton" } }).catch(() => null);
  const parsed = safeParseList(cached?.instancesJson);
  if (parsed && cached && Date.now() - cached.checkedAt.getTime() < REFRESH_INTERVAL_MS * 4) {
    return parsed;
  }
  return parsed ?? STATIC_FALLBACK;
}
