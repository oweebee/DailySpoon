-- Module VPN optionnel pour le conteneur morss intégré (voir docker-compose
-- "morss" et morss/entrypoint.sh). vpnEnabled : interrupteur explicite,
-- décoché par défaut (même logique que freshrssEnabled). vpnOvpnConfig :
-- contenu brut du fichier .ovpn collé depuis /admin/settings.
ALTER TABLE "Settings" ADD COLUMN "vpnEnabled" BOOLEAN;
ALTER TABLE "Settings" ADD COLUMN "vpnOvpnConfig" TEXT;
