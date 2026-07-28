# Morss (pictuga/morss), intégré au même docker-compose que DailySpoon plutôt
# que géré comme une app Coolify séparée. Cloné depuis GitHub À CHAQUE build
# (pas de version figée) pour rester à jour tout seul à chaque redéploiement
# — comme demandé, pas besoin de suivre les releases de morss à la main.
#
# Ajout par rapport au Dockerfile officiel de morss : un tunnel OpenVPN
# OPTIONNEL, pour que morss aille chercher les flux/articles depuis une autre
# IP que celle du serveur (utile si celle-ci se retrouve bloquée par un site
# source — voir entrypoint.sh et Settings.vpnEnabled côté DailySpoon,
# /admin/settings). Désactivé par défaut : sans réglage, ce conteneur se
# comporte exactement comme le morss d'origine.
FROM alpine:edge

RUN apk add --no-cache git && \
    git clone --depth 1 https://github.com/pictuga/morss.git /app && \
    rm -rf /app/.git

RUN set -ex; \
	apk add --no-cache --virtual .run-deps python3 py3-lxml py3-setproctitle py3-setuptools; \
	apk add --no-cache --virtual .build-deps py3-pip py3-wheel; \
	pip3 install --no-cache-dir --break-system-packages /app[full] legacy-cgi; \
	apk del .build-deps

# openvpn : le client VPN optionnel. curl : pour interroger
# /api/internal/vpn-config au démarrage. iproute2 : pour vérifier que le
# tunnel (tun0) est bien monté avant de lancer morss. su-exec : pour repasser
# en utilisateur non-root (1000:1000, celui du Dockerfile officiel morss)
# avant de lancer morss — seul le VPN (qui a besoin des droits root pour
# créer l'interface tun) tourne en root.
RUN apk add --no-cache openvpn curl iproute2 su-exec

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# Pas de USER ici (contrairement à l'image officielle) : root par défaut,
# nécessaire pour monter le tunnel OpenVPN — entrypoint.sh repasse en
# utilisateur 1000:1000 avant de lancer morss lui-même, VPN activé ou non.
ENTRYPOINT ["/entrypoint.sh"]
CMD ["run"]

HEALTHCHECK CMD /bin/sh /app/morss-helper check
