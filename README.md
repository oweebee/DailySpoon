# DailySpoon

Ton journal personnel quotidien, généré automatiquement à partir des flux que tu suis déjà dans
FreshRSS.

Chaque jour, DailySpoon récupère les articles des catégories FreshRSS que tu as choisies, fait
réécrire/résumer/classer/prioriser les articles par une IA, et publie une édition unique (façon
une de journal) avec archives consultables par date.

## Stack

- Next.js 14 (App Router) + Tailwind — front + API routes
- Prisma + PostgreSQL — data (articles, éditions, catégories sélectionnées). Postgres tourne dans
  le même docker-compose, avec un volume persistant : pas besoin d'une base externe.
- FreshRSS (API Google Reader) — source des articles ; la gestion des flux eux-mêmes
  (ajout/suppression/organisation) reste entièrement dans FreshRSS, pas dans DailySpoon
- Anthropic Claude (optionnel) — réécriture/résumé/classement/priorisation des articles
- Un petit worker Node (`node-cron`) pour la génération quotidienne — pas besoin de Vercel Cron,
  tout tourne dans tes propres conteneurs Docker
- Docker + docker-compose — pensé pour un déploiement Coolify sur ton propre serveur

## Structure

```
src/app/            pages (édition du jour, archives, admin)
src/lib/            logique métier (client FreshRSS, IA, génération d'édition, auth)
worker/             scheduler quotidien (cron) + script one-shot
prisma/             schéma + migrations
Dockerfile           image unique (web + worker via CMD)
docker-compose.yml   services db / web / worker
```

## 1. Activer l'API sur ton FreshRSS

Dans FreshRSS : Paramètres > Profil > section API, active l'accès API et note (ou définis) un mot
de passe API — pas forcément le même que ton mot de passe de connexion normal.

## 2. Configurer les variables d'environnement

Copie `.env.example` vers `.env` (en local) ou renseigne-les directement dans Coolify :

- `POSTGRES_USER` / `POSTGRES_PASSWORD` / `POSTGRES_DB` — optionnel, valeurs par défaut fournies ;
  change au moins `POSTGRES_PASSWORD`. Pas besoin de base externe, Postgres tourne dans le stack.
- `FRESHRSS_BASE_URL` — URL de ton instance FreshRSS (ex: `https://freshrss.mondomaine.fr`)
- `FRESHRSS_USERNAME` / `FRESHRSS_API_PASSWORD` — identifiants API FreshRSS (étape 1)
- `ANTHROPIC_API_KEY` — clé API Claude (laisse vide pour tourner en mode dégradé sans réécriture IA)
- `ADMIN_PASSWORD` — le seul mot de passe protégeant `/admin` (pas de compte utilisateur, juste ce
  mot de passe, définissable dans les variables Coolify/Docker)
- `ADMIN_SECRET` — chaîne aléatoire pour signer la session admin
- `CRON_SECRET` — si tu veux déclencher `/api/cron/generate` depuis l'extérieur du worker
- `EDITION_HOUR` / `EDITION_MINUTE` / `EDITION_TZ` — heure de génération quotidienne (par défaut 6h00 Europe/Paris)

## 3. Pousser le code sur GitHub

```bash
cd chemin/vers/dailyspoon
git init
git add .
git commit -m "Initial commit — DailySpoon"
git branch -M main
git remote add origin https://github.com/oweebee/DailySpoon.git
git push -u origin main
```

## 4. Déployer avec Coolify

Dans Coolify :

1. Crée une nouvelle ressource **Docker Compose**, pointée sur ton repo GitHub `DailySpoon`,
   branche `main`, fichier `/docker-compose.yml`.
2. Renseigne les variables d'environnement listées ci-dessus dans l'onglet **Environment
   Variables** de la ressource (elles remplacent le `.env`, ne commit jamais `.env` — il est dans
   `.gitignore`).
3. `docker-compose.yml` définit trois services :
   - `db` : Postgres, avec un volume nommé (`dailyspoon_db_data`) qui persiste entre les
     redéploiements
   - `web` : sert le site + l'admin (écoute en interne sur le port 3000, pas de port publié sur
     l'hôte — le fichier utilise `expose` et non `ports`)
   - `worker` : tourne en continu et déclenche `generateDailyEdition()` une fois par jour à
     l'heure configurée (`EDITION_HOUR`/`EDITION_MINUTE`/`EDITION_TZ`)
4. Au démarrage, `web` et `worker` attendent que `db` soit prête (healthcheck), puis exécutent
   automatiquement `prisma migrate deploy` avant de se lancer (voir `docker-entrypoint.sh`).
5. Pas de port à ouvrir toi-même : dans la configuration du service `web` sur Coolify, renseigne
   le champ **Domains** (ex: `https://dailyspoon.obsidianspoon.com`) et vérifie que le port exposé
   détecté est bien `3000`. Coolify configure Traefik automatiquement (certificat HTTPS compris) et
   route ce domaine directement vers le conteneur via son réseau interne. Assure-toi juste que le
   sous-domaine pointe (DNS) vers ton serveur Coolify.

Si tu préfères tester en local avant de pousser sur ton serveur :

```bash
docker compose up --build
```

## 5. Premier lancement

Une fois déployé :

1. Va sur `https://ton-domaine/admin/login`, connecte-toi avec `ADMIN_PASSWORD`.
2. Dans `/admin/settings`, vérifie/renseigne l'URL, l'identifiant et le mot de passe API
   FreshRSS ainsi que la clé Anthropic et l'heure de l'édition — un bouton **Tester les
   réglages** vérifie la connexion avant d'enregistrer. Ces valeurs remplacent les variables
   d'environnement correspondantes une fois enregistrées ici, sans redéploiement ; laisse un
   champ vide pour revenir à la variable d'environnement.
3. Dans `/admin/categories`, coche les catégories FreshRSS que DailySpoon doit inclure dans
   l'édition du jour (la liste est chargée en direct depuis FreshRSS).
4. Clique sur **Régénérer l'édition maintenant** pour générer une première édition sans attendre
   le lendemain matin.
4. Le worker prendra ensuite le relais tout seul, une fois par jour.

## Développement local (sans Docker)

Nécessite un Postgres local (ou lance juste `docker compose up db` pour n'avoir que la base).

```bash
npm install
npx prisma migrate deploy   # ou `npx prisma db push` en dev rapide
npm run dev                 # site sur http://localhost:3000
npm run generate:edition    # génère une édition manuellement, dans un autre terminal
```

## Notes

- Sans `ANTHROPIC_API_KEY`, les articles sont quand même récupérés et publiés, mais sans
  réécriture/résumé/priorisation par IA (mode dégradé, texte brut de FreshRSS).
- Une édition = un jour. Relancer la génération le même jour complète l'édition existante au lieu
  d'en créer une nouvelle.
- DailySpoon ne modifie jamais l'état lu/non-lu de tes articles dans FreshRSS — il se contente de
  lire.
- L'admin n'a pas de compte utilisateur : un seul mot de passe (`ADMIN_PASSWORD`) protège `/admin`.
- Les données Postgres vivent dans le volume Docker `dailyspoon_db_data` : elles survivent aux
  redéploiements, mais si tu supprimes le volume (ou la ressource entière dans Coolify), elles sont
  perdues — pense à un backup si le contenu devient précieux.
