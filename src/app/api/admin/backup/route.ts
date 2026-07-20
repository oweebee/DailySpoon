import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Export/import de TOUTE la configuration (réglages + catégories + flux +
// options par flux) — PAS les articles/éditions (voir /admin/settings,
// bouton "Exporter"/"Importer"), volontairement, pour rester un fichier de
// config léger et rejouable, pas une sauvegarde complète de la base.
//
// Contient les secrets (mot de passe FreshRSS, clés IA, jeton Telegram) tels
// quels — c'est un backup destiné à être réimporté sur CETTE même instance
// (ou une instance de secours), pas partagé : averti côté UI.
const VERSION = 1;

export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [
      settingsRow,
      selectedCategories,
      aiPrintCategories,
      disabledCustomFeedsCategories,
      excludedFeeds,
      medalFeeds,
      notifyFeeds,
      customCategories,
      customFeeds
    ] = await Promise.all([
      prisma.settings.findUnique({ where: { id: "singleton" } }),
      prisma.selectedCategory.findMany(),
      prisma.aiPrintCategory.findMany(),
      prisma.disabledCustomFeedsCategory.findMany(),
      prisma.excludedFeed.findMany(),
      prisma.medalFeed.findMany(),
      prisma.notifyFeed.findMany(),
      prisma.customCategory.findMany(),
      // lastFetchedAt/lastFetchError volontairement omis : état d'exécution,
      // pas de la config — un import ne doit pas faire croire qu'un flux
      // vient d'être récupéré ou est en échec alors que rien n'a encore
      // tourné sur l'instance de destination.
      prisma.customFeed.findMany({
        select: {
          id: true,
          url: true,
          title: true,
          customCategoryId: true,
          freshrssCategoryId: true,
          freshrssCategoryLabel: true,
          createdAt: true
        }
      })
    ]);

    // id/updatedAt exclus : id est toujours "singleton" (recréé tel quel à
    // l'import), updatedAt n'a pas de sens à rejouer.
    const { id: _id, updatedAt: _updatedAt, ...settings } = settingsRow ?? {};

    const payload = {
      version: VERSION,
      exportedAt: new Date().toISOString(),
      settings,
      selectedCategories,
      aiPrintCategories,
      disabledCustomFeedsCategories,
      excludedFeeds,
      medalFeeds,
      notifyFeeds,
      customCategories,
      customFeeds
    };

    return NextResponse.json(payload);
  } catch (err: any) {
    console.error("[admin/backup] export failed:", err);
    return NextResponse.json({ error: err?.message || "Échec de l'export" }, { status: 500 });
  }
}

// Réimporte un export produit par GET ci-dessus. Toujours en FUSION (upsert),
// jamais en remplacement destructeur : rien n'est supprimé côté catégories/
// flux/options qui existeraient déjà mais pas dans le fichier importé — un
// import partiel ou plus ancien ne peut donc jamais effacer accidentellement
// une config plus récente, seulement la compléter/écraser champ par champ.
// Ordre important : CustomCategory AVANT CustomFeed (FK réelle,
// customCategoryId -> CustomCategory.id).
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const body = await req.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return NextResponse.json({ error: "Fichier de sauvegarde invalide" }, { status: 400 });
    }

    const {
      settings,
      selectedCategories = [],
      aiPrintCategories = [],
      disabledCustomFeedsCategories = [],
      excludedFeeds = [],
      medalFeeds = [],
      notifyFeeds = [],
      customCategories = [],
      customFeeds = []
    } = body as Record<string, any>;

    if (settings && typeof settings === "object") {
      await prisma.settings.upsert({
        where: { id: "singleton" },
        update: settings,
        create: { id: "singleton", ...settings }
      });
    }

    for (const cat of customCategories) {
      if (!cat?.id || !cat?.label) continue;
      await prisma.customCategory.upsert({
        where: { id: cat.id },
        update: { label: cat.label, order: cat.order ?? 0 },
        create: { id: cat.id, label: cat.label, order: cat.order ?? 0 }
      });
    }

    for (const feed of customFeeds) {
      if (!feed?.id || !feed?.url || !feed?.title) continue;
      const data = {
        url: feed.url,
        title: feed.title,
        customCategoryId: feed.customCategoryId ?? null,
        freshrssCategoryId: feed.freshrssCategoryId ?? null,
        freshrssCategoryLabel: feed.freshrssCategoryLabel ?? null
      };
      await prisma.customFeed.upsert({
        where: { id: feed.id },
        update: data,
        create: { id: feed.id, ...data }
      });
    }

    for (const row of selectedCategories) {
      if (!row?.freshrssId || !row?.label) continue;
      await prisma.selectedCategory.upsert({
        where: { freshrssId: row.freshrssId },
        update: { label: row.label, order: row.order ?? 0 },
        create: { freshrssId: row.freshrssId, label: row.label, order: row.order ?? 0 }
      });
    }

    for (const row of aiPrintCategories) {
      if (!row?.freshrssId || !row?.label) continue;
      await prisma.aiPrintCategory.upsert({
        where: { freshrssId: row.freshrssId },
        update: { label: row.label, enabled: row.enabled ?? true },
        create: { freshrssId: row.freshrssId, label: row.label, enabled: row.enabled ?? true }
      });
    }

    for (const row of disabledCustomFeedsCategories) {
      if (!row?.freshrssCategoryId || !row?.label) continue;
      await prisma.disabledCustomFeedsCategory.upsert({
        where: { freshrssCategoryId: row.freshrssCategoryId },
        update: { label: row.label },
        create: { freshrssCategoryId: row.freshrssCategoryId, label: row.label }
      });
    }

    // Trois modèles à la forme identique (freshrssId/label) : boucles
    // séparées plutôt qu'une boucle générique sur les délégués Prisma, dont
    // les types d'upsert ne s'unifient pas proprement (chaque modèle a son
    // propre type d'arguments).
    for (const row of excludedFeeds) {
      if (!row?.freshrssId || !row?.label) continue;
      await prisma.excludedFeed.upsert({
        where: { freshrssId: row.freshrssId },
        update: { label: row.label },
        create: { freshrssId: row.freshrssId, label: row.label }
      });
    }
    for (const row of medalFeeds) {
      if (!row?.freshrssId || !row?.label) continue;
      await prisma.medalFeed.upsert({
        where: { freshrssId: row.freshrssId },
        update: { label: row.label },
        create: { freshrssId: row.freshrssId, label: row.label }
      });
    }
    for (const row of notifyFeeds) {
      if (!row?.freshrssId || !row?.label) continue;
      await prisma.notifyFeed.upsert({
        where: { freshrssId: row.freshrssId },
        update: { label: row.label },
        create: { freshrssId: row.freshrssId, label: row.label }
      });
    }

    return NextResponse.json({
      ok: true,
      imported: {
        customCategories: customCategories.length,
        customFeeds: customFeeds.length,
        selectedCategories: selectedCategories.length,
        aiPrintCategories: aiPrintCategories.length,
        disabledCustomFeedsCategories: disabledCustomFeedsCategories.length,
        excludedFeeds: excludedFeeds.length,
        medalFeeds: medalFeeds.length,
        notifyFeeds: notifyFeeds.length
      }
    });
  } catch (err: any) {
    console.error("[admin/backup] import failed:", err);
    return NextResponse.json({ error: err?.message || "Échec de l'import" }, { status: 500 });
  }
}
