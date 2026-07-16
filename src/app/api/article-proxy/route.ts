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

// Beaucoup de sites glissent, après le vrai texte de l'article mais toujours
// à l'intérieur du bloc que Readability extrait, un rebus de fin d'article :
// pub pour l'appli mobile, bandeau newsletter, liste "à lire aussi" — pas du
// contenu de l'article. On repère le dernier paragraphe qui ressemble à du
// vrai texte, et on supprime tout ce qui vient après (photo publicitaire,
// listes de liens, etc.), plutôt que d'essayer de reconnaître chaque site.
const TRAILING_JUNK_PHRASES = [
  "inscrivez-vous",
  "abonnez-vous",
  "newsletter",
  "téléchargez notre application",
  "téléchargez l'application",
  "app store",
  "google play",
  "écran d'accueil",
  "toute l'actu",
  "en un clin d'œil",
  "restez connecté",
  "restez informé",
  "dans l'internet d'",
  "sur le même sujet",
  "à lire aussi",
  "cet article vous a plu",
  "partager cet article"
];

function isSubstantiveParagraph(el: Element): boolean {
  if (el.tagName !== "P") return false;
  const text = (el.textContent || "").trim();
  if (text.length < 40) return false;

  const lower = text.toLowerCase();
  if (TRAILING_JUNK_PHRASES.some((p) => lower.includes(p))) return false;

  // Un paragraphe qui n'est en fait qu'un lien/bouton habillé (CTA) plutôt
  // que de la prose — on l'ignore même s'il est assez long.
  const links = el.querySelectorAll("a");
  if (links.length > 0) {
    const linkText = Array.from(links)
      .map((a) => (a.textContent || "").trim())
      .join(" ");
    if (linkText.length >= text.length - 5) return false;
  }

  return true;
}

/** Coupe le contenu juste après le dernier paragraphe "réel" : tout ce qui
 *  suit (photo, liste de liens, bandeau newsletter...) est retiré. */
function trimTrailingJunk(root: Element): void {
  const children = Array.from(root.children);
  let lastRealIdx = -1;
  children.forEach((el, i) => {
    if (isSubstantiveParagraph(el)) lastRealIdx = i;
  });
  if (lastRealIdx === -1) return; // rien d'identifiable, on ne touche à rien par sécurité
  for (let i = children.length - 1; i > lastRealIdx; i--) {
    children[i].remove();
  }
}

