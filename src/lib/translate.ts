import { BROWSER_USER_AGENT } from "./text";

/**
 * Traduction automatique, sans clé API, utilisée pour afficher en français
 * les vignettes "En direct" des flux cochés "traduction" dans
 * /admin/categories (voir TranslateFeed / syncTranslateFlags).
 *
 * POURQUOI MYMEMORY ET PLUS GOOGLE — Ce module appelait à l'origine le point
 * d'accès non officiel de translate.google.com (translate_a/single, celui que
 * le site utilise en coulisses). Il a cessé de répondre depuis les IP
 * d'hébergeur : vérifié en usage réel sur ce serveur — 100 % d'échecs sur la
 * traduction alors que les flux RSS se récupéraient normalement (donc réseau
 * sortant parfaitement fonctionnel), et reproduit depuis une autre machine
 * d'hébergeur, où le même appel renvoie une réponse vide. Essayer un second
 * hôte Google (clients5.google.com) n'y change rien : c'est un filtrage par
 * IP, pas un problème d'hôte. MyMemory, lui, répond normalement depuis ces
 * mêmes IP — d'où la bascule. Google reste tenté en DERNIER recours, au cas
 * où l'accès rouvrirait ou que le code tourne un jour depuis une IP
 * résidentielle : ça ne coûte rien tant que MyMemory répond, puisqu'on ne
 * l'atteint jamais.
 */

const TIMEOUT_MS = 8000;

// MyMemory refuse les requêtes dont le paramètre "q" dépasse 500 OCTETS (pas
// caractères : un accent en UTF-8 en compte 2). On découpe donc les textes
// longs — un extrait d'article dépasse couramment cette taille — avec une
// marge de sécurité confortable sous la limite.
const MYMEMORY_MAX_BYTES = 450;

const GOOGLE_ENDPOINTS = ["https://translate.googleapis.com", "https://clients5.google.com"];

// Intervalle MINIMUM entre deux requêtes vers MyMemory, tous appelants
// confondus. Le service répond 429 ("trop de requêtes") dès qu'on l'attaque
// en rafale : constaté en usage réel — 54 traductions lancées coup sur coup,
// 54 échecs en 429. Ce n'est pas un quota mais une cadence, et rien ne sert
// de réessayer plus vite. File d'attente en série (voir throttle) plutôt
// qu'un simple délai par appel : les traductions partent de plusieurs
// endroits en parallèle, seule une file partagée garantit la cadence.
const MYMEMORY_MIN_INTERVAL_MS = 400;

let throttleChain: Promise<void> = Promise.resolve();

/** Sérialise les appels et garantit MYMEMORY_MIN_INTERVAL_MS entre chacun. */
function throttle(): Promise<void> {
  const ready = throttleChain;
  throttleChain = ready.then(() => new Promise((resolve) => setTimeout(resolve, MYMEMORY_MIN_INTERVAL_MS)));
  return ready;
}

export type TranslateResult = { ok: true; text: string } | { ok: false; reason: string };

export type TranslateOptions = {
  targetLang?: string;
  /** Adresse transmise à MyMemory (paramètre "de="), qui fait passer le quota
   *  gratuit de 5 000 à 50 000 caractères par jour. Vide/absente = aucune
   *  adresse envoyée. Vient de Settings.translateEmail (/admin/settings). */
  email?: string;
};

/**
 * Découpe un texte en morceaux d'au plus `maxBytes` octets, en coupant de
 * préférence à une fin de phrase, sinon entre deux mots — jamais au milieu
 * d'un mot tant qu'un espace est disponible. Mesure en OCTETS et non en
 * caractères : c'est ce que compte la limite de MyMemory.
 */
export function chunkForTranslation(text: string, maxBytes = MYMEMORY_MAX_BYTES): string[] {
  const chunks: string[] = [];
  let rest = text.trim();

  while (Buffer.byteLength(rest, "utf8") > maxBytes) {
    // Plus grand préfixe tenant dans maxBytes octets. On part d'une borne en
    // caractères (au pire 1 octet = 1 caractère) puis on réduit tant que ça
    // dépasse — quelques itérations tout au plus.
    let cut = Math.min(rest.length, maxBytes);
    while (cut > 0 && Buffer.byteLength(rest.slice(0, cut), "utf8") > maxBytes) cut -= 1;

    const window = rest.slice(0, cut);
    // Fin de phrase la plus tardive dans la fenêtre ; on ne l'accepte que si
    // elle n'est pas ridiculement tôt (sinon on gaspillerait la requête sur
    // trois mots), auquel cas on se rabat sur la dernière espace.
    let split = Math.max(window.lastIndexOf(". "), window.lastIndexOf("! "), window.lastIndexOf("? "));
    if (split > cut * 0.4) {
      split += 1; // garde la ponctuation avec la phrase qu'elle termine
    } else {
      split = window.lastIndexOf(" ");
    }
    if (split <= 0) split = cut; // un seul "mot" démesuré : coupe franche

    const piece = rest.slice(0, split).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(split).trim();
  }

  if (rest) chunks.push(rest);
  return chunks;
}

/**
 * MyMemory signale certaines erreurs (quota épuisé, requête trop longue) avec
 * un HTTP 200 et un message d'avertissement EN GUISE DE TRADUCTION. Sans ce
 * garde-fou, on enregistrerait ce message comme titre d'article.
 */
function looksLikeMyMemoryWarning(text: string): boolean {
  return /MYMEMORY WARNING|QUERY LENGTH LIMIT|ALL AVAILABLE FREE TRANSLATIONS/i.test(text);
}

