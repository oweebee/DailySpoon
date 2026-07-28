/**
 * Garde anti-SSRF partagée par les proxies (/api/image-proxy, /api/video-proxy,
 * /api/article-proxy) : ces routes font des requêtes RÉSEAU CÔTÉ SERVEUR vers
 * des URL qui proviennent en dernière analyse des flux RSS (images, liens
 * d'articles) — un flux malveillant (ou compromis) pourrait donc y glisser des
 * URL pointant vers le réseau INTERNE de l'hébergeur (localhost, autres
 * conteneurs Docker/Coolify, métadonnées cloud 169.254.169.254...) et utiliser
 * DailySpoon comme relai pour les atteindre.
 *
 * On bloque les cibles manifestement internes : loopback, plages IP privées
 * (RFC 1918), link-local, et les noms d'hôte sans domaine (résolus via le DNS
 * interne du réseau Docker). Volontairement SANS résolution DNS préalable
 * (pas de protection anti-rebinding complète) : simple, sans latence ajoutée,
 * et couvre les vecteurs réalistes pour une app personnelle auto-hébergée —
 * les routes restent par ailleurs derrière le mot de passe admin (middleware).
 */

const PRIVATE_IPV4_RANGES: Array<[number, number]> = [
  // [base réseau, nombre de bits du préfixe]
  [0x00000000, 8], // 0.0.0.0/8 ("this network")
  [0x0a000000, 8], // 10.0.0.0/8
  [0x7f000000, 8], // 127.0.0.0/8 (loopback)
  [0xa9fe0000, 16], // 169.254.0.0/16 (link-local, dont métadonnées cloud)
  [0xac100000, 12], // 172.16.0.0/12
  [0xc0a80000, 16] // 192.168.0.0/16
];

function ipv4ToInt(host: string): number | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function isPrivateIpv4(host: string): boolean {
  const ip = ipv4ToInt(host);
  if (ip === null) return false;
  return PRIVATE_IPV4_RANGES.some(([base, bits]) => ip >>> (32 - bits) === base >>> (32 - bits));
}

function isPrivateIpv6(host: string): boolean {
  // Forme URL : entre crochets, ex. "[::1]" — URL.hostname les garde.
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h.includes(":")) return false; // pas une IPv6
  if (h === "::" || h === "::1") return true; // unspecified / loopback
  // fc00::/7 (ULA), fe80::/10 (link-local), ::ffff:x.x.x.x (IPv4 mappée)
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe8") || h.startsWith("fe9") || h.startsWith("fea") || h.startsWith("feb")) {
    return true;
  }
  const v4 = /::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/.exec(h);
  if (v4) return isPrivateIpv4(v4[1]);
  return false;
}

/**
 * true si cette URL ne doit PAS être récupérée côté serveur. À appeler après
 * la validation de protocole http/https déjà en place dans chaque proxy.
 */
export function isForbiddenProxyTarget(parsed: URL): boolean {
  const host = parsed.hostname.toLowerCase();

  // Loopback et alias évidents.
  if (host === "localhost" || host.endsWith(".localhost")) return true;
  // Suffixes réservés aux réseaux internes (mDNS, Docker/K8s internes).
  if (host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".lan")) return true;
  // Nom d'hôte SANS point ("intranet", "coolify", nom d'un conteneur
  // voisin...) : jamais légitime pour une image/un article public.
  if (!host.includes(".") && !host.includes(":")) return true;

  if (isPrivateIpv4(host)) return true;
  if (isPrivateIpv6(host)) return true;

  return false;
}
