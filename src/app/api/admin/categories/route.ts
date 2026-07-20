import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listAllCategories, renameCategory } from "@/lib/freshrss";
import { recomputeIncludedForFreshrssCategory } from "@/lib/customFeeds";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Returns every category/label found in FreshRSS, merged with which ones
// are currently selected in DailySpoon (En Direct) ET avec le réglage
// "Impression IA" (AiPrintCategory) — les deux sont désormais des flags
// totalement indépendants : une catégorie peut être décochée pour En Direct
// et quand même incluse dans l'impression IA, ou l'inverse.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [freshrssCategories, selected, aiPrintCategories, disabledCustomFeedsCategories] = await Promise.all([
      listAllCategories(),
      prisma.selectedCategory.findMany(),
      prisma.aiPrintCategory.findMany(),
      prisma.disabledCustomFeedsCategory.findMany()
    ]);
    const selectedIds = new Set(selected.map((s) => s.freshrssId));
    const orderById = new Map(selected.map((s) => [s.freshrssId, s.order]));
    const frontPageEnabledById = new Map(aiPrintCategories.map((c) => [c.freshrssId, c.enabled]));
    const disabledCustomFeedsIds = new Set(disabledCustomFeedsCategories.map((d) => d.freshrssCategoryId));

    // Catégories sélectionnées d'abord, dans l'ordre choisi dans
    // /admin/categories (persisté en base) ; le reste ensuite, par ordre
    // alphabétique.
    const categories = freshrssCategories
      .map((c) => ({
        freshrssId: c.freshrssId,
        label: c.label,
        selected: selectedIds.has(c.freshrssId),
        order: orderById.get(c.freshrssId) ?? null,
        frontPageEnabled: frontPageEnabledById.get(c.freshrssId) ?? true,
        // Bascule groupée pour les flux personnalisés rattachés à cette
        // catégorie (voir DisabledCustomFeedsCategory) — sans effet sur les
        // vrais flux FreshRSS de la catégorie. true = activé par défaut.
        customFeedsEnabled: !disabledCustomFeedsIds.has(c.freshrssId)
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

// Renomme une catégorie FreshRSS (nécessite FreshRSS activé, voir
// Settings.freshrssEnabled — renameCategory/config() lèvent sinon). Côté
// FreshRSS, l'id de la catégorie ENCODE son libellé : renommer change donc
// aussi l'id (voir renameCategory dans freshrss.ts), ce qui rendrait TOUTES
// les références locales à l'ancien id orphelines (SelectedCategory,
// AiPrintCategory, DisabledCustomFeedsCategory, CustomFeed.freshrssCategoryId)
// — exactement le bug déjà rencontré sur une catégorie personnalisée
// supprimée. On répercute donc explicitement l'ancien -> nouvel id/libellé
// partout, y compris sur les articles déjà ingérés (categoryLabel), pour
// qu'aucune colonne fantôme n'apparaisse dans En direct/l'impression IA.
export async function PATCH(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const freshrssId = typeof body.freshrssId === "string" ? body.freshrssId : "";
  const newLabel = typeof body.newLabel === "string" ? body.newLabel.trim() : "";
  const oldLabel = typeof body.oldLabel === "string" ? body.oldLabel : "";

  if (!freshrssId || !newLabel) {
    return NextResponse.json({ error: "freshrssId et newLabel sont requis" }, { status: 400 });
  }
  if (newLabel === oldLabel) return NextResponse.json({ ok: true, newFreshrssId: freshrssId });

  try {
    const { newFreshrssId } = await renameCategory(freshrssId, newLabel);

    await prisma.$transaction([
      prisma.selectedCategory.updateMany({
        where: { freshrssId },
        data: { freshrssId: newFreshrssId, label: newLabel }
      }),
      prisma.aiPrintCategory.updateMany({
        where: { freshrssId },
        data: { freshrssId: newFreshrssId, label: newLabel }
      }),
      prisma.disabledCustomFeedsCategory.updateMany({
        where: { freshrssCategoryId: freshrssId },
        data: { freshrssCategoryId: newFreshrssId, label: newLabel }
      }),
      prisma.customFeed.updateMany({
        where: { freshrssCategoryId: freshrssId },
        data: { freshrssCategoryId: newFreshrssId, freshrssCategoryLabel: newLabel }
      }),
      ...(oldLabel
        ? [prisma.article.updateMany({ where: { categoryLabel: oldLabel }, data: { categoryLabel: newLabel } })]
        : [])
    ]);

    return NextResponse.json({ ok: true, newFreshrssId });
  } catch (err: any) {
    console.error("[admin/categories] rename failed:", err);
    return NextResponse.json({ error: err?.message || "Échec du renommage" }, { status: 500 });
  }
}

// Toggle whether a category is included in the daily edition.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { freshrssId, label, selected, frontPageEnabled, customFeedsEnabled } = body as {
    freshrssId?: string;
    label?: string;
    selected?: boolean;
    frontPageEnabled?: boolean;
    customFeedsEnabled?: boolean;
  };

  if (!freshrssId || !label) {
    return NextResponse.json({ error: "freshrssId et label sont requis" }, { status: 400 });
  }

  // Bascule dédiée à la carte "Impression IA" : totalement indépendante de
  // la sélection En Direct — upsert dans AiPrintCategory, qui fonctionne
  // pour N'IMPORTE QUELLE catégorie FreshRSS, sélectionnée ou non.
  if (typeof frontPageEnabled === "boolean" && typeof selected !== "boolean") {
    await prisma.aiPrintCategory.upsert({
      where: { freshrssId },
      update: { label, enabled: frontPageEnabled },
      create: { freshrssId, label, enabled: frontPageEnabled }
    });
    return NextResponse.json({ ok: true });
  }

  // Bascule GROUPÉE des flux personnalisés rattachés à cette catégorie
  // (voir DisabledCustomFeedsCategory) : n'écrase JAMAIS les cases
  // individuelles "inclure le flux" de chacun (ExcludedFeed intact) — juste
  // un interrupteur en plus, recalculé proprement via
  // recomputeIncludedForFreshrssCategory. Sans effet sur la catégorie
  // FreshRSS elle-même ni ses vrais flux.
  if (typeof customFeedsEnabled === "boolean" && typeof selected !== "boolean" && typeof frontPageEnabled !== "boolean") {
    if (customFeedsEnabled) {
      await prisma.disabledCustomFeedsCategory.deleteMany({ where: { freshrssCategoryId: freshrssId } });
    } else {
      await prisma.disabledCustomFeedsCategory.upsert({
        where: { freshrssCategoryId: freshrssId },
        update: { label },
        create: { freshrssCategoryId: freshrssId, label }
      });
    }
    await recomputeIncludedForFreshrssCategory(freshrssId);
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

    // Le updateMany ci-dessus vient de tout remettre included=true pour
    // cette catégorie, y COMPRIS les articles des flux personnalisés qui y
    // sont rattachés (même categoryLabel) — sans distinguer la bascule
    // groupée DisabledCustomFeedsCategory. On corrige juste après pour ces
    // flux perso précisément, sans retoucher aux vrais flux FreshRSS.
    await recomputeIncludedForFreshrssCategory(freshrssId);
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
