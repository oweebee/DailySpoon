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
    const [freshrssFeeds, excluded, medaled] = await Promise.all([
      listAllFeeds(),
      prisma.excludedFeed.findMany(),
      prisma.medalFeed.findMany()
    ]);
    const excludedIds = new Set(excluded.map((e) => e.freshrssId));
    const medaledIds = new Set(medaled.map((m) => m.freshrssId));

    const feeds = freshrssFeeds.map((f) => ({
      freshrssId: f.freshrssId,
      title: f.title,
      categoryLabels: f.categoryLabels,
      included: !excludedIds.has(f.freshrssId),
      medal: medaledIds.has(f.freshrssId)
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

// Toggle whether a specific feed is included, regardless of its category,
// and/or whether it carries la "médaille" (badge sur les photos + éligible
// aux 3 emplacements "à la une"). Les deux réglages sont indépendants : une
// requête peut ne toucher que l'un des deux.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { freshrssId, title, included, medal } = body as {
    freshrssId?: string;
    title?: string;
    included?: boolean;
    medal?: boolean;
  };

  if (!freshrssId || (typeof included !== "boolean" && typeof medal !== "boolean")) {
    return NextResponse.json({ error: "freshrssId et (included ou medal) sont requis" }, { status: 400 });
  }

  if (typeof included === "boolean") {
    const matchArticles = { OR: [{ feedId: freshrssId }, ...(title ? [{ feedId: null, feedTitle: title }] : [])] };

    if (included) {
      await prisma.excludedFeed.deleteMany({ where: { freshrssId } });
    } else {
      await prisma.excludedFeed.upsert({
        where: { freshrssId },
        update: { label: title || freshrssId },
        create: { freshrssId, label: title || freshrssId }
      });
    }

    // "décoché" ne purge plus les articles : ils restent en base pour rester
    // trouvables par la recherche, mais disparaissent des vues normales via
    // le flag included (jamais réanalysés par l'IA tant qu'ils restent
    // exclus). "recoché" les fait réapparaître avec leur contenu déjà stocké.
    const { count } = await prisma.article.updateMany({
      where: matchArticles,
      data: { included }
    });
    if (count > 0) {
      console.log(
        `[admin/feeds] ${count} article(s) ${included ? "réinclus" : "exclus"} pour le flux "${title || freshrssId}".`
      );
    }
  }

  if (typeof medal === "boolean") {
    if (medal) {
      await prisma.medalFeed.upsert({
        where: { freshrssId },
        update: { label: title || freshrssId },
        create: { freshrssId, label: title || freshrssId }
      });
    } else {
      await prisma.medalFeed.deleteMany({ where: { freshrssId } });
    }
    // Reflète immédiatement le réglage sur les articles déjà en base de ce
    // flux, sans attendre la prochaine génération. Certains articles plus
    // anciens n'ont pas de feedId enregistré (champ ajouté après coup) — on
    // les rattrape par titre de flux, comme pour l'exclusion de flux.
    await prisma.article.updateMany({
      where: { OR: [{ feedId: freshrssId }, ...(title ? [{ feedId: null, feedTitle: title }] : [])] },
      data: { medal }
    });
  }

  return NextResponse.json({ ok: true });
}
