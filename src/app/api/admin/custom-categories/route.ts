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

  try {
    const [categories, selected, aiPrintCategories] = await Promise.all([
      prisma.customCategory.findMany({ include: { _count: { select: { feeds: true } } }, orderBy: { order: "asc" } }),
      prisma.selectedCategory.findMany(),
      prisma.aiPrintCategory.findMany()
    ]);
    const selectedIds = new Set(selected.map((s) => s.freshrssId));
    const orderById = new Map(selected.map((s) => [s.freshrssId, s.order]));
    const frontPageEnabledById = new Map(aiPrintCategories.map((c) => [c.freshrssId, c.enabled]));

    const result = categories.map((cat) => {
      const catFreshrssId = customCategoryFreshrssId(cat.id);
      return {
        id: cat.id,
        label: cat.label,
        selected: selectedIds.has(catFreshrssId),
        // Même source d'ordre que les catégories FreshRSS (SelectedCategory.
        // order, PAS CustomCategory.order qui n'est qu'un compteur local aux
        // catégories perso) — nécessaire pour fusionner les deux listes dans
        // une seule arborescence triée de façon cohérente (voir /admin/categories).
        order: orderById.get(catFreshrssId) ?? null,
        frontPageEnabled: frontPageEnabledById.get(catFreshrssId) ?? true,
        feedCount: cat._count.feeds
      };
    });

    return NextResponse.json({ categories: result });
  } catch (err: any) {
    // Cause la plus probable : la migration Prisma 20260718140000_custom_feeds
    // n'a pas encore été appliquée en base (colonnes/tables manquantes).
    console.error("[admin/custom-categories] GET failed:", err);
    return NextResponse.json(
      { error: err?.message || "Impossible de charger les catégories personnalisées (migration appliquée ?)" },
      { status: 500 }
    );
  }
}

// Crée une nouvelle catégorie personnalisée — sélectionnée par défaut
// (visible immédiatement dans En direct), puisque l'utilisateur la crée
// explicitement pour l'utiliser.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json().catch(() => ({}));
    const label = typeof body.label === "string" ? body.label.trim() : "";
    if (!label) return NextResponse.json({ error: "label requis" }, { status: 400 });

    const category = await createCustomCategoryRecord(label);

    return NextResponse.json({ category: { id: category.id, label: category.label } });
  } catch (err: any) {
    console.error("[admin/custom-categories] POST failed:", err);
    return NextResponse.json(
      { error: err?.message || "Échec de la création de la catégorie (migration appliquée ?)" },
      { status: 500 }
    );
  }
}

// Supprime une catégorie personnalisée : cascade sur ses flux (FK
// ON DELETE CASCADE), nettoie les réglages qui référencent son id
// synthétique (SelectedCategory/AiPrintCategory + ExcludedFeed/MedalFeed de
// chacun de ses flux), et masque (sans les supprimer, cohérent avec le
// reste de l'app — voir /api/admin/categories) les articles déjà récupérés.
export async function DELETE(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
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
      // Filet complémentaire : masque AUSSI les articles de flux perso qui
      // portent encore le LIBELLÉ de cette catégorie mais dont le flux n'est
      // plus (ou pas) dans category.feeds — cas typique : un flux qui a
      // appartenu à cette catégorie puis a été déplacé/supprimé, ses articles
      // gardant l'ancien categoryLabel. Sans ça, "En direct" (groupé par
      // categoryLabel) continuait d'afficher la colonne de la catégorie
      // supprimée avec ces articles-là dedans. Limité aux flux perso
      // ("custom-feed:") : on ne touche jamais aux articles FreshRSS d'une
      // catégorie homonyme. Si un de ces articles appartient en fait à un
      // flux perso encore actif dans une AUTRE catégorie, la passe
      // d'auto-correction du worker (recomputeAllCustomFeedIncluded) le
      // réaffiche au tick suivant avec son BON libellé à jour.
      prisma.article.updateMany({
        where: { categoryLabel: category.label, feedId: { startsWith: "custom-feed:" }, included: true },
        data: { included: false }
      }),
      prisma.customCategory.delete({ where: { id } }) // cascade -> CustomFeed
    ]);

    return NextResponse.json({ ok: true });
  } catch (err: any) {
    console.error("[admin/custom-categories] DELETE failed:", err);
    return NextResponse.json(
      { error: err?.message || "Échec de la suppression de la catégorie" },
      { status: 500 }
    );
  }
}
