// Uses the Web Crypto API (globalThis.crypto.subtle) instead of Node's
// "crypto" module on purpose: this file is imported from src/middleware.ts,
// which runs on the Next.js Edge Runtime and doesn't support Node built-ins.
// Web Crypto works the same way in both the Edge Runtime and Node 20+.

export const SESSION_COOKIE = "dailyspoon_session";

function secret(): string {
  // Falls back to ADMIN_PASSWORD itself if no dedicated secret is set —
  // fine for a single-admin personal deployment.
  return process.env.ADMIN_SECRET || process.env.ADMIN_PASSWORD || "dailyspoon-dev-secret";
}

async function hmacHex(message: string, key: string): Promise<string> {
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signature = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return Array.from(new Uint8Array(signature))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function sessionTokenForPassword(password: string): Promise<string> {
  return hmacHex(password, secret());
}

// Comparaison à temps constant : un simple "===" s'arrête au premier
// caractère différent, ce qui laisse (en théorie) mesurer combien de
// caractères du début sont corrects via le temps de réponse. XOR cumulé sur
// toute la longueur — le temps ne dépend plus du contenu.
function timingSafeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

/** Mot de passe admin configuré, ou null s'il ne l'est pas. Une chaîne vide
 *  compte comme "non configuré" : c'est ce que produit docker-compose quand
 *  la variable n'est pas renseignée côté Coolify (`'${ADMIN_PASSWORD}'` donne
 *  "" et non undefined), donc le cas le plus probable en pratique. */
function configuredPassword(): string | null {
  const value = process.env.ADMIN_PASSWORD;
  return value && value.length > 0 ? value : null;
}

/**
 * Que faire quand AUCUN mot de passe n'est configuré.
 *
 * En développement local, on laisse passer : c'est un confort assumé, on ne
 * veut pas devoir se connecter pour lancer `npm run dev`.
 *
 * En PRODUCTION, on refuse. Le middleware protège TOUT le site, pas seulement
 * /admin (voir src/middleware.ts) : laisser passer signifiait qu'une variable
 * d'environnement oubliée mettait en ligne une instance entièrement ouverte —
 * lecture, réglages, clés API, export de la configuration — avec pour seul
 * signal un avertissement noyé dans les logs du conteneur. Un défaut de
 * configuration doit fermer la porte, jamais l'ouvrir.
 *
 * Conséquence assumée : sans ADMIN_PASSWORD, une instance déployée est
 * inaccessible plutôt que grande ouverte. C'est le comportement voulu, et
 * l'écran de connexion l'explique (voir /api/admin/login).
 *
 * Exporté parce que l'API Google Reader (src/lib/greader.ts) court-circuite le
 * middleware — elle est dans PUBLIC_PATHS et fait sa propre vérification — et
 * doit donc appliquer EXACTEMENT la même règle. C'était la deuxième porte
 * ouverte, aussi grande que la première.
 */
export function allowWithoutPassword(): boolean {
  if (process.env.NODE_ENV === "production") {
    console.error(
      "[auth] ADMIN_PASSWORD n'est pas défini : accès refusé. " +
        "Renseigne cette variable d'environnement pour ouvrir le site."
    );
    return false;
  }
  console.warn("[auth] ADMIN_PASSWORD n'est pas défini — site ouvert (développement uniquement).");
  return true;
}

/** Vrai si le site tourne sans mot de passe configuré — sert à afficher un
 *  message explicite plutôt qu'un "mot de passe incorrect" trompeur. */
export function isPasswordConfigured(): boolean {
  return configuredPassword() !== null;
}

export function isCorrectPassword(password: string): boolean {
  const expected = configuredPassword();
  if (!expected) return allowWithoutPassword();
  return timingSafeEqual(password, expected);
}

export async function isValidSessionToken(token: string | undefined): Promise<boolean> {
  const expected = configuredPassword();
  if (!expected) return allowWithoutPassword();
  if (!token) return false;
  return timingSafeEqual(token, await sessionTokenForPassword(expected));
}
