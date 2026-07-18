import { NextRequest, NextResponse } from "next/server";
import Parser from "rss-parser";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { customFeedFreshrssId, createCustomCategoryRecord, resolveFeedCategory } from "@/lib/customFeeds";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Ajout d'un flux RSS/Atom. Le titre est optionnel côté formulaire : si
// absent, on tente un parsing rapide (délai court, best-effort) pour
// récupérer le vrai titre du flux plutôt que d'afficher l'URL brute — sans
// bloquer la création si le flux est temporairement injoignable (le
// prochain balayage du worker le récupérera de toute façon).
async function guessFeedTitle(url: string): Promise<string> {
  try {
    const parser = new Parser({ timeout: 6000 });
    const parsed = await parser.parseURL(url);
    if (parsed.title?.trim()) return parsed.title.trim();
  } catch {
    // best-effort : on retombe sur l'hôte de l'URL ci-dessous
  }
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

type CategoryChoice = {
  customCategoryId?: string;
  freshrssCategoryId?: string;
  freshrssCategoryLabel?: string;
  newCategoryLabel?: string;
};

// Résout le "où ranger ce flux" à partir du formulaire : soit une catégorie
// personnalisée déjà existante, soit une vraie catégorie FreshRSS existante
// (copiée telle quelle, id + libellé, pas de table locale pour FreshRSS),
// soit la création à la volée d'une nouvelle catégorie personnalisée.
// Exactement un des trois doit être fourni.
async function resolveCategoryChoice(
  choice: CategoryChoice
): Promise<
  | { ok: true; customCategoryId: string | null; freshrssCategoryId: string | null; freshrssCategoryLabel: string | null }
  | { ok: false; error: string }
> {
  const newLabel = choice.newCategoryLabel?.trim();
  if (newLabel) {
    const category = await createCustomCategoryRecord(newLabel);
    return { ok: true, customCategoryId: category.id, freshrssCategoryId: null, freshrssCategoryLabel: null };
  }

  if (choice.customCategoryId) {
    const category = await prisma.customCategory.findUnique({ where: { id: choice.customCategoryId } });
    if (!category) return { ok: false, error: "Catégorie personnalisée introuvable" };
    return { ok: true, customCategoryId: category.id, freshrssCategoryId: null, freshrssCategoryLabel: null };
  }

  if (choice.freshrssCategoryId && choice.freshrssCategoryLabel) {
    return {
      ok: true,
      customCategoryId: null,
      freshrssCategoryId: choice.freshrssCategoryId,
      freshrssCategoryLabel: choice.freshrssCategoryLabel
    };
  }

  return { ok: false, error: "Catégorie requise (personnalisée, FreshRSS existante, ou nouvelle catégorie)" };
}

function validateUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// Liste à plat de TOUS les flux personnalisés (quelle que soit leur
// catégorie — perso ou FreshRSS existante), avec leur catégorie résolue
// pour affichage — utilisé par la section "Flux personnalisés" de
// /admin/categories (liste + édition), primaire par rapport à la gestion
// des catégories personnalisées elles-mêmes.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const [rows, excluded, medaled] = await Promise.all([
    prisma.customFeed.findMany({ include: { customCategory: true }, orderBy: { createdAt: "asc" } }),
    prisma.excludedFeed.findMany(),
    prisma.medalFeed.findMany()
  ]);
  const excludedIds = new Set(excluded.map((e) => e.freshrssId));
  const medaledIds = new Set(medaled.map((m) => m.freshrssId));

  const feeds = rows.map((feed) => {
    const feedFreshrssId = customFeedFreshrssId(feed.id);
    const { categoryLabel, isFreshrssCategory } = resolveFeedCategory(feed);
    return {
      id: feed.id,
      url: feed.url,
      title: feed.title,
      included: !excludedIds.has(feedFreshrssId),
      medal: medaledIds.has(feedFreshrssId),
      lastFetchedAt: feed.lastFetchedAt,
      customCategoryId: feed.customCategoryId,
      freshrssCategoryId: feed.freshrssCategoryId,
      freshrssCategoryLabel: feed.freshrssCategoryLabel,
      categoryLabel,
      isFreshrssCategory
    };
  });

  return NextResponse.json({ feeds });
}

