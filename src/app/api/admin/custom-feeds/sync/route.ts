import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";
import { syncCustomFeeds } from "@/lib/customFeeds";
import { writeLog } from "@/lib/logger";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Bouton "Forcer la récupération maintenant" dans /admin/categories — appelle
// syncCustomFeeds en CONTOURNANT le gate d'intervalle global
// (customFeedsIntervalMinutes), pour tester/diagnostiquer immédiatement sans
// attendre le prochain tick du worker ni le prochain "Aspirer les news".
// Distinct de /api/cron/generate : celui-ci ne force rien et ne génère
// aucune édition, juste un aller-retour direct sur les flux personnalisés.
export async function POST(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const result = await syncCustomFeeds(true);
    return NextResponse.json({ ok: true, fetched: result.fetched });
  } catch (err: any) {
    // Échecs PAR FLUX déjà loggués individuellement dans customFeeds.ts —
    // ce catch-ci ne couvre que l'échec de syncCustomFeeds() lui-même.
    await writeLog(
      "error",
      "custom-feeds",
      "Récupération forcée échouée (bouton admin)",
      err?.message
    );
    return NextResponse.json(
      { error: err?.message || "Échec de la synchronisation forcée" },
      { status: 500 }
    );
  }
}