async function myMemoryChunk(text: string, targetLang: string, email?: string): Promise<TranslateResult> {
  const params = new URLSearchParams({ q: text, langpair: `Autodetect|${targetLang}` });
  if (email) params.set("de", email);

  await throttle();

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`, {
      signal: controller.signal,
      headers: { "User-Agent": BROWSER_USER_AGENT }
    });
    if (res.status === 429) {
      // 429 chez MyMemory = plafond atteint. Deux causes possibles, et le
      // service ne les distingue pas : le quota JOURNALIER en caractères
      // (5 000 sans adresse e-mail renseignée, 50 000 avec — voir
      // Settings.translateEmail) ou la CADENCE (voir throttle plus haut).
      // Message explicite : sans lui, /admin/logs affiche un code HTTP nu
      // qui n'indique pas la seule action réellement utile.
      return {
        ok: false,
        reason: email
          ? "mymemory 429 — quota journalier (50 000 caractères) atteint, reprise demain"
          : "mymemory 429 — quota journalier de 5 000 caractères atteint : renseigne un e-mail dans /admin/settings → Traduction pour passer à 50 000"
      };
    }
    if (!res.ok) return { ok: false, reason: `mymemory HTTP ${res.status}` };

    const data: any = await res.json().catch(() => null);
    const status = String(data?.responseStatus ?? "");
    if (status && status !== "200") {
      return { ok: false, reason: `mymemory statut ${status}${data?.responseDetails ? ` (${data.responseDetails})` : ""}` };
    }
    if (data?.quotaFinished === true) return { ok: false, reason: "mymemory quota du jour épuisé" };

    const translated = typeof data?.responseData?.translatedText === "string" ? data.responseData.translatedText : "";
    if (!translated.trim()) return { ok: false, reason: "mymemory réponse vide" };
    if (looksLikeMyMemoryWarning(translated)) return { ok: false, reason: `mymemory: ${translated.slice(0, 120)}` };

    return { ok: true, text: translated };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? "mymemory timeout" : `mymemory ${err?.message || "échec réseau"}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

async function viaMyMemory(text: string, targetLang: string, email?: string): Promise<TranslateResult> {
  const chunks = chunkForTranslation(text);
  const out: string[] = [];
  // En série (et non en parallèle) : les morceaux appartiennent au MÊME texte,
  // et enchaîner d'un coup plusieurs requêtes vers un service gratuit est le
  // meilleur moyen de se faire limiter. Le parallélisme utile est géré un
  // cran au-dessus, entre articles (voir TRANSLATE_CONCURRENCY dans
  // generateEdition.ts).
  for (const chunk of chunks) {
    const result = await myMemoryChunk(chunk, targetLang, email);
    // Un seul morceau en échec invalide tout le texte : mieux vaut renvoyer
    // un échec net (l'article sera simplement retenté au prochain passage)
    // qu'un texte à moitié traduit, à moitié en anglais.
    if (!result.ok) return result;
    out.push(result.text);
  }
  return { ok: true, text: out.join(" ") };
}

async function viaGoogle(baseUrl: string, text: string, targetLang: string): Promise<TranslateResult> {
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
    const segments = data?.[0];
    if (!Array.isArray(segments)) return { ok: false, reason: `${host} réponse illisible` };
    const translated = segments.map((seg: any) => seg?.[0] ?? "").join("");
    if (!translated.trim()) return { ok: false, reason: `${host} réponse vide` };
    return { ok: true, text: translated };
  } catch (err: any) {
    const reason = err?.name === "AbortError" ? `${host} timeout` : `${host} ${err?.message || "échec réseau"}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Essaie les fournisseurs dans l'ordre et renvoie soit la traduction, soit la
 * raison précise de chaque échec — remontée telle quelle dans /admin/logs
 * (voir syncTranslateFlags), seul moyen de distinguer un service injoignable
 * d'un quota épuisé ou d'un simple backfill pas encore terminé.
 */
export async function translateDetailed(text: string, options: TranslateOptions = {}): Promise<TranslateResult> {
  if (!text || !text.trim()) return { ok: false, reason: "texte vide" };
  const targetLang = options.targetLang || "fr";

  const reasons: string[] = [];

  const primary = await viaMyMemory(text, targetLang, options.email);
  if (primary.ok) return primary;
  reasons.push(primary.reason);

  // Plafond atteint : inutile d'aller taper chez Google derrière. Il est de
  // toute façon bloqué depuis les IP d'hébergeur (429 lui aussi), et
  // insister ajoutait DEUX requêtes vouées à l'échec pour CHAQUE texte —
  // soit une centaine d'appels inutiles par passage, qui ne faisaient
  // qu'aggraver la limitation de cadence.
  if (primary.reason.includes("429")) return { ok: false, reason: primary.reason };

  // Repli Google — voir le commentaire de tête : bloqué depuis les IP
  // d'hébergeur au moment où ces lignes sont écrites, gardé au cas où.
  // Ignoré pour les textes longs : sans découpage, un texte de plusieurs
  // milliers de caractères dans l'URL se ferait de toute façon rejeter.
  if (Buffer.byteLength(text, "utf8") <= 1500) {
    for (const baseUrl of GOOGLE_ENDPOINTS) {
      const result = await viaGoogle(baseUrl, text, targetLang);
      if (result.ok) return result;
      reasons.push(result.reason);
    }
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
export async function translateOrNull(text: string, options: TranslateOptions = {}): Promise<string | null> {
  const result = await translateDetailed(text, options);
  return result.ok ? result.text : null;
}

/**
 * Variante "best-effort" qui retombe sur le texte d'origine plutôt que de
 * casser l'affichage — réservée à la traduction à la demande de l'article
 * ouvert (article-proxy), où mieux vaut afficher l'anglais qu'une page vide.
 */
export async function translateViaGoogle(text: string, options: TranslateOptions = {}): Promise<string> {
  return (await translateOrNull(text, options)) ?? text;
}
