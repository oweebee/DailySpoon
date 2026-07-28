import { prisma } from "./prisma";
import { getSettings } from "./settings";
import { isCorrectPassword, sessionTokenForPassword } from "./auth";
import { sendFavoriteToWallabag } from "./wallabagSend";
import { cleanArticleUrl } from "./text";
import type { Prisma } from "@prisma/client";

// Implémentation SERVEUR de l'API Google Reader, pour connecter DailySpoon à un
// lecteur RSS externe (Readrops, etc.) comme s'il s'agissait d'un FreshRSS.
// L'API Google Reader est le protocole de synchro historique (Google Reader,
// fermé en 2013) devenu le standard de fait repris par FreshRSS & co — rien ne
// passe par Google, c'est juste le format d'URLs/JSON que le lecteur attend.
//
// On n'expose QUE le sous-ensemble d'endpoints dont un lecteur type Readrops a
// besoin pour lire + synchroniser l'état lu/étoilé. La gestion des flux
// (ajout/suppression) reste dans l'admin DailySpoon : les endpoints
// d'édition d'abonnement répondent OK sans rien faire.
//
// Fidèle à l'esprit « En direct = 0 IA » : on sert TOUJOURS le texte brut du
// flux (sourceTitle/sourceExcerpt), jamais le titre/résumé réécrit par l'IA.

// ————————————————————————————————————————————————————————————————
// Constantes de flux (stream ids) standard de l'API Google Reader
// ————————————————————————————————————————————————————————————————
const STREAM_READING_LIST = "user/-/state/com.google/reading-list"; // tout
const STREAM_READ = "user/-/state/com.google/read";
const STREAM_UNREAD = "user/-/state/com.google/unread";
const STREAM_STARRED = "user/-/state/com.google/starred";
const LABEL_PREFIX = "user/-/label/";
const FEED_PREFIX = "feed/";
// Préfixe pour un flux sans feedId en base (rare) : on le repère par son titre.
const SYNTHETIC_FEED_PREFIX = "dailyspoon-title:";

const ITEM_LONG_PREFIX = "tag:google.com,2005:reader/item/";

const GREADER_USER = "dailyspoon";

// ————————————————————————————————————————————————————————————————
// Authentification
// ————————————————————————————————————————————————————————————————

/** Jeton renvoyé par ClientLogin et attendu ensuite dans l'en-tête
 *  "Authorization: GoogleLogin auth=…". Dérivé du mot de passe admin (même
 *  HMAC que la session web, voir auth.ts) — stable tant que le mot de passe ne
 *  change pas, donc Readrops n'a pas à se reconnecter à chaque redéploiement. */
export async function buildAuthToken(): Promise<string> {
  const pwd = process.env.ADMIN_PASSWORD || "";
  return `${GREADER_USER}/${await sessionTokenForPassword(pwd)}`;
}

/** Vérifie l'en-tête Authorization d'une requête /reader/*. Si aucun mot de
 *  passe admin n'est configuré, on laisse passer (même convention "dev ouvert"
 *  que isValidSessionToken dans auth.ts). */
