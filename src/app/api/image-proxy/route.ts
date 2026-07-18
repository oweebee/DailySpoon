import { NextRequest, NextResponse } from "next/server";
import { isForbiddenProxyTarget } from "@/lib/urlGuard";

// Certains sites (TechCrunch, Numerama, ...) bloquent le hotlinking : une
// requête envoyée directement par le navigateur du visiteur échoue (referer
// non reconnu, protection anti-scraping), mais une requête faite par NOTRE
// serveur passe normalement. On récupère donc l'image côté serveur et on la
// re-sert depuis notre propre domaine — le navigateur ne voit jamais la
// requête directe vers le site source.
export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) {
    return NextResponse.json({ error: "url manquant" }, { status: 400 });
  }

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

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    let res: Response;
    try {
      res = await fetch(parsed.toString(), {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "image/avif,image/webp,image/apng,image/*,*/*;q=0.8",
          // Referer = le site source lui-même (pas dailyspoon) : certaines
          // protections anti-hotlink (Apache/Nginx par règle de referer)
          // bloquent justement les requêtes SANS referer ou avec un referer
          // étranger — en envoyer un qui pointe vers le site d'origine est
          // ce qui ressemble le plus à une vraie navigation sur ce site.
          // Sans effet en revanche sur un blocage "bot" au niveau CDN
          // (Cloudflare Bot Fight Mode et cie), qui ne se contourne pas par
          // un simple en-tête — voir le repli favicon dans ArticleImage.
          Referer: `${parsed.protocol}//${parsed.hostname}/`
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok || !res.body) {
      return NextResponse.json({ error: `Échec (${res.status})` }, { status: 502 });
    }

    const contentType = res.headers.get("content-type") || "image/jpeg";
    if (!contentType.startsWith("image/")) {
      return NextResponse.json({ error: "Pas une image" }, { status: 415 });
    }

    return new NextResponse(res.body, {
      headers: {
        "Content-Type": contentType,
        // Cache généreux : l'illustration d'un article ne change pas.
        "Cache-Control": "public, max-age=86400, s-maxage=604800, immutable"
      }
    });
  } catch (err: any) {
    return NextResponse.json({ error: err?.message || "Échec du chargement" }, { status: 502 });
  }
}
