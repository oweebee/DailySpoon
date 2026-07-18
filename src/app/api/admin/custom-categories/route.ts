import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { customCategoryFreshrssId, customFeedFreshrssId, createCustomCategoryRecord } from "@/lib/customFeeds";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Catégories personnalisées (CustomCategory) — id synthétique
// "custom-cat:<id>" réutilisé directement dans SelectedCategory/
// AiPrintCategory, donc "selected"/"frontPageEnabled" se règlent avec les
// MÊMES routes que les catégories FreshRSS (/api/admin/categories, POST) :
// pas de doublon de logique ici, seulement la création/suppression, propres
// aux catégories personnalisées (une catégorie FreshRSS n'est ni créable ni
// supprimable depuis DailySpoon, géré côté FreshRSS).
//
// Gestion SECONDAIRE par rapport à l'ajout de flux (/api/admin/custom-feeds,
// qui permet aussi de créer une catégorie "à la volée" pendant l'ajout d'un
// flux). Ne renvoie plus les flux détaillés par catégorie (déplacés vers
// /api/admin/custom-feeds, liste à plat avec catégorie résolue) — seulement
// un compte, pour l'affichage ici.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [categories, selected, aiPrintCategories] = await Promise.all([
    prisma.customCategory.findMany({ include: { _count: { select: { feeds: true } } }, orderBy: { order: "asc" } }),
    prisma.selectedCategory.findMany(),
    prisma.aiPrintCategory.findMany()
  ]);
  const selectedIds = new Set(selected.map((s) => s.freshrssId));
  const frontPageEnabledById = new Map(aiPrintCategories.map((c) => [c.freshrssId, c.enabled]));

  const result = categories.map((cat) => {
    const catFreshrssId = customCategoryFreshrssId(cat.id);
    return {
      id: cat.id,
      label: cat.label,
      selected: selectedIds.has(catFreshrssId),
      frontPageEnabled: frontPageEnabledById.get(catFreshrssId) ?? true,
      feedCount: cat._count.feeds
    };
  });

  return NextResponse.json({ categories: result });
}

// Crée une nouvelle catégorie personnalisée — sélectionnée par défaut
// (visible immédiatement dans En direct), puisque l'utilisateur la crée
// explicitement pour l'utiliser.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const label = typeof body.label === "string" ? body.label.trim() : "";
  if (!label) return NextResponse.json({ error: "label requis" }, { status: 400 });

  const category = await createCustomCategoryRecord(label);

  return NextResponse.json({ category: { id: category.id, label: category.label } });
}

// Supprime une catégorie personnalisée : cascade sur ses flux (FK
// ON DELETE CASCADE), nettoie les réglages qui référencent son id
// synthétique (SelectedCategory/AiPrintCategory + ExcludedFeed/MedalFeed de
// chacun de ses flux), et masque (sans les supprimer, cohérent avec le
// reste de l'app — voir /api/admin/categories) les articles déjà récupérés.
export async function DELETE(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

  const category = await prisma.customCategory.findUnique({ where: { id }, include: { feeds: true } });
  if (!category) return NextResponse.json({ error: "Catégorie introuvable" }, { status: 404 });

  const catFreshrssId = customCategoryFreshrssId(id);
  const feedFreshrssIds = category.feeds.map((f) => customFeedFreshrssId(f.id));

  await prisma.$transaction([
    prisma.selectedCategory.deleteMany({ where: { freshrssId: catFreshrssId } }),
    prisma.aiPrintCategory.deleteMany({ where: { freshrssId: catFreshrssId } }),
    prisma.excludedFeed.deleteMany({ where: { freshrssId: { in: feedFreshrssIds } } }),
    prisma.medalFeed.deleteMany({ where: { freshrssId: { in: feedFreshrssIds } } }),
    prisma.article.updateMany({ where: { feedId: { in: feedFreshrssIds } }, data: { included: false } }),
    prisma.customCategory.delete({ where: { id } }) // cascade -> CustomFeed
  ]);

  return NextResponse.json({ ok: true });
}