// `Response.text()` du fetch natif décode toujours en UTF-8, quel que soit
// l'encodage réel de la page — ce qui bousille les accents (é -> �) sur tout
// site qui sert du HTML en ISO-8859-1/Windows-1252 (encore fréquent). On lit
// donc les octets bruts et on détecte nous-mêmes le bon charset : d'abord
// via l'en-tête HTTP Content-Type, sinon via la balise <meta charset> de la
// page (repérable en la lisant provisoirement en latin1, qui est sans perte
// pour les octets ASCII où vit cette balise).
function detectCharset(buffer: ArrayBuffer, contentTypeHeader: string | null): string {
  if (contentTypeHeader) {
    const m = /charset=([^;]+)/i.exec(contentTypeHeader);
    if (m) return m[1].trim().toLowerCase().replace(/["']/g, "");
  }
  const head = Buffer.from(buffer.slice(0, 2048)).toString("latin1");
  const metaCharset = /<meta[^>]+charset=["']?\s*([a-z0-9_-]+)/i.exec(head);
  if (metaCharset) return metaCharset[1].toLowerCase();
  return "utf-8";
}

function decodeHtml(buffer: ArrayBuffer, contentTypeHeader: string | null): string {
  const charset = detectCharset(buffer, contentTypeHeader);
  try {
    return new TextDecoder(charset).decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
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
  const kicker = siteName ? escapeHtml(siteName) : new URL(originalUrl).hostname.replace(/^www\./, "");
  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..900;1,400..900&display=swap" rel="stylesheet" />
<style>
  * { box-sizing: border-box; }
  html { background: #dcdcdc; }
  body {
    margin: 0;
    padding: 40px 28px 70px;
    font-family: Georgia, "Times New Roman", serif;
    color: #1a1a1a;
    line-height: 1.7;
    font-size: 17.5px;
    /* Papier gris : même grain de bruit + vignette que le reste du site,
       pour que la page proxifiée fasse illusion de vieux papier journal. */
    background-color: #f0f0f0;
    background-image:
      url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='240' height='240'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.5' numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.5'/%3E%3C/svg%3E"),
      radial-gradient(ellipse at center, #f5f5f5 0%, #ececec 70%, #dcdcdc 100%);
    /* Pas de "background-attachment: fixed" ici : dans un iframe, ça fait
       défiler le texte tout seul au-dessus d'un fond qui semble figé/vide.
       Le fond doit défiler avec le contenu, comme une vraie page de papier. */
  }
  .page {
    max-width: 660px;
    margin: 0 auto;
  }
  .meta-top {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.2em;
    color: #5c5c5c;
    padding-bottom: 6px;
    border-bottom: 1px solid rgba(26, 26, 26, 0.6);
    margin-bottom: 4px;
  }
  .meta-top a { color: #8b1a1a; text-decoration: none; }
  .meta-top a:hover { text-decoration: underline; }
  .double-rule { border-top: 3px solid #1a1a1a; border-bottom: 1px solid #1a1a1a; height: 6px; margin: 2px 0 22px; }
  .kicker {
    text-align: center;
    font-size: 0.72rem;
    text-transform: uppercase;
    letter-spacing: 0.3em;
    color: #8b1a1a;
    margin: 22px 0 6px;
  }
  h1 {
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 900;
    font-size: 2.15rem;
    line-height: 1.15;
    text-align: center;
    margin: 0 0 8px;
  }
  .byline {
    text-align: center;
    font-size: 0.78rem;
    font-style: italic;
    color: #5c5c5c;
    margin-bottom: 28px;
  }
  .article-body { text-align: justify; hyphens: auto; }
  .article-body > p:first-of-type::first-letter {
    float: left;
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 900;
    font-size: 3.6em;
    line-height: 0.82;
    padding-right: 0.09em;
    padding-top: 0.04em;
    color: #1a1a1a;
  }
  .article-body p { margin: 1.05em 0; }
  .article-body img, .article-body picture {
    max-width: 100%;
    height: auto;
    display: block;
    margin: 1.4em auto;
    /* Contrairement aux vignettes de la liste (volontairement en noir et
       blanc), la photo dans l'article ouvert reste en couleur. */
    border: 1px solid #1a1a1a;
    box-shadow: 3px 3px 0 rgba(26, 26, 26, 0.15);
  }
  .article-body figure { margin: 1.4em 0; }
  .article-body figcaption { font-size: 0.75rem; color: #5c5c5c; font-style: italic; text-align: center; margin-top: 0.4em; }
  .article-body a { color: #8b1a1a; }
  .article-body blockquote {
    border-left: 3px solid #1a1a1a;
    margin: 1.2em 0;
    padding: 0.2em 0 0.2em 1.1em;
    color: #3a3a3a;
    font-style: italic;
  }
  .article-body h2, .article-body h3 {
    font-family: "Playfair Display", Georgia, serif;
    font-weight: 800;
    margin: 1.4em 0 0.5em;
  }
  .colophon { text-align: center; font-size: 1.3rem; letter-spacing: 0.5em; color: #5c5c5c; margin-top: 3.2em; }
</style>
</head>
<body>
  <div class="page">
    <p class="meta-top">
      <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer">Voir l'original ↗</a>
      <span>${escapeHtml(kicker)}</span>
    </p>
    <div class="double-rule"></div>
    <p class="kicker">✦ ${escapeHtml(kicker)} ✦</p>
    <h1>${escapeHtml(title)}</h1>
    ${metaBits ? `<p class="byline">${metaBits}</p>` : ""}
    <div class="article-body">${bodyHtml}</div>
    <p class="colophon">❦ ❦ ❦</p>
  </div>
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

    const rawBuffer = await res.arrayBuffer();
    const rawHtml = decodeHtml(rawBuffer, res.headers.get("content-type"));
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

    const rootEl = contentDom.window.document.getElementById("root");
    if (rootEl) trimTrailingJunk(rootEl);

    const cleanedContent = rootEl?.innerHTML || "";

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
