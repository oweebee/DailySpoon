import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listAllCategories } from "@/lib/freshrss";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Returns every category/label found in FreshRSS, merged with which ones
// are currently selected in DailySpoon.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [freshrssCategories, selected] = await Promise.all([
      listAllCategories(),
      prisma.selectedCategory.findMany()
    ]);
    const selectedIds = new Set(selected.map((s) => s.freshrssId));

    const categories = freshrssCategories.map((c) => ({
      freshrssId: c.freshrssId,
      label: c.label,
      selected: selectedIds.has(c.freshrssId)
    }));

    return NextResponse.json({ categories });
  } catch (err: any) {
    console.error("[admin/categories] failed to load from FreshRSS:", err);
    return NextResponse.json(
      { error: err?.message || "Impossible de contacter FreshRSS" },
      { status: 502 }
    );
  }
}

// Toggle whether a category is included in the daily edition.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { freshrssId, label, selected } = body as {
    freshrssId?: string;
    label?: string;
    selected?: boolean;
  };

  if (!freshrssId || !label || typeof selected !== "boolean") {
    return NextResponse.json({ error: "freshrssId, label et selected sont requis" }, { status: 400 });
  }

  if (selected) {
    await prisma.selectedCategory.upsert({
      where: { freshrssId },
      update: { label },
      create: { freshrssId, label }
    });
  } else {
    await prisma.selectedCategory.deleteMany({ where: { freshrssId } });
    // "décoché" doit vider la catégorie partout, pas juste bloquer les
    // futures récupérations — on purge aussi les articles déjà stockés.
    const { count } = await prisma.article.deleteMany({ where: { categoryLabel: label } });
    if (count > 0) {
      console.log(`[admin/categories] Removed ${count} existing article(s) for deselected category "${label}".`);
    }
  }

  return NextResponse.json({ ok: true });
}
