import { NextRequest, NextResponse } from "next/server";
import { generateDailyEdition } from "@/lib/generateEdition";
import { syncCustomFeeds } from "@/lib/customFeeds";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

// Triggered either by:
// 1. The self-hosted worker/cron script, authenticated with CRON_SECRET
// 2. A logged-in admin clicking "Régénérer maintenant" in /admin/feeds
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const hasValidCronSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;

  const sessionToken = req.cookies.get(SESSION_COOKIE)?.value;
  const hasValidAdminSession = await isValidSessionToken(sessionToken);

  if (!hasValidCronSecret && !hasValidAdminSession) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const forceNoAi = body?.noAi === true;

  try {
    // Balayage des flux personnalisés AVANT la génération, pour que leurs
    // nouveaux articles (zéro coût IA, voir customFeeds.ts) fassent partie
    // du même vivier que celui que generateDailyEdition va afficher/traiter
    // — sinon un clic sur "Aspirer les news" ne rafraîchirait pas un flux
    // perso tout juste ajouté, qui devrait sinon attendre le prochain tick
    // du worker (jusqu'à 1mn) ET son propre intervalle de récupération.
    await syncCustomFeeds().catch((err) => {
      console.error("[cron/generate] Synchronisation des flux personnalisés échouée:", err);
    });

    const result = await generateDailyEdition({ forceNoAi });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    console.error("[cron/generate] failed:", err);
    return NextResponse.json({ error: "generation failed" }, { status: 500 });
  }
}
