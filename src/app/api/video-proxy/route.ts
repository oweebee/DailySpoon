import { NextRequest, NextResponse } from "next/server";
import { isForbiddenProxyTarget } from "@/lib/urlGuard";

// Même principe que /api/image-proxy, mais pour la vidéo (utilisé pour les
// liens v.redd.it — voir article-proxy) : on relaie la requête depuis notre
// serveur pour contourner le hotlinking/CORS, ET on relaie l'en-tête
// "Range" du navigateur (indispensable pour qu'une balise <video> puisse
// démarrer la lecture/chercher dans le flux sans tout télécharger d'un
// coup — sans ce relai, la vidéo mettrait un temps disproportionné à
// démarrer, voire échouerait selon les navigateurs).
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return NextResponse.json({ error: "url manquant" }, { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocole invalide");
  } catch {
    return NextResponse.json({ error: "url invalide" }, { status: 400 });
  }
  // Anti-SSRF : jamais de fetch serveur vers une cible interne (voir urlGuard).
  if (isForbiddenProxyTarget(parsed)) {
    return NextResponse.json({ error: "cible non autorisée" }, { status: 403 });
  }

  const range = req.headers.get("range") || undefined;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "*/*",
          Referer: `${parsed.protocol}//${parsed.hostname}/`,
          ...(range ? { Range: range } : {})
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok && res.status !== 206) {
      return NextResponse.json({ error: `Échec (${res.status})` }, { status: 502 });
    }
    if (!res.body) return NextResponse.json({ error: "Réponse vide" }, { status: 502 });

    const headers: Record<string, string> = {
      "Content-Type": res.headers.get("content-type") || "video/mp4",
      "Accept-Ranges": res.headers.get("accept-ranges") || "bytes",
      // Contrairement à image-proxy, pas de cache long/immutable ici :
      // certaines réponses partielles (206) ne devraient pas être mises en
      // cache telles quelles côté CDN intermédiaire.
      "Cache-Control": "public, max-age=3600"
    };
    const contentLength = res.headers.get("content-length");
    if (contentLength) headers["Content-Length"] = contentLength;
    const contentRange = res.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;

    return new NextResponse(res.body, { status: res.status, headers });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Échec du chargement" }, { status: 502 });
  }
}
