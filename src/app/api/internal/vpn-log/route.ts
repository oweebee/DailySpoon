import { NextRequest, NextResponse } from "next/server";
import { writeLog } from "@/lib/logger";

// Appelé par morss/entrypoint.sh (notify_log) à chaque changement d'état du
// tunnel VPN (connexion initiale, perte, reconnexion) — journalise ça dans
// /admin/logs, en plus du repère visuel status.json déjà exposé par morss
// lui-même (voir /api/admin/vpn-status). Demandé explicitement : une coupure
// VPN doit laisser une trace consultable depuis l'admin, pas seulement dans
// les logs bruts du conteneur (Coolify).
//
// Même mécanisme d'auth que /api/internal/vpn-config (pas de cookie
// navigateur possible depuis un conteneur) : secret partagé CRON_SECRET en
// "Authorization: Bearer <secret>".
export async function POST(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const hasValidSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!hasValidSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const body = await req.json().catch(() => ({}));
  const event = body?.event === "connected" || body?.event === "disconnected" ? body.event : null;
  if (!event) {
    return NextResponse.json({ error: "event invalide (attendu: connected | disconnected)" }, { status: 400 });
  }

  await writeLog(
    event === "connected" ? "info" : "warn",
    "vpn",
    event === "connected" ? "VPN morss : tunnel connecté" : "VPN morss : tunnel déconnecté"
  );

  return NextResponse.json({ ok: true });
}
