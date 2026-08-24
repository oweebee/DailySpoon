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
  if (!text || !text.trim()) return text;
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
    if (!res.ok) return text;
    const data: any = await res.json();
    const segments = data?.[0];
    if (!Array.isArray(segments)) return text;
    const translated = segments.map((seg: any) => seg?.[0] ?? "").join("");
    return translated || text;
  } catch {
    return text;
  } finally {
    clearTimeout(timeout);
  }
}
