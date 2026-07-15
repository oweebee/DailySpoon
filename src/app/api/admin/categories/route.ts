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
    const orderById = new Map(selected.map((s) => [s.freshrssId, s.order]));

    // Catégories sélectionnées d'abord, dans l'ordre choisi dans
    // /admin/categories (persisté en base) ; le reste ensuite, par ordre
    // alphabétique.
    const categories = freshrssCategories
      .map((c) => ({
        freshrssId: c.freshrssId,
        label: c.label,
        selected: selectedIds.has(c.freshrssId),
        order: orderById.get(c.freshrssId) ?? null
      }))
      .sort((a, b) => {
        if (a.order !== null && b.order !== null) return a.order - b.order;
        if (a.order !== null) return -1;
        if (b.order !== null) return 1;
        return a.label.localeCompare(b.label);
      });

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
    // Nouvelle sélection : on l'ajoute à la fin de l'ordre actuel plutôt
    // qu'en position 0, pour ne pas bousculer l'ordre déjà choisi.
    const maxOrder = await prisma.selectedCategory.aggregate({ _max: { order: true } });
    await prisma.selectedCategory.upsert({
      where: { freshrssId },
      update: { label },
      create: { freshrssId, label, order: (maxOrder._max.order ?? -1) + 1 }
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
