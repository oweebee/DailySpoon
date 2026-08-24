import { BROWSER_USER_AGENT } from "./text";

// Traduction via le point d'accès public non officiel que translate.google.com
// utilise lui-même en coulisses — gratuit, sans clé API, mais non documenté/
// non garanti par Google (peut cesser de fonctionner sans préavis).
// Best-effort : en cas d'échec, on garde le texte d'origine plutôt que de
// casser l'affichage. Partagé entre deux usages :
//   - la traduction À LA DEMANDE de l'article ouvert (lien "Traduire en
//     français" dans le lecteur, voir article-proxy/route.ts) ;
//   - le backfill AUTOMATIQUE du titre/extrait affiché en "En direct" pour
//     les flux cochés "traduction" (voir syncTranslateFlags dans
//     generateEdition.ts et TranslateFeed dans schema.prisma).
export async function translateViaGoogle(text: string, targetLang = "fr"): Promise<string> {
  return (await translateOrNull(text, targetLang)) ?? text;
}

/**
 * Même appel que translateViaGoogle, mais qui DISTINGUE explicitement l'échec
 * (null) du succès (le texte traduit) — indispensable pour le backfill
 * automatique "En direct" (syncTranslateFlags, generateEdition.ts), qui
 * enregistre le résultat en base : avec la version ci-dessus, un échec réseau
 * renvoie le texte anglais d'origine, qui se retrouvait alors stocké comme
 * "traduction" — l'article n'était donc plus jamais retenté (son champ
 * translatedTitle n'étant plus vide) et restait en anglais pour toujours.
 * En renvoyant null, l'appelant peut simplement ne rien écrire et laisser
 * l'article repasser dans le lot suivant.
 *
 * Renvoie aussi null pour une entrée vide : il n'y a rien à traduire, donc
 * rien à mettre en cache.
 */
export async function translateOrNull(text: string, targetLang = "fr"): Promise<string | null> {
  if (!text || !text.trim()) return null;
  const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLang, dt: "t", q: text });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        "User-Agent": BROWSER_USER_AGENT
      }
    });
    if (!res.ok) return null;
    const data: any = await res.json();
    const segments = data?.[0];
    if (!Array.isArray(segments)) return null;
    const translated = segments.map((seg: any) => seg?.[0] ?? "").join("");
    return translated.trim() ? translated : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}