export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const url = typeof body.url === "string" ? body.url.trim() : "";
  let title = typeof body.title === "string" ? body.title.trim() : "";

  if (!url) return NextResponse.json({ error: "url requise" }, { status: 400 });
  if (!validateUrl(url)) return NextResponse.json({ error: "URL de flux invalide" }, { status: 400 });

  const resolved = await resolveCategoryChoice({
    customCategoryId: typeof body.customCategoryId === "string" ? body.customCategoryId : undefined,
    freshrssCategoryId: typeof body.freshrssCategoryId === "string" ? body.freshrssCategoryId : undefined,
    freshrssCategoryLabel: typeof body.freshrssCategoryLabel === "string" ? body.freshrssCategoryLabel : undefined,
    newCategoryLabel: typeof body.newCategoryLabel === "string" ? body.newCategoryLabel : undefined
  });
  if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });

  if (!title) title = await guessFeedTitle(url);

  const feed = await prisma.customFeed.create({
    data: {
      url,
      title,
      customCategoryId: resolved.customCategoryId,
      freshrssCategoryId: resolved.freshrssCategoryId,
      freshrssCategoryLabel: resolved.freshrssCategoryLabel
    }
  });

  return NextResponse.json({ feed: { id: feed.id, url: feed.url, title: feed.title } });
}

// Édition d'un flux existant : URL, titre et/ou catégorie de destination
// (même résolution à trois voies que POST). Les champs omis sont laissés
// tels quels ; pour changer la catégorie, fournir le nouveau choix complet
// (customCategoryId OU freshrssCategoryId+Label OU newCategoryLabel).
export async function PATCH(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

  const existing = await prisma.customFeed.findUnique({ where: { id } });
  if (!existing) return NextResponse.json({ error: "Flux introuvable" }, { status: 404 });

  const data: Record<string, unknown> = {};

  if (typeof body.url === "string" && body.url.trim()) {
    const url = body.url.trim();
    if (!validateUrl(url)) return NextResponse.json({ error: "URL de flux invalide" }, { status: 400 });
    data.url = url;
  }
  if (typeof body.title === "string" && body.title.trim()) {
    data.title = body.title.trim();
  }

  const hasCategoryChoice =
    typeof body.customCategoryId === "string" ||
    (typeof body.freshrssCategoryId === "string" && typeof body.freshrssCategoryLabel === "string") ||
    (typeof body.newCategoryLabel === "string" && body.newCategoryLabel.trim());

  if (hasCategoryChoice) {
    const resolved = await resolveCategoryChoice({
      customCategoryId: typeof body.customCategoryId === "string" ? body.customCategoryId : undefined,
      freshrssCategoryId: typeof body.freshrssCategoryId === "string" ? body.freshrssCategoryId : undefined,
      freshrssCategoryLabel: typeof body.freshrssCategoryLabel === "string" ? body.freshrssCategoryLabel : undefined,
      newCategoryLabel: typeof body.newCategoryLabel === "string" ? body.newCategoryLabel : undefined
    });
    if (!resolved.ok) return NextResponse.json({ error: resolved.error }, { status: 400 });
    data.customCategoryId = resolved.customCategoryId;
    data.freshrssCategoryId = resolved.freshrssCategoryId;
    data.freshrssCategoryLabel = resolved.freshrssCategoryLabel;
  }

  const feed = await prisma.customFeed.update({ where: { id }, data });
  return NextResponse.json({ feed: { id: feed.id, url: feed.url, title: feed.title } });
}

// Supprime un flux personnalisé : nettoie ExcludedFeed/MedalFeed pour son id
// synthétique, masque ses articles déjà récupérés (cohérent avec le reste
// de l'app), puis supprime la ligne CustomFeed.
export async function DELETE(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const id = typeof body.id === "string" ? body.id : "";
  if (!id) return NextResponse.json({ error: "id requis" }, { status: 400 });

  const feed = await prisma.customFeed.findUnique({ where: { id } });
  if (!feed) return NextResponse.json({ error: "Flux introuvable" }, { status: 404 });

  const feedFreshrssId = customFeedFreshrssId(id);

  await prisma.$transaction([
    prisma.excludedFeed.deleteMany({ where: { freshrssId: feedFreshrssId } }),
    prisma.medalFeed.deleteMany({ where: { freshrssId: feedFreshrssId } }),
    prisma.article.updateMany({ where: { feedId: feedFreshrssId }, data: { included: false } }),
    prisma.customFeed.delete({ where: { id } })
  ]);

  return NextResponse.json({ ok: true });
}
