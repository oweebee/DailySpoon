import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (pathname.startsWith("/admin") && pathname !== "/admin/login") {
    const token = req.cookies.get(SESSION_COOKIE)?.value;
    if (!(await isValidSessionToken(token))) {
      const loginUrl = new URL("/admin/login", req.url);
      loginUrl.searchParams.set("next", pathname);
      return NextResponse.redirect(loginUrl);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/admin/:path*"]
};
