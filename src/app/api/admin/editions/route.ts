import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Supprime une édition archivée (/archive) — définitif, en base. Sûr pour
// les VRAIS articles vivants : EditionArticle.editionId est en ON DELETE
// CASCADE (juste les liens de la photo figée disparaissent), et
// Article.editionId est en ON DELETE SET NULL (l'article lui-même reste
// intact, juste détaché de cette édition précise — voir schema.prisma) :
// rien n'est jamais perdu côté En direct/recherche/favoris, uniquement
// l'entrée d'archive elle-même.
export async function DELETE(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json().catch(() => ({}));
    const id = typeof body.id === "string" ? body.id : "";
    if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

    const edition = await prisma.edition.findUnique({ where: { id }, select: { id: true } });
    if (!edition) return NextResponse.json({ error: "Édition introuvable" }, { status: 404 });

    await prisma.edition.delete({ where: { id } });

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[admin/editions] DELETE failed:", err);
    return NextResponse.json({ error: err?.message || "Échec de la suppression" }, { status: 500 });
  }
}
