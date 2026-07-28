import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, isValidSessionToken } from "@/lib/auth";

async function assertAuthed(req: NextRequest) {
  const token = req.cookies.get(SESSION_COOKIE)?.value;
  return isValidSessionToken(token);
}

// Repère visuel du VPN dans /admin/settings : interroge le petit statut
// HTTP exposé par le conteneur morss (voir morss/entrypoint.sh,
// python3 -m http.server sur le port 8001) depuis le serveur DailySpoon
// (le navigateur admin ne peut pas résoudre "morss" — c'est un nom
// uniquement valable sur le réseau Docker interne). Best-effort : si morss
// est injoignable (pas encore redéployé avec ce module, en cours de
// redémarrage...), on renvoie un statut "injoignable" plutôt que de planter
// la page réglages.
const MORSS_STATUS_URL = process.env.MORSS_STATUS_URL || "http://morss:8001/status.json";

export async function GET(req: NextRequest) {
  if (!(await assertAuthed(req))) return NextResponse.json({ error: "unauthorized" }, { status: 401 });

  try {
    const res = await fetch(MORSS_STATUS_URL, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      return NextResponse.json({ reachable: false, vpnEnabled: false, connected: false });
    }
    const data: any = await res.json().catch(() => ({}));
    return NextResponse.json({
      reachable: true,
      vpnEnabled: data?.vpnEnabled === true,
      connected: data?.connected === true
    });
  } catch {
    return NextResponse.json({ reachable: false, vpnEnabled: false, connected: false });
  }
}