export async function isAuthorized(authHeader: string | null): Promise<boolean> {
  if (!process.env.ADMIN_PASSWORD) return true;
  if (!authHeader) return false;
  const m = /GoogleLogin\s+auth=(.+)/.exec(authHeader);
  if (!m) return false;
  const provided = m[1].trim();
  const expected = await buildAuthToken();
  if (provided.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < provided.length; i++) diff |= provided.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

/** Comparaison à temps constant de deux chaînes (mot de passe API dédié). */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/** Vrai si le mot de passe fourni au ClientLogin est valide : soit le mot de
 *  passe API DÉDIÉ (greaderApiPassword, s'il est défini dans /admin/settings),
 *  soit le mot de passe admin (rétrocompat, toujours accepté). Le mot de passe
 *  dédié existe justement pour éviter les caractères spéciaux d'un mot de passe
 *  admin complexe qui se déforment en form-urlencoded lors du transit depuis le
 *  lecteur (Readrops) et provoquent un 403 alors que le mot de passe est bon. */
async function credentialMatches(provided: string): Promise<boolean> {
  const { greaderApiPassword } = await getSettings();
  if (greaderApiPassword && constantTimeEqual(provided, greaderApiPassword)) return true;
  return isCorrectPassword(provided);
}

/** Réponse texte de /accounts/ClientLogin. Email accepté tel quel (on ne gère
 *  qu'un seul compte, "dailyspoon") ; seul le mot de passe est vérifié (voir
 *  credentialMatches). Renvoie null si le mot de passe est faux.
 *  On .trim() le mot de passe reçu : certains lecteurs ajoutent un espace ou un
 *  retour à la ligne parasite en fin de champ, ce qui, avec la comparaison à
 *  longueur stricte de constantTimeEqual, provoquerait un 403 alors que le code
 *  est bon. */
export async function clientLogin(password: string): Promise<string | null> {
  if (!(await credentialMatches(password.trim()))) return null;
  const token = await buildAuthToken();
  return `SID=${token}\nLSID=${token}\nAuth=${token}\n`;
}

// ————————————————————————————————————————————————————————————————
// Conversions d'identifiants d'articles
// ————————————————————————————————————————————————————————————————

/** Forme longue de l'id d'un item, telle qu'attendue par le lecteur.
 *  CRITIQUE : elle doit être IDENTIQUE, octet pour octet, à celle que Readrops
 *  RECONSTRUIT à partir de la forme décimale renvoyée par stream/items/ids. Son
 *  adapter fait exactement : hex(decimal).padStart(longueur_de_la_chaîne_décimale).
 *  Si on padde à 16 (comme le fait FreshRSS avec ses gros id 64 bits) alors que
 *  nos id sont petits, l'id de l'article (« ...000000000000ceb ») ne coïncide
 *  jamais avec l'id d'état lu/non-lu reconstruit par Readrops (« ...0ceb ») :
 *  la synchro lu/non-lu et les compteurs tombent alors à 0. On réplique donc
 *  EXACTEMENT sa formule (padStart sur la longueur du décimal). */
function toLongItemId(greaderId: number): string {
  const decimal = String(greaderId);
  return ITEM_LONG_PREFIX + greaderId.toString(16).padStart(decimal.length, "0");
}

/** Forme courte/décimale, utilisée dans itemRefs (stream/items/ids). */
function toDecimalItemId(greaderId: number): string {
  return String(greaderId);
}

/** Analyse un id d'item ENVOYÉ par le client (edit-tag, stream/items/contents).
 *  Le client renvoie soit la forme longue (préfixe + hex), soit un hex 16, soit
 *  un décimal (repris d'itemRefs) — on couvre les trois. */
function parseIncomingItemId(raw: string): number | null {
  let s = raw.trim();
  if (s.startsWith(ITEM_LONG_PREFIX)) {
    s = s.slice(ITEM_LONG_PREFIX.length);
    return safeNumber(BigInt("0x" + s));
  }
  if (/^[0-9]+$/.test(s)) return safeNumber(BigInt(s)); // décimal
  if (/^[0-9a-f]{16}$/i.test(s)) return safeNumber(BigInt("0x" + s)); // hex 16
  return null;
}
function safeNumber(b: bigint): number | null {
  const n = Number(b);
  return Number.isSafeInteger(n) ? n : null;
}

// ————————————————————————————————————————————————————————————————
// Flux (stream id) <-> filtre Prisma
// ————————————————————————————————————————————————————————————————

function feedStreamId(feedId: string | null, feedTitle: string): string {
  return FEED_PREFIX + (feedId || `${SYNTHETIC_FEED_PREFIX}${feedTitle}`);
}

/** Filtre commun : seuls les articles réellement affichés par DailySpoon
 *  (inclus, traités), en respectant le même choix que « En direct » (FreshRSS
 *  désactivé -> uniquement les flux perso). */
async function baseWhere(): Promise<Prisma.ArticleWhereInput> {
  const { freshrssEnabled } = await getSettings();
  return {
    processed: true,
    included: true,
    ...(freshrssEnabled ? {} : { feedId: { startsWith: "custom-feed:" } })
  };
}

/** Traduit un stream id Google Reader (s=…) en filtre Prisma additionnel. */
function streamToWhere(streamId: string | null): Prisma.ArticleWhereInput {
  if (!streamId || streamId === STREAM_READING_LIST) return {};
  if (streamId === STREAM_READ) return { readState: true };
  if (streamId === STREAM_UNREAD) return { readState: false };
  if (streamId === STREAM_STARRED) return { favorite: true };
  if (streamId.startsWith(LABEL_PREFIX)) return { categoryLabel: streamId.slice(LABEL_PREFIX.length) };
  if (streamId.startsWith(FEED_PREFIX)) {
    const raw = streamId.slice(FEED_PREFIX.length);
    if (raw.startsWith(SYNTHETIC_FEED_PREFIX)) return { feedTitle: raw.slice(SYNTHETIC_FEED_PREFIX.length) };
    return { feedId: raw };
  }
  return {};
}

/** Filtre d'EXCLUSION (xt=…). Readrops s'en sert pour distinguer lu/non-lu :
 *  - xt=read   -> exclure les lus   -> ne garder que le NON-lu
 *  - xt=unread -> exclure les non-lus -> ne garder que le LU (readIds au refresh)
 *  Sans le cas xt=unread, readIds renvoyait TOUS les articles et le lecteur les
 *  marquait tous « lus » (compteurs à 0, tout apparaît déjà lu). */
function excludeToWhere(xt: string | null): Prisma.ArticleWhereInput {
  if (xt === STREAM_READ) return { readState: false };
  if (xt === STREAM_UNREAD) return { readState: true };
  if (xt === STREAM_STARRED) return { favorite: false };
  return {};
}

// ————————————————————————————————————————————————————————————————
// Endpoints (renvoient des objets JS ; la route sérialise)
// ————————————————————————————————————————————————————————————————

export function userInfo() {
  return {
    userId: GREADER_USER,
    userName: GREADER_USER,
    userProfileId: GREADER_USER,
    userEmail: "",
    isBloggerUser: false,
    signupTimeSec: 0,
    isMultiLoginEnabled: false
  };
}

export async function subscriptionList() {
  const where = await baseWhere();
  // Un représentant par flux (distinct feedId) : chaque flux a un unique
  // categoryLabel dans DailySpoon, donc la première ligne suffit.
  const rows = await prisma.article.findMany({
    where,
    select: { feedId: true, feedTitle: true, categoryLabel: true, sourceUrl: true },
    distinct: ["feedId"],
    orderBy: { publishedAt: "desc" }
  });

  const subscriptions = rows.map((r) => {
    let htmlUrl = "";
    try {
      htmlUrl = new URL(r.sourceUrl).origin;
    } catch {
      /* URL source absente/malformée : htmlUrl vide, sans conséquence */
    }
    const categories = r.categoryLabel
      ? [{ id: `${LABEL_PREFIX}${r.categoryLabel}`, label: r.categoryLabel }]
      : [];
    return {
      id: feedStreamId(r.feedId, r.feedTitle),
      title: r.feedTitle,
      categories,
      url: htmlUrl,
      htmlUrl,
      iconUrl: ""
    };
  });
  return { subscriptions };
}

export async function tagList() {
  const where = await baseWhere();
  const rows = await prisma.article.findMany({
    where: { ...where, categoryLabel: { not: null } },
    select: { categoryLabel: true },
    distinct: ["categoryLabel"]
  });
  const tags: { id: string; type?: string }[] = [
    { id: STREAM_STARRED }
  ];
  for (const r of rows) {
    if (r.categoryLabel) tags.push({ id: `${LABEL_PREFIX}${r.categoryLabel}`, type: "folder" });
  }
  return { tags };
}

function usec(d: Date | null): string {
  return d ? String(d.getTime() * 1000) : "0";
}

export async function unreadCount() {
  const where = await baseWhere();
  const unreadWhere: Prisma.ArticleWhereInput = { ...where, readState: false };

  const [total, byFeed, byLabel] = await Promise.all([
    prisma.article.aggregate({ where: unreadWhere, _count: { _all: true }, _max: { publishedAt: true } }),
    prisma.article.groupBy({
      by: ["feedId", "feedTitle"],
      where: unreadWhere,
      _count: { _all: true },
      _max: { publishedAt: true }
    }),
    prisma.article.groupBy({
      by: ["categoryLabel"],
      where: { ...unreadWhere, categoryLabel: { not: null } },
      _count: { _all: true },
      _max: { publishedAt: true }
    })
  ]);

  const unreadcounts: { id: string; count: number; newestItemTimestampUsec: string }[] = [
    {
      id: STREAM_READING_LIST,
      count: total._count._all,
      newestItemTimestampUsec: usec(total._max.publishedAt)
    }
  ];
  for (const f of byFeed) {
    unreadcounts.push({
      id: feedStreamId(f.feedId, f.feedTitle),
      count: f._count._all,
      newestItemTimestampUsec: usec(f._max.publishedAt)
    });
  }
  for (const l of byLabel) {
    if (!l.categoryLabel) continue;
    unreadcounts.push({
      id: `${LABEL_PREFIX}${l.categoryLabel}`,
      count: l._count._all,
      newestItemTimestampUsec: usec(l._max.publishedAt)
    });
  }
  return { max: 1000, unreadcounts };
}

type StreamParams = {
  s: string | null; // stream id
  xt: string | null; // exclusion
  n: number; // nombre max
  oldestFirst: boolean; // r=o
  continuation: number; // offset
  newerThanSec: number | null; // ot=
};

async function resolveStreamWhere(params: StreamParams): Promise<Prisma.ArticleWhereInput> {
  const base = await baseWhere();
  const where: Prisma.ArticleWhereInput = {
    ...base,
    ...streamToWhere(params.s),
    ...excludeToWhere(params.xt)
  };
  if (params.newerThanSec != null) {
    where.publishedAt = { gte: new Date(params.newerThanSec * 1000) };
  }
  return where;
}

export async function streamItemsIds(params: StreamParams) {
  const where = await resolveStreamWhere(params);
  const rows = await prisma.article.findMany({
    where,
    select: { greaderId: true, publishedAt: true, feedId: true, feedTitle: true },
    orderBy: { publishedAt: params.oldestFirst ? "asc" : "desc" },
    skip: params.continuation,
    take: params.n + 1 // +1 pour savoir s'il reste une page
  });

  const hasMore = rows.length > params.n;
  const page = hasMore ? rows.slice(0, params.n) : rows;

  // IMPORTANT : n'émettre QUE { id } ici. Le parseur de certains lecteurs
  // (Readrops) lit l'id puis attend immédiatement la fin de l'objet — tout
  // champ supplémentaire (timestampUsec, directStreamIds…) provoque une
  // ParseException « Expected END_OBJECT but was NAME at $.itemRefs[0].id ».
  // C'est aussi le comportement par défaut de FreshRSS pour cet endpoint.
  const itemRefs = page.map((r) => ({
    id: toDecimalItemId(r.greaderId)
  }));

  const result: { itemRefs: typeof itemRefs; continuation?: string } = { itemRefs };
  if (hasMore) result.continuation = String(params.continuation + params.n);
  return result;
}

function buildItem(a: {
  greaderId: number;
  sourceTitle: string;
  sourceExcerpt: string | null;
  sourceUrl: string;
  feedId: string | null;
  feedTitle: string;
  categoryLabel: string | null;
  publishedAt: Date | null;
  fetchedAt: Date;
  readState: boolean;
  favorite: boolean;
}) {
  const publishedSec = a.publishedAt ? Math.floor(a.publishedAt.getTime() / 1000) : Math.floor(a.fetchedAt.getTime() / 1000);
  const categories: string[] = [STREAM_READING_LIST];
  if (a.readState) categories.push(STREAM_READ);
  if (a.favorite) categories.push(STREAM_STARRED);
  if (a.categoryLabel) categories.push(`${LABEL_PREFIX}${a.categoryLabel}`);
  // URL propre (sans paramètres de suivi) : couvre aussi les articles déjà
  // stockés avant le nettoyage à l'ingestion.
  const cleanUrl = cleanArticleUrl(a.sourceUrl) || a.sourceUrl;
  let htmlUrl = "";
  try {
    htmlUrl = new URL(cleanUrl).origin;
  } catch {
    /* ignore */
  }
  return {
    id: toLongItemId(a.greaderId),
    crawlTimeMsec: String(a.fetchedAt.getTime()),
    timestampUsec: usec(a.publishedAt ?? a.fetchedAt),
    published: publishedSec,
    // texte BRUT du flux, jamais l'IA. Jamais vide : l'adapter de Readrops
    // exige un titre non vide (nextNonEmptyString), un titre "" ferait échouer
    // le parsing de TOUS les items.
    title: (a.sourceTitle && a.sourceTitle.trim()) || a.feedTitle || "(sans titre)",
    summary: { content: a.sourceExcerpt || "" },
    // IMPORTANT : n'émettre QUE { href } dans alternate/canonical. Le parseur
    // strict de certains lecteurs (Readrops) lit href puis exige la fin de
    // l'objet ; tout champ derrière (ex. "type") provoque une ParseException
    // « Expected END_OBJECT but was NAME at $.items[0].alternate[0].href » qui
    // fait échouer TOUTE la synchro (bug Readrops connu, cf. FreshRSS #4567 —
    // même cause que l'itemRefs.id plus haut).
    alternate: [{ href: cleanUrl }],
    canonical: [{ href: cleanUrl }],
    categories,
    origin: { streamId: feedStreamId(a.feedId, a.feedTitle), title: a.feedTitle, htmlUrl },
    author: ""
  };
}

const ITEM_SELECT = {
  greaderId: true,
  sourceTitle: true,
  sourceExcerpt: true,
  sourceUrl: true,
  feedId: true,
  feedTitle: true,
  categoryLabel: true,
  publishedAt: true,
  fetchedAt: true,
  readState: true,
  favorite: true
} as const;

/** stream/items/contents : le client envoie une liste d'ids, on renvoie le
 *  contenu de chacun. */
export async function streamItemsContents(rawIds: string[]) {
  const ids = rawIds.map(parseIncomingItemId).filter((n): n is number => n != null);
  if (ids.length === 0) return { id: STREAM_READING_LIST, updated: Math.floor(Date.now() / 1000), items: [] };

  const rows = await prisma.article.findMany({ where: { greaderId: { in: ids } }, select: ITEM_SELECT });
  // On respecte l'ordre demandé par le client.
  const byId = new Map(rows.map((r) => [r.greaderId, r]));
  const items = ids.map((id) => byId.get(id)).filter(Boolean).map((r) => buildItem(r!));
  return { id: STREAM_READING_LIST, updated: Math.floor(Date.now() / 1000), items };
}

/** stream/contents/<streamId> : variante "tout le flux paginé", utilisée par
 *  certains clients à la place d'ids + contents. */
export async function streamContents(params: StreamParams) {
  const where = await resolveStreamWhere(params);
  const rows = await prisma.article.findMany({
    where,
    select: ITEM_SELECT,
    orderBy: { publishedAt: params.oldestFirst ? "asc" : "desc" },
    skip: params.continuation,
    take: params.n + 1
  });
  const hasMore = rows.length > params.n;
  const page = hasMore ? rows.slice(0, params.n) : rows;
  const result: {
    id: string;
    updated: number;
    items: ReturnType<typeof buildItem>[];
    continuation?: string;
  } = {
    id: params.s || STREAM_READING_LIST,
    updated: Math.floor(Date.now() / 1000),
    items: page.map((r) => buildItem(r))
  };
  if (hasMore) result.continuation = String(params.continuation + params.n);
  return result;
}

/** edit-tag : marque lu/non-lu et étoilé/non-étoilé. L'étoile est mappée sur
 *  le favori DailySpoon — donc étoiler depuis Readrops envoie AUSSI l'article à
 *  Wallabag si l'intégration est configurée (même chemin que l'étoile web). */
export async function editTag(rawIds: string[], add: string[], remove: string[]) {
  const ids = rawIds.map(parseIncomingItemId).filter((n): n is number => n != null);
  if (ids.length === 0) return;

  const setRead = add.includes(STREAM_READ);
  const unsetRead = remove.includes(STREAM_READ);
  const setStar = add.includes(STREAM_STARRED);
  const unsetStar = remove.includes(STREAM_STARRED);

  if (setRead || unsetRead) {
    await prisma.article.updateMany({ where: { greaderId: { in: ids } }, data: { readState: setRead ? true : false } });
  }
  if (setStar || unsetStar) {
    const favorite = setStar ? true : false;
    await prisma.article.updateMany({
      where: { greaderId: { in: ids } },
      data: { favorite, favoritedAt: favorite ? new Date() : null }
    });
    if (favorite) {
      // Comme l'étoile web (voir /api/articles/favorite) : envoi best-effort à
      // Wallabag, non bloquant. On récupère les URLs concernées pour les pousser.
      const rows = await prisma.article.findMany({
        where: { greaderId: { in: ids } },
        select: { sourceUrl: true, sourceTitle: true, sourceExcerpt: true }
      });
      for (const r of rows) {
        if (r.sourceUrl) void sendFavoriteToWallabag(r.sourceUrl, { title: r.sourceTitle, excerpt: r.sourceExcerpt });
      }
    }
  }
}

/** mark-all-as-read : marque tout le flux comme lu (jusqu'à un horodatage
 *  optionnel `ts`, en microsecondes, fourni par le client). */
export async function markAllAsRead(streamId: string | null, tsUsec: number | null) {
  const base = await baseWhere();
  const where: Prisma.ArticleWhereInput = { ...base, ...streamToWhere(streamId), readState: false };
  if (tsUsec != null) {
    where.publishedAt = { lte: new Date(Math.floor(tsUsec / 1000)) };
  }
  await prisma.article.updateMany({ where, data: { readState: true } });
}

export { STREAM_READ, STREAM_STARRED };
