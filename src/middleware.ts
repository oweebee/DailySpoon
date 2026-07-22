import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

// Tout le site est protégé par le mot de passe admin : une seule session
// permet de lire le journal ET d'administrer, sans retaper le mot de passe.
// Seules exceptions :
// - /admin/login et /api/admin/login : nécessaires pour se connecter
// - /api/cron/generate : appelé par le cron avec CRON_SECRET (la route
//   fait sa propre vérification d'auth)
// - /api/greader.php : API Google Reader pour lecteurs externes type Readrops
//   (voir src/lib/greader.ts). Readrops ne possède pas le cookie de session
//   admin : il s'authentifie via l'en-tête "Authorization: GoogleLogin auth=…"
//   (jeton obtenu par ClientLogin, dérivé du mot de passe admin) — la route
//   fait donc sa PROPRE vérification d'auth sur chaque appel.
const PUBLIC_PATHS = [
  "/admin/login",
  "/api/admin/login",
  "/api/cron/generate",
  "/api/greader.php"
];

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(p + "/"))) {
    return NextResponse.next();
  }

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  if (!(await isValidSessionToken(token))) {
    // Les appels API reçoivent un 401 JSON, les pages une redirection.
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    }
    const loginUrl = new URL("/admin/login", req.url);
    loginUrl.searchParams.set("next", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Tout sauf les assets statiques de Next et le favicon.
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|svg|ico|webp|txt|xml)).*)"]
};
