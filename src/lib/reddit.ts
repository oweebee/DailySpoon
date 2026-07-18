/**
 * Miroirs publics Redlib (front-end alternatif à Reddit, scrape sa propre
 * infrastructure) — partagés entre la lecture d'un article individuel
 * (article-proxy) et le contournement de blocage au niveau du FLUX RSS
 * lui-même (redditFeedHealth.ts). Reddit bloque désormais la quasi-totalité
 * des requêtes serveur-à-serveur (RSS compris) avec un 403, quel que soit le
 * User-Agent — blocage réseau/IP, pas seulement JS.
 *
 * Non garanti dans la durée : une instance publique peut tomber, changer de
 * politique anti-bot, etc. Celles listées ici ont été vérifiées comme ne
 * posant pas de challenge JS (Anubis/Cloudflare) au moment de l'écriture ;
 * si toutes échouent, article-proxy retombe sur l'API JSON officielle de
 * Reddit, puis sur la page de repli.
 */
export const REDLIB_INSTANCES = [
  "https://redlib.catsarch.com",
  "https://redlib.privacyredirect.com",
  "https://redlib.orangenet.cc",
  "https://redlib.privadency.com"
];

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
