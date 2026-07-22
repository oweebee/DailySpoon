import { NextRequest, NextResponse } from "next/server";
import {
  buildAuthToken,
  clientLogin,
  isAuthorized,
  userInfo,
  subscriptionList,
  tagList,
  unreadCount,
  streamItemsIds,
  streamItemsContents,
  streamContents,
  editTag,
  markAllAsRead
} from "@/lib/greader";
import { writeLog } from "@/lib/logger";

// Prisma -> runtime Node complet (pas edge). Toujours dynamique (dépend de la
// base et de l'en-tête d'auth, jamais mis en cache).
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Point d'entrée unique de l'API Google Reader de DailySpoon (voir
// src/lib/greader.ts pour le POURQUOI et la logique métier). Un lecteur externe
// (Readrops...) configuré en compte « FreshRSS » et pointé sur l'URL de
// DailySpoon tape ici, sur des chemins comme :
//   /api/greader.php/accounts/ClientLogin
//   /api/greader.php/reader/api/0/subscription/list
// Cette route attrape TOUT ce qui suit "/api/greader.php/" via le segment
// catch-all [[...path]] et le dispatche.

function textResponse(body: string, status = 200): NextResponse {
  return new NextResponse(body, { status, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

function joinPath(path: string[] | undefined): string {
  return "/" + (path || []).join("/");
}

/** Lit un paramètre à la fois dans la query string ET dans le corps de formulaire
 *  déjà analysé (les clients envoient tantôt l'un tantôt l'autre). */
function param(url: URL, form: URLSearchParams | null, key: string): string | null {
  return url.searchParams.get(key) ?? form?.get(key) ?? null;
}
/** Valeurs multiples (ex. plusieurs "i=" pour edit-tag / items/contents). */
function paramAll(url: URL, form: URLSearchParams | null, key: string): string[] {
  return [...url.searchParams.getAll(key), ...(form ? form.getAll(key) : [])];
}

async function readForm(req: NextRequest): Promise<URLSearchParams | null> {
  if (req.method !== "POST") return null;
  const ct = req.headers.get("content-type") || "";
  try {
    // Les lecteurs n'envoient pas tous le même format de corps : Readrops
    // (okhttp) poste les identifiants en multipart/form-data, d'autres en
    // application/x-www-form-urlencoded. req.formData() gère NATIVEMENT les
    // deux ; on convertit ensuite en URLSearchParams pour le reste du code.
    // (Un mauvais parsing ici renvoyait Email/Passwd vides -> 403 alors que
    // le mot de passe était bon.)
    if (ct.includes("multipart/form-data") || ct.includes("application/x-www-form-urlencoded")) {
      const fd = await req.formData();
      const sp = new URLSearchParams();
      for (const [k, v] of fd.entries()) if (typeof v === "string") sp.append(k, v);
      return sp;
    }
    // Repli : corps texte brut (certains clients n'envoient pas de content-type).
    const text = await req.text();
    return new URLSearchParams(text);
  } catch {
    return null;
  }
}

async function handle(req: NextRequest, path: string[] | undefined): Promise<NextResponse> {
  const url = new URL(req.url);
  const form = await readForm(req);
  const endpoint = joinPath(path); // ex. "/accounts/ClientLogin", "/reader/api/0/token"

  // — Authentification (non protégée) —
  if (endpoint === "/accounts/ClientLogin") {
    const email = param(url, form, "Email") || "";
    const passwd = param(url, form, "Passwd") || "";
    const body = await clientLogin(passwd);
    // Diagnostic (temporaire) : sur ÉCHEC seulement, on trace ce qui est
    // réellement arrivé — sans jamais écrire le mot de passe en clair. On note
    // sa longueur, ses 2 premiers/derniers caractères et les codes de tout
    // caractère non-alphanumérique (pour repérer un espace/retour/caractère
    // invisible ajouté par le lecteur). But : trancher "code faux" vs "requête
    // déformée en transit" sans deviner.
    if (!body) {
      const p = passwd;
      const hidden = [...p]
        .map((c, i) => (/[a-zA-Z0-9]/.test(c) ? null : `@${i}=${c.charCodeAt(0)}`))
        .filter(Boolean)
        .join(",");
      const preview = p.length <= 4 ? "" : `${p.slice(0, 2)}…${p.slice(-2)}`;
      void writeLog(
        "warn",
        "greader",
        "ClientLogin refusé (403)",
        `method=${req.method} ct=${req.headers.get("content-type") || "-"} ` +
          `emailLen=${email.length} passwdLen=${p.length} preview=${preview} ` +
          `nonAlnum=[${hidden}] ua=${(req.headers.get("user-agent") || "-").slice(0, 80)}`
      );
      return textResponse("Error=BadAuthentication", 403);
    }
    void email; // accepté tel quel : un seul compte "dailyspoon"
    return textResponse(body);
  }

  // — Tout le reste (/reader/*) exige l'en-tête GoogleLogin —
  if (!(await isAuthorized(req.headers.get("authorization")))) {
    return textResponse("Error=BadAuthentication", 401);
  }

  // Jeton d'écriture (le client le renvoie ensuite en "T=" ; on ne le
  // re-vérifie pas strictement, l'en-tête Authorization suffit).
  if (endpoint === "/reader/api/0/token") {
    return textResponse(await buildAuthToken());
  }

  if (endpoint === "/reader/api/0/user-info") {
    return NextResponse.json(userInfo());
  }

  if (endpoint === "/reader/api/0/subscription/list") {
    return NextResponse.json(await subscriptionList());
  }

  if (endpoint === "/reader/api/0/tag/list") {
    return NextResponse.json(await tagList());
  }

  if (endpoint === "/reader/api/0/unread-count") {
    return NextResponse.json(await unreadCount());
  }

  if (endpoint === "/reader/api/0/stream/items/ids") {
    return NextResponse.json(await streamItemsIds(parseStreamParams(url, form)));
  }

  if (endpoint === "/reader/api/0/stream/items/contents") {
    const ids = paramAll(url, form, "i");
    return NextResponse.json(await streamItemsContents(ids));
  }

  // stream/contents/<streamId...> : le stream id peut contenir des "/" (ex.
  // "user/-/state/com.google/reading-list"), donc on le reconstruit à partir du
  // reste du chemin après "/reader/api/0/stream/contents/".
  if (endpoint.startsWith("/reader/api/0/stream/contents/")) {
    const streamId = decodeURIComponent(endpoint.slice("/reader/api/0/stream/contents/".length));
    const p = parseStreamParams(url, form);
    p.s = streamId;
    return NextResponse.json(await streamContents(p));
  }

  if (endpoint === "/reader/api/0/edit-tag") {
    const ids = paramAll(url, form, "i");
    const add = paramAll(url, form, "a");
    const remove = paramAll(url, form, "r");
    await editTag(ids, add, remove);
    return textResponse("OK");
  }

  if (endpoint === "/reader/api/0/mark-all-as-read") {
    const s = param(url, form, "s");
    const tsRaw = param(url, form, "ts");
    const ts = tsRaw && /^-?\d+$/.test(tsRaw) ? Number(tsRaw) : null;
    await markAllAsRead(s, ts);
    return textResponse("OK");
  }

  // Endpoints de GESTION de flux (ajout/suppression/renommage) : DailySpoon
  // gère ses flux dans son propre admin, pas depuis le lecteur externe. On
  // répond OK sans rien faire pour ne pas faire échouer la synchro du client.
  if (
    endpoint === "/reader/api/0/subscription/edit" ||
    endpoint === "/reader/api/0/subscription/quickadd" ||
    endpoint === "/reader/api/0/rename-tag" ||
    endpoint === "/reader/api/0/disable-tag" ||
    endpoint === "/reader/api/0/edit"
  ) {
    return textResponse("OK");
  }

  return textResponse("Error=UnknownEndpoint", 404);
}

function parseStreamParams(url: URL, form: URLSearchParams | null) {
  const nRaw = param(url, form, "n");
  const n = nRaw && /^\d+$/.test(nRaw) ? Math.min(Number(nRaw), 10000) : 1000;
  const cRaw = param(url, form, "c");
  const continuation = cRaw && /^\d+$/.test(cRaw) ? Number(cRaw) : 0;
  const otRaw = param(url, form, "ot");
  const newerThanSec = otRaw && /^\d+$/.test(otRaw) ? Number(otRaw) : null;
  return {
    s: param(url, form, "s"),
    xt: param(url, form, "xt"),
    n,
    oldestFirst: param(url, form, "r") === "o",
    continuation,
    newerThanSec
  };
}

export async function GET(req: NextRequest, ctx: { params: { path?: string[] } }) {
  return handle(req, ctx.params.path);
}

export async function POST(req: NextRequest, ctx: { params: { path?: string[] } }) {
  return handle(req, ctx.params.path);
}
