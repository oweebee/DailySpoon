import { NextRequest, NextResponse } from "next/server";
import { generateDailyEdition } from "@/lib/generateEdition";
import { syncCustomFeeds } from "@/lib/customFeeds";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { writeLog } from "@/lib/logger";

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
    // du même vivier que celui que generateDailyEdition va afficher/traiter.
    //
    // Forcé (bypass de l'intervalle customFeedsIntervalMinutes) exactement
    // quand forceNoAi l'est aussi — c'est-à-dire pour TOUTE "aspiration sans
    // IA", qu'elle soit déclenchée à la main ("Aspirer les news"/"Régénérer
    // maintenant") OU automatiquement par le worker (aspiration de secours
    // toutes les FALLBACK_INTERVAL_HOURS, ~3h) : dans les deux cas
    // l'utilisateur/le cycle attend un VRAI aller-retour réseau à chaque
    // fois, pas un no-op silencieux parce que l'intervalle des flux perso
    // (réglage séparé) n'est pas encore écoulé. La vraie génération IA
    // quotidienne (forceNoAi=false, une fois par jour) reste gatée
    // normalement — sans enjeu vu sa fréquence.
    await syncCustomFeeds(forceNoAi).catch(async (err) => {
      // Échecs PAR FLUX déjà loggués individuellement dans customFeeds.ts —
      // ce catch-ci ne couvre que l'échec de syncCustomFeeds() lui-même.
      await writeLog(
        "error",
        "worker",
        "Synchronisation des flux personnalisés échouée (déclenchement manuel)",
        (err as Error)?.message
      );
    });

    const result = await generateDailyEdition({ forceNoAi });
    return NextResponse.json({ ok: true, ...result });
  } catch (err) {
    // Filet de secours : couvre tout échec qui surviendrait AVANT le premier
    // writeLog interne de generateDailyEdition (ex. souci DB dès la création
    // de l'Edition) — sans ça, un échec précoce sur un déclenchement manuel
    // ("Aspirer les news"/"Lancer l'impression") ne laissait de trace que
    // dans les logs bruts Coolify, invisible depuis /admin/logs.
    await writeLog(
      "error",
      "worker",
      "Génération échouée (déclenchement manuel)",
      (err as Error)?.message
    );
    return NextResponse.json({ error: "generation failed" }, { status: 500 });
  }
}
