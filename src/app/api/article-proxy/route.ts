import { NextRequest, NextResponse } from "next/server";
import { JSDOM } from "jsdom";
import { Readability } from "@mozilla/readability";
import { prisma } from "@/lib/prisma";

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

// Étoile "shérif" (même silhouette que FavoriteStar.tsx côté app React) pour
// marquer/démarquer un article en favori depuis la page proxifiée — servie
// en HTML statique dans une iframe, donc pas de composant React ici : un
// bouton + un petit script inline qui appelle /api/articles/favorite (même
// origine que l'iframe, donc le cookie de session suit automatiquement).
const STAR_PATH_D =
  "M12,2 L14.35,8.76 L21.51,8.91 L15.80,13.24 L17.88,20.09 L12,16 L6.12,20.09 L8.20,13.24 L2.49,8.91 L9.65,8.76 Z";

function favoriteStarHtml(): string {
  return `<button type="button" class="js-fav-star fav-star" onclick="toggleFavorite()" aria-label="Favori">
    <svg viewBox="0 0 24 24" width="15" height="15"><path d="${STAR_PATH_D}" /></svg>
  </button>`;
}

// Trois cuillères (clin d'œil au nom "DailySpoon") en guise de fleuron de fin
// d'article, à la place du symbole "❦ ❦ ❦" d'origine — en SVG plutôt qu'un
// emoji pour rester en niveaux de gris (un emoji cuillère s'afficherait en
// couleur, hors thème). Inclinées façon couverts posés en éventail (pas
// debout au garde-à-vous) — mêmes angles et même silhouette que
// SpoonDivider.tsx côté app React, pour une cohérence visuelle totale.
function spoonSvg(rotateDeg: number): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" style="transform: rotate(${rotateDeg}deg)"><ellipse cx="12" cy="6.2" rx="5.1" ry="6.2"/><rect x="10.6" y="11.4" width="2.8" height="11.2" rx="1.4"/></svg>`;
}

