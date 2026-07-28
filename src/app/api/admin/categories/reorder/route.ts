import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Persists the display order of selected categories (used to order the
// columns in EditionView / "En direct"). Body: { freshrssIds: string[] },
// the full list of selected category ids in the desired order. Saved to
// Postgres (SelectedCategory.order) so it survives redeploys and reboots,
// same as every other setting.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { freshrssIds } = body as { freshrssIds?: string[] };

  if (!Array.isArray(freshrssIds) || freshrssIds.some((id) => typeof id !== "string")) {
    return NextResponse.json({ error: "freshrssIds (tableau de chaînes) est requis" }, { status: 400 });
  }

  await prisma.$transaction(
    freshrssIds.map((freshrssId, index) =>
      prisma.selectedCategory.updateMany({
        where: { freshrssId },
        data: { order: index }
      })
    )
  );

  return NextResponse.json({ ok: true });
}
