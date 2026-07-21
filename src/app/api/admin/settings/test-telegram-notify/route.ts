import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { prisma } from "@/lib/prisma";
import { buildTelegramCaption, postTelegramPhoto } from "@/lib/telegramNotify";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Contrairement à /api/admin/settings/test (qui ne fait que getMe/getChat,
// sans effet de bord), cet endpoint envoie de VRAIS messages Telegram : la
// dernière news déjà en base de CHAQUE flux coché « notification »
// (NotifyFeed), avec la mise en forme réelle (photo + légende) — pour
// vérifier le rendu sans attendre qu'un nouvel article arrive. Teste les
// valeurs du FORMULAIRE (pas forcément déjà enregistrées), comme le reste de
// /admin/settings.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  const body = await req.json().catch(() => ({}));
  const { telegramBotToken, telegramChatId } = body as { telegramBotToken?: string; telegramChatId?: string };

  if (!telegramBotToken || !telegramChatId) {
    return NextResponse.json({ error: "Jeton du bot et id du chat requis." }, { status: 400 });
  }

  const notifyFeeds = await prisma.notifyFeed.findMany();
  if (notifyFeeds.length === 0) {
    return NextResponse.json({ error: "Aucun flux coché « notification » dans /admin/categories pour l'instant." }, { status: 400 });
  }

  const results: { label: string; ok: boolean; message: string }[] = [];

  for (const feed of notifyFeeds) {
    const latest = await prisma.article.findFirst({
      where: { OR: [{ feedId: feed.freshrssId }, { feedId: null, feedTitle: feed.label }] },
      orderBy: { publishedAt: "desc" }
    });

    if (!latest) {
      results.push({ label: feed.label, ok: false, message: "Aucun article en base pour ce flux pour l'instant." });
      continue;
    }

    const caption = buildTelegramCaption({
      title: latest.sourceTitle,
      excerpt: latest.sourceExcerpt,
      link: latest.sourceUrl
    });
    const sendResult = await postTelegramPhoto(telegramBotToken, telegramChatId, caption);
    results.push({ label: feed.label, ok: sendResult.ok, message: sendResult.message });
  }

  return NextResponse.json({ results });
}
