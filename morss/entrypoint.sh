#!/bin/sh
set -e

# Module VPN optionnel pour ce conteneur morss — voir Settings.vpnEnabled
# dans DailySpoon (/admin/settings). Lu UNE SEULE FOIS ici, au démarrage :
# changer le réglage ne prend effet qu'au PROCHAIN démarrage de CE conteneur
# (redémarrer le conteneur morss suffit, pas besoin de tout redéployer).
#
# INTERNAL_API_URL (ex. http://web:3000) et VPN_CONFIG_SECRET (= CRON_SECRET,
# voir docker-compose.yml) doivent être réglés pour que ceci fonctionne. En
# leur absence, ou si l'appel échoue pour une raison quelconque (DailySpoon
# pas encore démarré, secret absent...), on démarre SANS VPN plutôt que de
# bloquer morss : mieux vaut un morss qui marche sans VPN qu'un morss qui ne
# démarre pas du tout à cause d'un souci sur ce point précis.
VPN_ENABLED="false"
OVPN_CONFIG=""

# Petit statut HTTP interne (voir /api/admin/vpn-status côté DailySpoon,
# affiché dans /admin/settings) : un simple fichier JSON servi par
# python3 -m http.server, relu à chaque requête (pas de cache) — pas besoin
# de toucher au code de morss lui-même pour exposer ça.
mkdir -p /tmp/vpn-status
write_status() {
	# $1 = vpnEnabled (true/false), $2 = connected (true/false)
	echo "{\"vpnEnabled\": $1, \"connected\": $2}" > /tmp/vpn-status/status.json
}
write_status "false" "false"
python3 -m http.server 8001 --directory /tmp/vpn-status >/tmp/status-server.log 2>&1 &

# Journal persistant /admin/logs (voir /api/internal/vpn-log côté
# DailySpoon) — en complément du repère visuel status.json ci-dessus,
# demandé explicitement : une coupure VPN en pleine nuit doit laisser une
# trace consultable depuis l'admin, pas seulement dans les logs bruts du
# conteneur (Coolify). Fire-and-forget en tâche de fond (&) : un souci
# réseau ponctuel sur CET appel ne doit jamais bloquer/ralentir le VPN
# lui-même. Best-effort par nature (mêmes identifiants qu'/api/internal/
# vpn-config) : si INTERNAL_API_URL/VPN_CONFIG_SECRET sont absents, ne fait
# simplement rien (curl échoue silencieusement, ignoré).
notify_log() {
	# $1 = "connected" ou "disconnected"
	[ -n "$INTERNAL_API_URL" ] && [ -n "$VPN_CONFIG_SECRET" ] || return 0
	curl -fsS --max-time 5 -X POST \
		-H "Authorization: Bearer ${VPN_CONFIG_SECRET}" \
		-H "Content-Type: application/json" \
		-d "{\"event\":\"$1\"}" \
		"${INTERNAL_API_URL}/api/internal/vpn-log" >/dev/null 2>&1 &
}

if [ -n "$INTERNAL_API_URL" ] && [ -n "$VPN_CONFIG_SECRET" ]; then
	# docker compose démarre tous les services en parallèle, sans garantie
	# d'ordre : "web" peut encore être en train d'appliquer les migrations
	# Prisma (voir docker-entrypoint.sh) au moment où CE conteneur démarre.
	# Une seule tentative ratée ici désactivait le VPN pour TOUTE la durée de
	# vie du conteneur (relu uniquement au démarrage, voir commentaire en
	# tête de fichier) — repéré en usage réel : le VPN retombait à
	# "désactivé" à chaque redéploiement, sans autre solution que de
	# redémarrer le conteneur morss à la main. Nouvelle tentative toutes les
	# 5s pendant 2 minutes max (largement au-delà du temps de boot normal de
	# "web") avant d'abandonner et de démarrer sans VPN.
	RESPONSE=""
	i=0
	while [ $i -lt 24 ]; do
		RESPONSE=$(curl -fsS --max-time 10 \
			-H "Authorization: Bearer ${VPN_CONFIG_SECRET}" \
			"${INTERNAL_API_URL}/api/internal/vpn-config" 2>/dev/null || echo "")
		[ -n "$RESPONSE" ] && break
		i=$((i + 1))
		sleep 5
	done

	if [ -n "$RESPONSE" ]; then
		VPN_ENABLED=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('enabled', False))" 2>/dev/null || echo "false")
		if [ "$VPN_ENABLED" = "True" ]; then
			OVPN_CONFIG=$(echo "$RESPONSE" | python3 -c "import sys, json; print(json.load(sys.stdin).get('ovpnConfig', ''))" 2>/dev/null || echo "")
		fi
	fi
fi

