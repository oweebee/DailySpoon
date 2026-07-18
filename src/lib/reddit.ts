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
