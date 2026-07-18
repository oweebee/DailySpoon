import { NextRequest, NextResponse } from "next/server";
import Parser from "rss-parser";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { customFeedFreshrssId } from "@/lib/customFeeds";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Ajout d'un flux RSS/Atom sous une catégorie personnalisée. Le titre est
// optionnel côté formulaire : si absent, on tente un parsing rapide (délai
// court, best-effort) pour récupérer le vrai titre du flux plutôt que
// d'afficher l'URL brute — sans bloquer la création si le flux est
// temporairement injoignable (le prochain balayage du worker le
// récupérera de toute façon).
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

export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const categoryId = typeof body.categoryId === "string" ? body.categoryId : "";
  const url = typeof body.url === "string" ? body.url.trim() : "";
  let title = typeof body.title === "string" ? body.title.trim() : "";

  if (!categoryId || !url) {
    return NextResponse.json({ error: "categoryId et url sont requis" }, { status: 400 });
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("protocole invalide");
  } catch {
    return NextResponse.json({ error: "URL de flux invalide" }, { status: 400 });
  }

  const category = await prisma.customCategory.findUnique({ where: { id: categoryId } });
  if (!category) return NextResponse.json({ error: "Catégorie introuvable" }, { status: 404 });

  if (!title) title = await guessFeedTitle(url);

  const feed = await prisma.customFeed.create({
    data: { url, title, categoryId }
  });

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
