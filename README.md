# DailySpoon

Ton journal personnel quotidien, généré automatiquement à partir des flux que tu suis déjà dans
FreshRSS.

Chaque jour, DailySpoon récupère les articles des catégories FreshRSS que tu as choisies, fait
réécrire/résumer/classer/prioriser les articles par une IA, et publie une édition unique (façon
une de journal) avec archives consultables par date.

## Stack

- Next.js 14 (App Router) + Tailwind — front + API routes
- Prisma + PostgreSQL — data (articles, éditions, catégories sélectionnées)
- FreshRSS (API Google Reader) — source des articles ; la gestion des flux eux-mêmes
  (ajout/suppression/organisation) reste entièrement dans FreshRSS, pas dans DailySpoon
- Anthropic Claude (optionnel) — réécriture/résumé/classement/priorisation des articles
- Un petit worker Node (`node-cron`) pour la génération quotidienne — pas besoin de Vercel Cron,
  tout tourne dans tes propres conteneurs Docker
- Docker + docker-compose — pensé pour un déploiement Coolify sur ton propre serveur (RDS externe)

## Structure

```
src/app/            pages (édition du jour, archives, admin)
src/lib/            logique métier (client FreshRSS, IA, génération d'édition, auth)
worker/             scheduler quotidien (cron) + script one-shot
prisma/             schéma + migrations
Dockerfile           image unique (web + worker via CMD)
docker-compose.yml   services web / worker
```

## 1. Activer l'API sur ton FreshRSS

Dans FreshRSS : Paramètres > Profil > section API, active l'accès API et note (ou définis) un mot
de passe API — pas forcément le même que ton mot de passe de connexion normal.

## 2. Configurer les variables d'environnement

Copie `.env.example` vers `.env` et remplis :

- `DATABASE_URL` — connexion vers ton Postgres (ta RDS)
- `FRESHRSS_BASE_URL` — URL de ton instance FreshRSS (ex: `https://freshrss.mondomaine.fr`)
- `FRESHRSS_USERNAME` / `FRESHRSS_API_PASSWORD` — identifiants API FreshRSS (étape 1)
- `ANTHROPIC_API_KEY` — clé API Claude (laisse vide pour tourner en mode dégradé sans réécriture IA)
- `ADMIN_PASSWORD` — le seul mot de passe protégeant `/admin` (pas de compte utilisateur, juste ce
  mot de passe, définissable dans les variables Coolify/Docker)
- `ADMIN_SECRET` — chaîne aléatoire pour signer la session admin
- `CRON_SECRET` — si tu veux déclencher `/api/cron/generate` depuis l'extérieur du worker
- `EDITION_HOUR` / `EDITION_MINUTE` / `EDITION_TZ` — heure de génération quotidienne (par défaut 6h00 Europe/Paris)

## 3. Pousser le code sur GitHub

Ce projet a été généré dans un environnement sandbox sans accès réseau vers GitHub — c'est donc à
toi de faire le push initial, depuis ton propre terminal :

```bash
cd chemin/vers/dailyspoon
git init
git add .
git commit -m "Initial commit — DailySpoon"
git branch -M main
git remote add origin git@github.com:oweebee/DailySpoon.git
git push -u origin main
```

## 4. Déployer avec Coolify

Dans Coolify :

1. Crée une nouvelle ressource **Docker Compose** (ou deux ressources **Dockerfile** séparées si tu
   préfères), pointée sur ton repo GitHub `DailySpoon`.
2. Renseigne les variables d'environnement listées ci-dessus dans Coolify (elles remplacent le
   `.env`, ne commit jamais `.env` — il est dans `.gitignore`).
3. `docker-compose.yml` définit deux services :
   - `web` : sert le site + l'admin (port 3000)
   - `worker` : tourne en continu et déclenche `generateDailyEdition()` une fois par jour à l'heure
     configurée (`EDITION_HOUR`/`EDITION_MINUTE`/`EDITION_TZ`)
4. Au démarrage, chaque service exécute automatiquement `prisma migrate deploy` avant de se
   lancer (voir `docker-entrypoint.sh`) — donc les migrations sur ta RDS se font toutes seules.
5. Configure un domaine sur le service `web` dans Coolify comme d'habitude.

Si tu préfères tester en local avant de pousser sur ton serveur :

```bash
docker compose up --build
```

## 5. Premier lancement

Une fois déployé :

1. Va sur `https://ton-domaine/admin/login`, connecte-toi avec `ADMIN_PASSWORD`.
2. Dans `/admin/categories`, coche les catégories FreshRSS que DailySpoon doit inclure dans l'édition du
   jour (la liste est chargée e