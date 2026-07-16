import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";

// jsdom a besoin du runtime Node complet (pas edge).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Principe "Morss" : au lieu de charger le site source directement dans
// l'iframe (bloqué par beaucoup de sites via X-Frame-Options/CSP), on
// récupère la page côté serveur, on en extrait l'article propre (via
// Readability, la même techno que Firefox Reader View / Pocket), et on sert
// une version simplifiée depuis notre propre domaine — jamais bloquée
// puisqu'elle ne vient plus du site source du point de vue du navigateur.

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function proxyImageUrl(absoluteUrl: string): string {
  return `/api/image-proxy?url=${encodeURIComponent(absoluteUrl)}`;
}

function renderPage(opts: {
  title: string;
  byline?: string | null;
  siteName?: string | null;
  bodyHtml: string;
  originalUrl: string;
}): string {
  const { title, byline, siteName, bodyHtml, originalUrl } = opts;
  const metaBits = [siteName, byline]
    .filter((v): v is string => Boolean(v))
    .map(escapeHtml)
    .join(" · ");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
  body {
    margin: 0;
    padding: 28px 24px 60px;
    max-width: 700px;
    margin-left: auto;
    margin-right: auto;
    font-family: Georgia, "Times New Roman", serif;
    background: #f6f1e3;
    color: #1a1a1a;
    line-height: 1.65;
    font-size: 17px;
  }
  h1 { font-family: Georgia, serif; font-weight: 900; font-size: 1.9rem; line-height: 1.2; margin: 0.4em 0 0.3em; }
  .meta { font-size: 0.8rem; color: #6b5b3e; margin-bottom: 1.6em; font-style: italic; }
  .meta a { color: #8b1a1a; }
  img { max-width: 100%; height: auto; display: block; margin: 1em auto; filter: grayscale(1) sepia(0.25) contrast(1.1); border: 1px solid #1a1a1a; }
  figure { margin: 1.2em 0; }
  figcaption { font-size: 0.75rem; color: #6b5b3e; font-style: italic; text-align: center; }
  a { color: #8b1a1a; }
  blockquote { border-left: 3px solid #1a1a1a; margin: 1em 0; padding-left: 1em; color: #444; }
  p { margin: 1em 0; }
</style>
</head>
<body>
  <p class="meta">
    <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer">Voir l'original ↗</a>
    ${metaBits ? " · " + metaBits : ""}
  </p>
  <h1>${escapeHtml(title)}</h1>
  ${bodyHtml}
</body>
</html>`;
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

export async function GET(req: NextRequest) {
  const url = req.nextUrl.searchParams.get("url");
  if (!url) return new NextResponse("URL manquante", { status: 400 });

  let parsed: URL;
  try {
    parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocole invalide");
  } catch {
    return new NextResponse("URL invalide", { status: 400 });
  }
  const originalUrl = parsed.toString();

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(originalUrl, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!res.ok) {
      return htmlResponse(
        renderPage({
          title: "Article indisponible",
          bodyHtml: `<p>Le site source a répondu ${res.status}. Utilise « Ouvrir dans un nouvel onglet » pour lire l'article directement.</p>`,
          originalUrl
        })
      );
    }

    const rawHtml = await res.text();
    const dom = new JSDOM(rawHtml, { url: originalUrl });
    // Cast : le type Document de jsdom et celui de lib.dom (attendu par
    // Readability) ne s'unifient pas toujours parfaitement en TS, alors
    // qu'ils sont compatibles à l'exécution (usage standard recommandé par
    // Mozilla pour Node).
    const article = new Readability(dom.window.document as unknown as Document).parse();

    if (!article || !article.content) {
      return htmlResponse(
        renderPage({
          title: "Article non extrait",
          bodyHtml: `<p>Impossible d'extraire proprement le contenu de cet article. Utilise « Ouvrir dans un nouvel onglet » pour le lire directement sur le site source.</p>`,
          originalUrl
        })
      );
    }

    // Les images intégrées à l'article pointent encore vers le site
    // source — même souci de hotlinking que pour la vignette de la liste,
    // donc même traitement : on les fait passer par notre proxy d'images.
    const contentDom = new JSDOM(`<div id="root">${article.content}</div>`);
    contentDom.window.document.querySelectorAll("img, source").forEach((el) => {
      const src = el.getAttribute("src");
      if (src) {
        try {
          el.setAttribute("src", proxyImageUrl(new URL(src, originalUrl).toString()));
        } catch {
          // URL déjà relative/invalide, on laisse tel quel plutôt que de planter.
        }
      }
      el.removeAttribute("srcset");
    });
    contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());

    const cleanedContent = contentDom.window.document.getElementById("root")?.innerHTML || "";

    return htmlResponse(
      renderPage({
        title: article.title || "Article",
        byline: article.byline,
        siteName: article.siteName,
        bodyHtml: cleanedContent,
        originalUrl
      })
    );
  } catch (err: any) {
    return htmlResponse(
      renderPage({
        title: "Erreur",
        bodyHtml: `<p>Erreur lors de la récupération de l'article : ${escapeHtml(
          err?.message || "inconnue"
        )}. Utilise « Ouvrir dans un nouvel onglet ».</p>`,
        originalUrl
      })
    );
  }
}
