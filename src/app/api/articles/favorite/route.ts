import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Marque ou démarque un article comme favori (étoile shérif à côté de la
// source, page /favoris).
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { articleId, favorite } = body as { articleId?: string; favorite?: boolean };

  if (!articleId || typeof favorite !== "boolean") {
    return NextResponse.json({ error: "articleId et favorite sont requis" }, { status: 400 });
  }

  await prisma.article.update({
    where: { id: articleId },
    data: { favorite, favoritedAt: favorite ? new Date() : null }
  });

  return NextResponse.json({ ok: true });
}
