/**
 * Traduction automatique des vignettes "En direct" pour les flux cochés
 * "traduction" dans /admin/categories (voir TranslateFeed /
 * syncTranslateFlags), via une instance LibreTranslate AUTO-HÉBERGÉE —
 * conteneur déployé séparément, dont l'adresse se règle dans
 * /admin/settings → Traduction (Settings.libretranslateUrl).
 *
 * POURQUOI UN SEUL MOTEUR, ET AUTO-HÉBERGÉ — Ce module a successivement
 * essayé trois services externes, tous abandonnés pour de bonnes raisons :
 *   - le point d'accès non officiel de translate.google.com a cessé de
 *     répondre depuis les IP d'hébergeur (100 % d'échecs en usage réel,
 *     reproduit depuis une autre machine d'hébergeur) ;
 *   - MyMemory est plafonné à 50 000 caractères par jour ET limité en
 *     cadence, ce qui refusait des lots entiers ;
 *   - DeepL n'offre qu'un crédit UNIQUE d'un million de caractères, donc
 *     quelques semaines d'autonomie, pas une solution durable.
 * Une instance locale n'a aucune de ces limites : ni quota, ni cadence, ni
 * longueur maximale, ni blocage par IP, et aucune donnée ne sort du serveur.
 * D'où la disparition de tout le code qui existait uniquement pour contourner
 * ces contraintes — files d'attente, découpage en morceaux de 500 octets,
 * repli d'un service sur l'autre.
 *
 * Sans URL configurée, ce module ne fait simplement rien (échec propre) : les
 * articles gardent leur langue d'origine, et l'appelant les représentera au
 * passage suivant.
 */

// Plus large qu'un appel réseau classique : la traduction tourne sur le
// processeur du serveur, sans accélérateur graphique, et le conteneur peut
// encore être en train de charger ses modèles (plusieurs minutes au tout
// premier démarrage).
const TIMEOUT_MS = 20000;

export type TranslateResult = { ok: true; text: string } | { ok: false; reason: string };

export type TranslateOptions = {
  targetLang?: string;
  /** Adresse de l'instance LibreTranslate (Settings.libretranslateUrl).
   *  Absente = aucune traduction possible. */
  libretranslateUrl?: string;
  /** Clé d'accès si l'instance est protégée (Settings.libretranslateApiKey).
   *  Absente = aucune clé transmise. */
  libretranslateApiKey?: string;
};

/**
 * Essaie de traduire et renvoie soit le texte, soit la raison précise de
 * l'échec — remontée telle quelle dans /admin/logs (voir syncTranslateFlags),
 * seul moyen de distinguer un conteneur éteint d'une instance qui démarre
 * encore ou d'une URL mal renseignée.
 */
export async function translateDetailed(text: string, options: TranslateOptions = {}): Promise<TranslateResult> {
  if (!text || !text.trim()) return { ok: false, reason: "texte vide" };

  const baseUrl = (options.libretranslateUrl || "").replace(/\/+$/, "");
  if (!baseUrl) {
    return { ok: false, reason: "aucune instance LibreTranslate configurée (/admin/settings → Traduction)" };
  }

  const targetLang = options.targetLang || "fr";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/translate`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      // source "auto" : les flux peuvent être dans plusieurs langues, et
      // LibreTranslate détecte lui-même. format "text" pour qu'il n'aille pas
      // interpréter d'éventuels chevrons comme du HTML.
      // api_key n'est ajouté que s'il y en a une : LibreTranslate rejette le
      // champ quand l'instance n'attend aucune clé.
      body: JSON.stringify({
        q: text,
        source: "auto",
        target: targetLang,
        format: "text",
        ...(options.libretranslateApiKey ? { api_key: options.libretranslateApiKey } : {})
      })
    });

    if (res.status === 403) {
      return {
        ok: false,
        reason: options.libretranslateApiKey
          ? "libretranslate 403 — clé refusée, vérifie qu'elle correspond à LT_API_KEYS"
          : "libretranslate 403 — instance protégée : renseigne la clé dans /admin/settings → Traduction"
      };
    }
    if (!res.ok) return { ok: false, reason: `libretranslate HTTP ${res.status}` };

    const data: any = await res.json().catch(() => null);
    const translated = data?.translatedText;
    if (typeof translated !== "string" || !translated.trim()) {
      return { ok: false, reason: "libretranslate réponse vide" };
    }
    return { ok: true, text: translated };
  } catch (err: any) {
    // Cas le plus courant au tout premier démarrage : le conteneur télécharge
    // encore ses modèles et refuse les connexions.
    const reason =
      err?.name === "AbortError"
        ? "libretranslate timeout (modèles encore en cours de chargement ?)"
        : `libretranslate ${err?.message || "injoignable"}`;
    return { ok: false, reason };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Renvoie la traduction, ou null en cas d'échec — le null est ESSENTIEL pour
 * le backfill "En direct" (syncTranslateFlags), qui enregistre le résultat en
 * base : une variante qui retomberait sur le texte d'origine stockerait
 * l'anglais comme "traduction", et l'article, n'ayant alors plus un champ
 * vide, ne serait plus jamais retenté (bug constaté en usage réel).
 */
export async function translateOrNull(text: string, options: TranslateOptions = {}): Promise<string | null> {
  const result = await translateDetailed(text, options);
  return result.ok ? result.text : null;
}

/**
 * Variante "best-effort" qui retombe sur le texte d'origine plutôt que de
 * casser l'affichage — réservée à la traduction à la demande de l'article
 * ouvert (article-proxy), où mieux vaut afficher la langue d'origine qu'une
 * page vide.
 */
export async function translateBestEffort(text: string, options: TranslateOptions = {}): Promise<string> {
  return (await translateOrNull(text, options)) ?? text;
}