function renderPage(opts: {
  title: string;
  byline?: string | null;
  siteName?: string | null;
  bodyHtml: string;
  originalUrl: string;
  /** Affiche le lien de bascule traduction — seulement sur les pages qui
   *  ont un vrai contenu d'article (pas les pages de repli/erreur). */
  showTranslateLink?: boolean;
  /** Page actuellement affichée en français traduit (vs langue d'origine). */
  translated?: boolean;
  /** Id de l'Article en base correspondant à cette URL, s'il existe — permet
   *  d'afficher l'étoile favori (absent si l'article n'est pas encore/plus
   *  en base, ex. lien externe non aspiré). */
  articleId?: string | null;
  favorite?: boolean;
}): string {
  const { title, byline, siteName, bodyHtml, originalUrl, showTranslateLink, translated, articleId, favorite } = opts;
  const kickerRaw = siteName || new URL(originalUrl).hostname.replace(/^www\./, "");
  const kicker = escapeHtml(kickerRaw);
  // La ligne "source" sous le titre reste toujours affichée (repli sur le
  // seul nom du site si aucun byline), pour que l'étoile favori ait toujours
  // un ancrage juste en dessous du titre.
  const bylineRaw = [siteName, byline].filter((v): v is string => Boolean(v)).join(" · ") || kickerRaw;
  const metaBits = escapeHtml(bylineRaw);
  const showStar = Boolean(articleId);
  const starHtml = showStar ? favoriteStarHtml() : "";
  // Traduction à la demande seulement (pas par défaut) : un lien dans le
  // bandeau du haut bascule vers /api/article-proxy?...&translate=1 (ou
  // l'enlève pour revenir à la langue d'origine), qui refait un rendu
  // serveur complet avec le contenu traduit via l'endpoint public Google
  // Translate (best-effort, non officiel — cf. translateViaGoogle plus bas).
  const translateHref = `/api/article-proxy?url=${encodeURIComponent(originalUrl)}${translated ? "" : "&translate=1"}`;
  const translateLabel = translated ? "Texte original ↺" : "Traduire en français ⇄";
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
    /* Grille à 3 colonnes (pas flex + space-between) : le lien du milieu
       reste réellement centré sur la ligne, quelles que soient les
       longueurs du lien de gauche et du nom de site à droite — sinon son
       centre "flottant" ne s'aligne pas avec le kicker centré juste
       en dessous. */
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
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
  .meta-left { text-align: left; }
  .meta-center { text-align: center; }
  .meta-right { text-align: right; }
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
  .fav-star {
    display: inline-flex;
    vertical-align: middle;
    margin-left: 7px;
    padding: 0;
    border: none;
    background: none;
    cursor: pointer;
    color: #5c5c5c;
  }
  .fav-star svg path { fill: none; stroke: currentColor; stroke-width: 1.3; stroke-linejoin: round; }
  .fav-star.is-fav { color: #8a0303; }
  .fav-star.is-fav svg path { fill: currentColor; }
  .source-bottom {
    text-align: center;
    font-size: 0.8rem;
    font-style: italic;
    color: #5c5c5c;
    margin-top: 2.6em;
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
  .colophon { text-align: center; margin-top: 3.2em; color: #5c5c5c; }
  .colophon svg { display: inline-block; vertical-align: middle; margin: 0 9px; fill: currentColor; }
</style>
</head>
<body>
  <div class="page">
    <p class="meta-top">
      <span class="meta-left">
        <a href="${escapeHtml(originalUrl)}" target="_blank" rel="noopener noreferrer">Voir l'original ↗</a>
      </span>
      <span class="meta-center">
        ${showTranslateLink ? `<a href="${escapeHtml(translateHref)}">${translateLabel}</a>` : ""}
      </span>
      <span class="meta-right">${kicker}</span>
    </p>
    <div class="double-rule"></div>
    <p class="kicker">✦ ${kicker} ✦</p>
    <h1>${escapeHtml(title)}</h1>
    <p class="byline">${metaBits}${starHtml}</p>
    <div class="article-body">${bodyHtml}</div>
    <p class="source-bottom">Source : ${kicker}${starHtml}</p>
    <p class="colophon">${spoonSvg(-18)}${spoonSvg(14)}${spoonSvg(-18)}</p>
  </div>
  ${
    showStar
      ? `<script>
(function () {
  var articleId = ${JSON.stringify(articleId)};
  var fav = ${favorite ? "true" : "false"};
  function paint() {
    document.querySelectorAll(".js-fav-star").forEach(function (el) {
      el.classList.toggle("is-fav", fav);
      el.setAttribute("aria-pressed", fav ? "true" : "false");
      el.title = fav ? "Retirer des favoris" : "Ajouter aux favoris";
    });
  }
  window.toggleFavorite = function () {
    fav = !fav;
    paint();
    fetch("/api/articles/favorite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ articleId: articleId, favorite: fav })
    }).catch(function () {});
  };
  paint();
})();
</script>`
      : ""
  }
</body>
</html>`;
}

function htmlResponse(html: string): NextResponse {
  return new NextResponse(html, { status: 200, headers: { "Content-Type": "text/html; charset=utf-8" } });
}

// Traduction à la demande uniquement (lien "Traduire en français" dans la
// page, jamais automatique) via le point d'accès public non officiel que
// translate.google.com utilise lui-même en coulisses — gratuit, sans clé
// API, mais non documenté/non garanti par Google (peut cesser de
// fonctionner sans préavis). Best-effort : en cas d'échec, on garde le
// texte d'origine plutôt que de casser la page.
async function translateViaGoogle(text: string, targetLang = "fr"): Promise<string> {
  if (!text || !text.trim()) return text;
  const params = new URLSearchParams({ client: "gtx", sl: "auto", tl: targetLang, dt: "t", q: text });
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`https://translate.googleapis.com/translate_a/single?${params.toString()}`, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
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

// Limite le nombre de blocs traduits par article : l'endpoint est gratuit
// mais non officiel, et chaque bloc = une requête réseau séquentielle — on
// évite qu'un article démesurément long ne prenne des dizaines de secondes
// à s'ouvrir ou ne se fasse limiter par Google.
const MAX_BLOCKS_TO_TRANSLATE = 60;

async function translateContentHtml(html: string): Promise<string> {
  const dom = new JSDOM(`<div id="root">${html}</div>`);
  const root = dom.window.document.getElementById("root");
  if (!root) return html;
  const blocks = Array.from(root.querySelectorAll("p, li, blockquote, h1, h2, h3, h4, figcaption")).slice(
    0,
    MAX_BLOCKS_TO_TRANSLATE
  );
  for (const el of blocks) {
    const original = el.innerHTML.trim();
    if (!original) continue;
    el.innerHTML = await translateViaGoogle(original);
  }
  return root.innerHTML;
}

async function translateArticle(title: string, bodyHtml: string): Promise<{ title: string; bodyHtml: string }> {
  const [translatedTitle, translatedBody] = await Promise.all([
    translateViaGoogle(title),
    translateContentHtml(bodyHtml)
  ]);
  return { title: translatedTitle, bodyHtml: translatedBody };
}

// Reddit (y compris old.reddit.com) bloque désormais la plupart des
// requêtes serveur-à-serveur avec un 403, quel que soit le User-Agent —
// blocage réseau/IP, pas seulement JS. La seule voie qui reste fiable est
// l'API JSON publique (pas d'auth requise pour un post public) : on la
// préfère pour les URLs de post ("/comments/...").
function isRedditUrl(hostname: string): boolean {
  return /(^|\.)reddit\.com$/i.test(hostname);
}

function isRedditPostUrl(u: URL): boolean {
  return isRedditUrl(u.hostname) && /\/comments\//.test(u.pathname);
}

// Reddit renvoie le corps d'un self-post déjà en HTML (sain, rendu depuis
// le markdown) mais échappé une fois de trop dans le JSON (ex. "&lt;p&gt;").
// On le fait décoder par un parseur HTML : en assignant la chaîne comme
// innerHTML d'un nœud temporaire, les entités sont décodées en vrais
// caractères "<"/">" dans le texte — qu'on relit via textContent pour
// récupérer du HTML valide, réutilisable comme markup.
function decodeRedditHtml(encoded: string): string {
  const dom = new JSDOM(`<!doctype html><body><div id="tmp">${encoded}</div></body>`);
  return dom.window.document.getElementById("tmp")?.textContent || "";
}

// Instances publiques Redlib (front-end alternatif à Reddit, scrape sa
// propre infrastructure) — essai best-effort avant l'API JSON officielle.
// Non garanti dans la durée : une instance publique peut tomber, changer de
// politique anti-bot, etc. Celles listées ici ont été vérifiées comme ne
// posant pas de challenge JS (Anubis/Cloudflare) au moment de l'écriture ;
// si toutes échouent, on retombe sur l'API JSON puis sur la page de repli.
const REDLIB_INSTANCES = [
  "https://redlib.catsarch.com",
  "https://redlib.privacyredirect.com",
  "https://redlib.orangenet.cc",
  "https://redlib.privadency.com"
];

async function fetchViaRedlib(parsed: URL): Promise<{ html: string; baseUrl: string } | null> {
  const path = parsed.pathname + parsed.search;
  for (const instance of REDLIB_INSTANCES) {
    const target = `${instance}${path}`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 6000);
    try {
      const res = await fetch(target, {
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8"
        }
      });
      if (!res.ok) continue;
      const html = await res.text();
      // Écarte les pages de challenge anti-bot (Anubis, Cloudflare...) ou
      // les réponses trop courtes pour être une vraie page de post.
      if (html.length < 500 || /anubis|checking your browser|cf-browser-verification/i.test(html)) continue;
      return { html, baseUrl: target };
    } catch {
      continue;
    } finally {
      clearTimeout(timeout);
    }
  }
  return null;
}

type RedditPost = { title: string; author: string; subreddit: string; bodyHtml: string };

async function fetchRedditPost(parsed: URL): Promise<RedditPost | null> {
  const cleanPath = parsed.pathname.replace(/\/+$/, "");
  const jsonUrl = `https://www.reddit.com${cleanPath}.json?raw_json=1`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    const res = await fetch(jsonUrl, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        Accept: "application/json"
      }
    });
    if (!res.ok) return null;

    const json: any = await res.json();
    const post = json?.[0]?.data?.children?.[0]?.data;
    if (!post) return null;

    let bodyHtml: string;
    if (post.is_self && post.selftext_html) {
      bodyHtml = decodeRedditHtml(post.selftext_html);
    } else if (post.url) {
      bodyHtml = `<p><em>Ce post pointe vers un lien externe :</em></p><p><a href="${escapeHtml(
        post.url
      )}">${escapeHtml(post.url)}</a></p>`;
    } else {
      bodyHtml = "<p><em>Post sans contenu textuel.</em></p>";
    }

    return {
      title: post.title || "Post Reddit",
      author: post.author || "inconnu",
      subreddit: post.subreddit_name_prefixed || "reddit.com",
      bodyHtml
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
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
  const fetchUrl = originalUrl;
  const wantsTranslation = req.nextUrl.searchParams.get("translate") === "1";

  // Retrouve l'Article correspondant (même sourceUrl) pour savoir s'il faut
  // afficher l'étoile favori et dans quel état — absent si l'article n'est
  // pas (ou plus) en base.
  const articleRecord = await prisma.article
    .findFirst({ where: { sourceUrl: originalUrl }, select: { id: true, favorite: true } })
    .catch(() => null);
  const articleId = articleRecord?.id ?? null;
  const favorite = articleRecord?.favorite ?? false;

  if (isRedditPostUrl(parsed)) {
    // 1) Miroir Redlib (best-effort, voir REDLIB_INSTANCES) : rendu HTML
    //    complet côté serveur, passé par le même pipeline Readability que
    //    n'importe quel autre site.
    const redlib = await fetchViaRedlib(parsed);
    if (redlib) {
      const redlibDom = new JSDOM(redlib.html, { url: redlib.baseUrl });
      const redlibArticle = new Readability(redlibDom.window.document as unknown as Document).parse();
      if (redlibArticle && redlibArticle.content) {
        const contentDom = new JSDOM(`<div id="root">${redlibArticle.content}</div>`);
        contentDom.window.document.querySelectorAll("img, source").forEach((el) => {
          const src = el.getAttribute("src");
          if (src) {
            try {
              el.setAttribute("src", proxyImageUrl(new URL(src, redlib.baseUrl).toString()));
            } catch {
              // ignore
            }
          }
          el.removeAttribute("srcset");
        });
        contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());
        const rootEl = contentDom.window.document.getElementById("root");
        if (rootEl) trimTrailingJunk(rootEl);

        let finalTitle = redlibArticle.title || "Post Reddit";
        let finalBody = rootEl?.innerHTML || "";
        if (wantsTranslation) {
          const t = await translateArticle(finalTitle, finalBody);
          finalTitle = t.title;
          finalBody = t.bodyHtml;
        }

        return htmlResponse(
          renderPage({
            title: finalTitle,
            byline: redlibArticle.byline,
            siteName: "reddit.com",
            bodyHtml: finalBody,
            originalUrl,
            showTranslateLink: true,
            translated: wantsTranslation,
            articleId,
            favorite
          })
        );
      }
    }

    // 2) Repli sur l'API JSON officielle de Reddit (marche parfois même
    //    quand le HTML est bloqué).
    const redditPost = await fetchRedditPost(parsed);
    if (redditPost) {
      // Même traitement des images que le chemin générique : passage par
      // le proxy d'images pour les éventuelles illustrations du self-post.
      const contentDom = new JSDOM(`<div id="root">${redditPost.bodyHtml}</div>`);
      contentDom.window.document.querySelectorAll("img, source").forEach((el) => {
        const src = el.getAttribute("src");
        if (src) {
          try {
            el.setAttribute("src", proxyImageUrl(new URL(src, "https://www.reddit.com").toString()));
          } catch {
            // ignore
          }
        }
        el.removeAttribute("srcset");
      });
      let finalTitle = redditPost.title;
      let finalBody = contentDom.window.document.getElementById("root")?.innerHTML || "";
      if (wantsTranslation) {
        const t = await translateArticle(finalTitle, finalBody);
        finalTitle = t.title;
        finalBody = t.bodyHtml;
      }

      return htmlResponse(
        renderPage({
          title: finalTitle,
          byline: `Posté par u/${redditPost.author}`,
          siteName: redditPost.subreddit,
          bodyHtml: finalBody,
          originalUrl,
          showTranslateLink: true,
          translated: wantsTranslation,
          articleId,
          favorite
        })
      );
    }
    // 3) Ni les miroirs Redlib ni l'API JSON n'ont marché. Retomber sur le
    // fetch générique ne ferait que refaire le même appel bloqué vers
    // reddit.com pour la même erreur — autant l'annoncer clairement tout
    // de suite plutôt que de perdre du temps sur une requête vouée à
    // échouer.
    return htmlResponse(
      renderPage({
        title: "Reddit indisponible depuis ce serveur",
        bodyHtml:
          "<p>Reddit bloque les requêtes venant de ce serveur (IP d'hébergeur), y compris via son API publique et les miroirs de secours essayés. Utilise « Ouvrir dans un nouvel onglet » pour lire ce post directement.</p>",
        originalUrl,
        articleId,
        favorite
      })
    );
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    let res: Response;
    try {
      res = await fetch(fetchUrl, {
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
          originalUrl,
          articleId,
          favorite
        })
      );
    }

    const rawBuffer = await res.arrayBuffer();
    const rawHtml = decodeHtml(rawBuffer, res.headers.get("content-type"));
    const dom = new JSDOM(rawHtml, { url: fetchUrl });
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
          originalUrl,
          articleId,
          favorite
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
          el.setAttribute("src", proxyImageUrl(new URL(src, fetchUrl).toString()));
        } catch {
          // URL déjà relative/invalide, on laisse tel quel plutôt que de planter.
        }
      }
      el.removeAttribute("srcset");
    });
    contentDom.window.document.querySelectorAll("script, style, iframe").forEach((el) => el.remove());

    const rootEl = contentDom.window.document.getElementById("root");
    if (rootEl) trimTrailingJunk(rootEl);

    let finalTitle = article.title || "Article";
    let finalBody = rootEl?.innerHTML || "";
    if (wantsTranslation) {
      const t = await translateArticle(finalTitle, finalBody);
      finalTitle = t.title;
      finalBody = t.bodyHtml;
    }

    return htmlResponse(
      renderPage({
        title: finalTitle,
        byline: article.byline,
        siteName: article.siteName,
        bodyHtml: finalBody,
        originalUrl,
        showTranslateLink: true,
        translated: wantsTranslation,
        articleId,
        favorite
      })
    );
  } catch (err: any) {
    return htmlResponse(
      renderPage({
        title: "Erreur",
        bodyHtml: `<p>Erreur lors de la récupération de l'article : ${escapeHtml(
          err?.message || "inconnue"
        )}. Utilise « Ouvrir dans un nouvel onglet ».</p>`,
        originalUrl,
        articleId,
        favorite
      })
    );
  }
}