if [ "$VPN_ENABLED" = "True" ] && [ -n "$OVPN_CONFIG" ]; then
	echo "[vpn] Activé — démarrage du tunnel OpenVPN..."
	echo "$OVPN_CONFIG" > /tmp/client.ovpn

	# --redirect-gateway def1 : bascule la route par défaut de CE conteneur
	# vers le tunnel. Sans risque ici (contrairement à un conteneur avec une
	# base de données à protéger, voir la discussion sur DailySpoon
	# elle-même) : morss n'a que deux besoins réseau — être joint par
	# DailySpoon sur le réseau Docker interne (route plus spécifique que la
	# route par défaut, donc jamais affectée par redirect-gateway) et sortir
	# vers les sites qu'il scrape (exactement ce qu'on veut faire passer par
	# le VPN).
	openvpn --config /tmp/client.ovpn \
		--redirect-gateway def1 \
		--daemon \
		--log /tmp/openvpn.log

	# Attend que le tunnel soit réellement monté (interface tun0 avec une IP)
	# avant de lancer morss — sinon morss pourrait démarrer ses toutes
	# premières requêtes avant que la route soit prête. 30 x 1s = 30s max.
	LAST_VPN_STATE="disconnected"
	i=0
	while [ $i -lt 30 ]; do
		if ip addr show tun0 2>/dev/null | grep -q "inet "; then
			echo "[vpn] Tunnel actif (tun0 prêt)."
			write_status "true" "true"
			notify_log "connected"
			LAST_VPN_STATE="connected"
			break
		fi
		i=$((i + 1))
		sleep 1
	done
	if [ $i -eq 30 ]; then
		echo "[vpn] ATTENTION : tun0 toujours pas prêt après 30s — morss démarre quand même (voir /tmp/openvpn.log). Si le VPN ne s'est pas monté, morss fonctionnera normalement, sans VPN."
		write_status "true" "false"
		notify_log "disconnected"
	fi

	# Surveillance en tâche de fond, toutes les 15s — volontairement le
	# contrôle le plus léger possible : une seule commande locale (ip addr
	# show tun0), aucun appel réseau, aucune requête de test vers un site
	# externe. Trois choses à chaque tick :
	#   1. Repère visuel /admin/settings (status.json, comme avant) ;
	#   2. Journal /admin/logs (notify_log), mais UNIQUEMENT sur un
	#      CHANGEMENT d'état (LAST_VPN_STATE) — pas à chaque tick, pour ne
	#      pas noyer le journal d'une ligne toutes les 15s tant que tout va
	#      bien ;
	#   3. Reconnexion automatique DÉCLENCHÉE PAR L'ÉTAT "déconnecté" lui-même
	#      (pas seulement par la disparition du processus openvpn) : demandé
	#      explicitement — dès que le tunnel est constaté tombé DEUX tours de
	#      suite (30s, pour ne pas réagir à un tout petit accroc d'une
	#      seconde), on tue tout processus openvpn restant (au cas où il
	#      serait resté bloqué sans avoir vraiment coupé tun0) et on relance
	#      une connexion fraîche — sans attendre un redémarrage manuel du
	#      conteneur.
	DOWN_TICKS=0
	(
		while true; do
			sleep 15
			if ip addr show tun0 2>/dev/null | grep -q "inet "; then
				CURRENT_STATE="connected"
				DOWN_TICKS=0
			else
				CURRENT_STATE="disconnected"
				DOWN_TICKS=$((DOWN_TICKS + 1))
			fi

			if [ "$CURRENT_STATE" != "$LAST_VPN_STATE" ]; then
				notify_log "$CURRENT_STATE"
				LAST_VPN_STATE="$CURRENT_STATE"
			fi

			if [ "$CURRENT_STATE" = "connected" ]; then
				write_status "true" "true"
			else
				write_status "true" "false"
				if [ "$DOWN_TICKS" -ge 2 ]; then
					echo "[vpn] Tunnel toujours tombé après ${DOWN_TICKS} vérifications — reconnexion forcée..."
					pkill -x openvpn 2>/dev/null || true
					sleep 1
					openvpn --config /tmp/client.ovpn \
						--redirect-gateway def1 \
						--daemon \
						--log /tmp/openvpn.log
					DOWN_TICKS=0
				fi
			fi
		done
	) &
else
	echo "[vpn] Désactivé — morss démarre en direct (comportement normal, sans VPN)."
	write_status "false" "false"
fi

# Repasse en utilisateur non-root (1000:1000, celui du Dockerfile officiel
# morss) avant de lancer morss lui-même — seul le VPN, déjà en tâche de fond,
# a eu besoin des droits root (création de l'interface tun).
exec su-exec 1000:1000 /bin/sh /app/morss-helper "$@"
