import { NextRequest, NextResponse } from "next/server";
import { getSettings } from "@/lib/settings";

// Lu UNE SEULE FOIS au démarrage par morss/entrypoint.sh (conteneur morss
// intégré, voir docker-compose "morss") pour savoir s'il doit monter son
// tunnel OpenVPN. Volontairement pas de auth par session admin (morss n'a pas
// de cookie navigateur) : même mécanisme que /api/cron/generate, un secret
// partagé via variable d'environnement (CRON_SECRET, déjà utilisé pour le
// worker) transmis en "Authorization: Bearer <secret>".
//
// Pas de live-reload : un changement de réglage ici (activer/désactiver le
// VPN, changer le fichier .ovpn) ne prend effet qu'au PROCHAIN démarrage du
// conteneur morss — redémarrer le conteneur suffit (pas besoin de tout
// redéployer), voir le commentaire sur Settings.vpnEnabled dans schema.prisma.
export async function GET(req: NextRequest) {
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = req.headers.get("authorization");
  const hasValidSecret = cronSecret && authHeader === `Bearer ${cronSecret}`;

  if (!hasValidSecret) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const settings = await getSettings();
  return NextResponse.json({
    enabled: settings.vpnEnabled && Boolean(settings.vpnOvpnConfig.trim()),
    ovpnConfig: settings.vpnEnabled ? settings.vpnOvpnConfig : ""
  });
}
