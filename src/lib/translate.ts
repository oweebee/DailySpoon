import { BROWSER_USER_AGENT } from "./text";

/**
 * Traduction gratuite et sans clé API, via les points d'accès publics non
 * officiels que translate.google.com utilise lui-même en coulisses. Partagée
 * entre deux usages :
 *   - la traduction À LA DEMANDE de l'article ouvert (lien "Traduire en
 *     français" dans le lecteur, voir article-proxy/route.ts) ;
 *   - le backfill AUTOMATIQUE du titre/extrait affiché en "En direct" pour
 *     les flux cochés "traduction" (voir syncTranslateFlags dans
 *     generateEdition.ts et TranslateFeed dans schema.prisma).
 *
 * PLUSIEURS hôtes essayés en cascade (voir ENDPOINTS) plutôt qu'un seul :
 * ces points d'accès filtrent selon l'IP appelante et refusent couramment
 * celles des hébergeurs/datacenters (429/403), alors qu'ils répondent sans
 * problème depuis une connexion résidentielle. Constaté en usage réel sur ce
 * projet : les flux RSS se récupéraient normalement (donc réseau sortant OK)
 * mais 100 % des traductions échouaient — le VPN du projet ne couvre que le
 * conteneur morss, pas web/worker d'où partent ces appels-ci. Deux hôtes
 * Google distincts servent la même API avec des règles de filtrage
 * différentes : quand l'un rejette l'IP, l'autre passe souvent.
 */

// Même chemin/paramètres/format de réponse pour les deux : seul l'hôte
// change, donc un seul analyseur suffit (voir parseGoogleResponse).
const ENDPOINTS = ["https://translate.googleapis.com", "https://clients5.google.com"];

const TIMEOUT_MS = 8000;

export type TranslateResult =
  | { ok: true; text: string }
  | { ok: false; reason: string };

function parseGoogleResponse(data: any): string | null {
  // Forme attendue : [[["traduit","original",...],[...]], ...] — on
  // reconcatène tous les segments, l'API découpe les textes longs.
  const segments = data?.[0];
  if (!Array.isArray(segments)) return null;
  const translated = segments.map((seg: any) => seg?.[0] ?? "").join("");
  return translated.trim() ? translated : null;
}

async function attempt(baseUrl: string, text: string, targetLang: string): Promise<TranslateResult> {
  const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLang, dt: "t", q: text });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const host = new URL(baseUrl).hostname;
  try {
    const res = await fetch(`${baseUrl}/translate_a/single?${params.toString()}`, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_USER_AGENT }
    });
    if (!res.ok) return { ok: false, reason: `${host} HTTP ${res.status}` };
    const data: any = await res.json().catch(() => null);
    const translated = data === null ? null : parseGoogleResponse(data);
    if (!translated) return { ok: false, reason: `${host} réponse illisible` };
    return { ok: true, text: translated };
  } catch (err: any) {
    // Distingue un vrai timeout (AbortError) d'une erreur réseau/DNS —
    // information décisive côté diagnostic : un timeout suggère un blocage
    // silencieux, une erreur DNS/connexion un souci de sortie réseau.
    const reason = err?.name === "AbortError" ? `${host} timeout` : `${host} ${err?.message || "échec réseau"}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Essaie chaque hôte à tour de rôle et renvoie soit la traduction, soit la
 * raison précise du dernier échec — utilisée pour le log de diagnostic dans
 * /admin/logs (voir syncTranslateFlags). Sans cette remontée d'erreur, un
 * échec total est indiscernable d'un backfill simplement pas encore terminé.
 */
export async function translateDetailed(text: string, targetLang = "fr"): Promise<TranslateResult> {
  if (!text || !text.trim()) return { ok: false, reason: "texte vide" };

  const reasons: string[] = [];
  for (const baseUrl of ENDPOINTS) {
    const result = await attempt(baseUrl, text, targetLang);
    if (result.ok) return result;
    reasons.push(result.reason);
  }
  return { ok: false, reason: reasons.join(" / ") };
}

/**
 * Renvoie la traduction, ou null en cas d'échec — le null est ESSENTIEL pour
 * le backfill "En direct" (syncTranslateFlags), qui enregistre le résultat en
 * base : une variante qui retomberait sur le texte d'origine en cas d'échec
 * stockerait l'anglais comme "traduction", et l'article, n'ayant alors plus
 * un champ vide, ne serait plus jamais retenté (bug constaté en usage réel).
 */
export async function translateOrNull(text: string, targetLang = "fr"): Promise<string | null> {
  const result = await translateDetailed(text, targetLang);
  return result.ok ? result.text : null;
}

/**
 * Variante "best-effort" qui retombe sur le texte d'origine plutôt que de
 * casser l'affichage — réservée à la traduction à la demande de l'article
 * ouvert (article-proxy), où mieux vaut afficher l'anglais qu'une page vide.
 */
export async function translateViaGoogle(text: string, targetLang = "fr"): Promise<string> {
  return (await translateOrNull(text, targetLang)) ?? text;
}
