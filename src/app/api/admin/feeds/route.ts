import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { listAllFeeds } from "@/lib/freshrss";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Returns every individual feed (subscription) found in FreshRSS, merged
// with which ones the user has explicitly excluded in DailySpoon.
export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const [freshrssFeeds, excluded] = await Promise.all([listAllFeeds(), prisma.excludedFeed.findMany()]);
    const excludedIds = new Set(excluded.map((e) => e.freshrssId));

    const feeds = freshrssFeeds.map((f) => ({
      freshrssId: f.freshrssId,
      title: f.title,
      categoryLabels: f.categoryLabels,
      included: !excludedIds.has(f.freshrssId)
    }));

    return NextResponse.json({ feeds });
  } catch (err: any) {
    console.error("[admin/feeds] failed to load from FreshRSS:", err);
    return NextResponse.json(
      { error: err?.message || "Impossible de contacter FreshRSS" },
      { status: 502 }
    );
  }
}

// Toggle whether a specific feed is included, regardless of its category.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { freshrssId, title, included } = body as {
    freshrssId?: string;
    title?: string;
    included?: boolean;
  };

  if (!freshrssId || typeof included !== "boolean") {
    return NextResponse.json({ error: "freshrssId et included sont requis" }, { status: 400 });
  }

  if (included) {
    await prisma.excludedFeed.deleteMany({ where: { freshrssId } });
  } else {
    await prisma.excludedFeed.upsert({
      where: { freshrssId },
      update: { label: title || freshrssId },
      create: { freshrssId, label: title || freshrssId }
    });
    // "décoché" doit vider le flux partout, pas juste bloquer les futures
    // récupérations — on purge aussi les articles déjà stockés (par feedId
    // si connu, sinon par titre pour les articles fetchés avant ce champ).
    const { count } = await prisma.article.deleteMany({
      where: { OR: [{ feedId: freshrssId }, ...(title ? [{ feedTitle: title }] : [])] }
    });
    if (count > 0) {
      console.log(`[admin/feeds] Removed ${count} existing article(s) for excluded feed "${title || freshrssId}".`);
    }
  }

  return NextResponse.json({ ok: true });
}
