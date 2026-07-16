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
    const frontPageEnabledById = new Map(selected.map((s) => [s.freshrssId, s.frontPageEnabled]));

    // Catégories sélectionnées d'abord, dans l'ordre choisi dans
    // /admin/categories (persisté en base) ; le reste ensuite, par ordre
    // alphabétique.
    const categories = freshrssCategories
      .map((c) => ({
        freshrssId: c.freshrssId,
        label: c.label,
        selected: selectedIds.has(c.freshrssId),
        order: orderById.get(c.freshrssId) ?? null,
        frontPageEnabled: frontPageEnabledById.get(c.freshrssId) ?? true
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
  const { freshrssId, label, selected, frontPageEnabled } = body as {
    freshrssId?: string;
    label?: string;
    selected?: boolean;
    frontPageEnabled?: boolean;
  };

  if (!freshrssId || !label) {
    return NextResponse.json({ error: "freshrssId et label sont requis" }, { status: 400 });
  }

  // Bascule dédiée à la carte "Impression IA" : ne touche ni à la sélection
  // ni à l'ordre, juste au flag frontPageEnabled de la ligne déjà existante
  // (une catégorie doit déjà être sélectionnée pour apparaître dans cette
  // carte, donc la ligne existe forcément à ce stade).
  if (typeof frontPageEnabled === "boolean" && typeof selected !== "boolean") {
    await prisma.selectedCategory.update({
      where: { freshrssId },
      data: { frontPageEnabled }
    });
    return NextResponse.json({ ok: true });
  }

  if (typeof selected !== "boolean") {
    return NextResponse.json({ error: "selected (booléen) requis" }, { status: 400 });
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

    // Recoché : les articles déjà stockés de cette catégorie redeviennent
    // visibles, sauf ceux dont le flux reste explicitement exclu par
    // ailleurs (ExcludedFeed) — ceux-là doivent rester masqués.
    const excludedFeeds = await prisma.excludedFeed.findMany({ select: { freshrssId: true, label: true } });
    const excludedFeedIds = excludedFeeds.map((f) => f.freshrssId);
    const excludedFeedTitles = excludedFeeds.map((f) => f.label);

    const { count } = await prisma.article.updateMany({
      where: {
        categoryLabel: label,
        NOT: {
          OR: [
            { feedId: { in: excludedFeedIds } },
            { feedId: null, feedTitle: { in: excludedFeedTitles } }
          ]
        }
      },
      data: { included: true }
    });
    if (count > 0) {
      console.log(`[admin/categories] ${count} article(s) réinclus pour la catégorie "${label}".`);
    }
  } else {
    await prisma.selectedCategory.deleteMany({ where: { freshrssId } });
    // "décoché" ne purge plus les articles : ils restent en base pour rester
    // trouvables par la recherche, mais disparaissent des vues normales via
    // le flag included (jamais réanalysés par l'IA tant que la catégorie
    // reste décochée).
    const { count } = await prisma.article.updateMany({
      where: { categoryLabel: label },
      data: { included: false }
    });
    if (count > 0) {
      console.log(`[admin/categories] ${count} article(s) exclus pour la catégorie décochée "${label}".`);
    }
  }

  return NextResponse.json({ ok: true });
}
