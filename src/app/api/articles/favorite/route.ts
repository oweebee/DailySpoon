import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { sendFavoriteToWallabag } from "@/lib/wallabagSend";

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

  const updated = await prisma.article.update({
    where: { id: articleId },
    data: { favorite, favoritedAt: favorite ? new Date() : null },
    select: { sourceUrl: true }
  });

  // Intégration Wallabag (si configurée dans /admin/settings) : mettre en
  // favori envoie le lien de l'article à Wallabag pour archivage. UNIQUEMENT
  // à l'ajout (favorite === true), jamais au retrait (choix explicite : on ne
  // supprime rien côté Wallabag). Best-effort et non bloquant : on n'attend
  // PAS la fin de l'envoi pour répondre, et sendFavoriteToWallabag ne lève
  // jamais (échec tracé dans /admin/logs) — un souci Wallabag ne doit pas
  // faire échouer la mise en favori locale ni ralentir l'UI. Ne fait rien
  // silencieusement si l'intégration n'est pas configurée.
  if (favorite && updated.sourceUrl) {
    void sendFavoriteToWallabag(updated.sourceUrl);
  }

  return NextResponse.json({ ok: true });
}
