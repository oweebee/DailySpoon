# DailySpoon

Ton journal personnel quotidien, généré automatiquement à partir des flux que tu suis déjà dans
FreshRSS.

Chaque jour, DailySpoon récupère les articles des catégories FreshRSS que tu as choisies, fait
réécrire/résumer/classer/prioriser les articles par une IA, et publie une édition (façon une de
journal). Autour de cette une : **En direct** (`/direct`, tous les articles récents groupés par
catégorie, avec recherche dans tout l'historique et bouton « Télégraphier les news » sans IA), les
**favoris** (`/favoris`, étoile shérif), et les **archives** (`/archive`, chaque impression figée
telle quelle, consultable par date).

Les articles s'ouvrent **directement dans l'appli** (fenêtre de lecture propre, extraction façon
Reader View, avec repli morss pour les sites qui bloquent), sans quitter DailySpoon. Deux
intégrations optionnelles complètent le tout : **notifications Telegram** (photo + légende poussée
pour chaque nouvel article des flux cochés « notification ») et **Wallabag** (mettre un article en
favori l'envoie à ton instance Wallabag pour archivage, avec un tag `DailySpoon`). L'appli est aussi
**installable en PWA** sur mobile et bureau (icône sur l'écran d'accueil).

## Stack

- Next.js 14 (App Router) + Tailwind — front + API routes
- Prisma + PostgreSQL — data (articles, éditions, catégories sélectionnées). Postgres tourne dans
  le même docker-compose, avec un volume persistant : pas besoin d'une base externe.
- FreshRSS (API Google Reader) — source principale des articles ; la gestion de ces flux-là reste
  dans FreshRSS. En complément, des **flux RSS/Atom personnalisés** (URL directe, sans passer par
  FreshRSS) peuvent être ajoutés depuis `/admin/categories`, dans des catégories personnalisées ou
  directement dans une catégorie FreshRSS existante.
- Anthropic Claude ou Google Gemini (optionnel, au choix dans `/admin/settings`) —
  réécriture/résumé/classement/priorisation des articles, avec styles d'écriture configurables
- Un petit worker Node (`node-cron`) pour la génération quotidienne, le balayage des flux perso et
  les purges — pas besoin de Vercel Cron, tout tourne dans tes propres conteneurs Docker
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
- `ADMIN_PASSWORD` — le seul mot de passe protégeant tout le site (pas de compte utilisateur, juste
  ce mot de passe, définissable dans les variables Coolify/Docker)
- `ADMIN_SECRET` — chaîne aléatoire pour signer la session admin
- `CRON_SECRET` — si tu veux déclencher `/api/cron/generate` depuis l'extérieur du worker
- `EDITION_HOUR` / `EDITION_MINUTE` / `EDITION_TZ` — heure de génération quotidienne (par défaut 6h00 Europe/Paris)

La plupart des réglages applicatifs (FreshRSS, fournisseur IA Anthropic/Gemini et modèles, heure
et activation du planning, style d'écriture, rétention, instance morss, intervalle des flux perso,
notifications Telegram, intégration Wallabag...) se règlent ensuite directement dans
`/admin/settings`, sans redéploiement — les variables d'environnement ne servent que de valeurs de
repli quand un champ y est laissé vide (`AI_PROVIDER`, `GEMINI_API_KEY`, `GEMINI_MODEL`,
`RETENTION_DAYS`, `EDITION_SCHEDULE_ENABLED`, `WRITING_STYLE`, `MORSS_BASE_URL`, `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`, `WALLABAG_BASE_URL`, `WALLABAG_CLIENT_ID`, `WALLABAG_CLIENT_SECRET`,
`WALLABAG_USERNAME`, `WALLABAG_PASSWORD` existent aussi en variables d'env pour ça).

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
   FreshRSS, le fournisseur IA (Anthropic ou Gemini) et sa clé, ainsi que l'heure et l'activation
   du planning d'édition — un bouton **Tester les réglages** vérifie la connexion avant
   d'enregistrer. Ces valeurs remplacent les variables d'environnement correspondantes une fois
   enregistrées ici, sans redéploiement ; laisse un champ vide pour revenir à la variable
   d'environnement. C'est aussi ici que se configurent les deux intégrations optionnelles :
   **Telegram** (jeton du bot + id du chat, avec un bouton de test d'envoi) et **Wallabag** (URL de
   l'instance + client id/secret OAuth2 + identifiant/mot de passe, avec un bouton « Tester la
   connexion »).
3. Dans `/admin/categories`, coche les catégories FreshRSS à inclure (liste chargée en direct
   depuis FreshRSS), règle indépendamment « En direct » et « Impression IA » par catégorie, et
   ajoute si tu veux des flux RSS personnalisés (avec leurs catégories personnalisées) et des
   flux « médaillés » (mis en avant à la une d'En direct).
4. Lance une première impression sans attendre le lendemain : bouton de génération sur l'accueil
   (si le planning auto est désactivé) ou « Télégraphier les news » sur `/direct` pour un premier
   remplissage sans IA.
5. Le worker prend ensuite le relais tout seul : édition quotidienne à l'heure réglée (si le
   planning est actif) et balayage des flux personnalisés à l'intervalle choisi.

## Développement local (sans Docker)

Nécessite un Postgres local (ou lance juste `docker compose up db` pour n'avoir que la base).

```bash
npm install
npx prisma migrate deploy   # ou `npx prisma db push` en dev rapide
npm run dev                 # site sur http://localhost:3000
npm run generate:edition    # génère une édition manuellement, dans un autre terminal
```

## Notes

- Sans clé IA (Anthropic ou Gemini), les articles sont quand même récupérés et publiés, mais sans
  réécriture/résumé/priorisation par IA (mode dégradé, texte brut des flux). Le bouton
  « Télégraphier les news » de `/direct` ne consomme JAMAIS de tokens IA, même si une clé est
  configurée.
- Chaque génération crée sa propre édition, figée telle quelle dans `/archive` (avec le modèle, le
  style et les tokens consommés de cette impression précise) — régénérer le même jour n'écrase
  jamais une impression précédente. Les doublons stricts et les brouillons vides ne sont pas
  conservés.
- Les articles se lisent dans une fenêtre interne (extraction façon Reader View côté serveur, servie
  depuis notre propre domaine pour contourner les blocages iframe des sites) ; quand le site source
  bloque le fetch serveur, un repli **morss** est tenté (si une instance est configurée), et en
  dernier recours l'aperçu déjà récupéré depuis le flux est affiché. **En direct** reste toujours
  100 % sans IA : sa fenêtre de lecture et ses vignettes montrent le texte brut du flux, jamais un
  résumé réécrit par l'IA (même après une impression IA).
- **Notifications Telegram** (optionnel) : coche « notification » sur un flux dans
  `/admin/categories` pour recevoir une photo + légende dans ton canal Telegram à chaque nouvel
  article de ce flux. Configuration et bouton de test dans `/admin/settings`.
- **Wallabag** (optionnel) : une fois l'instance renseignée dans `/admin/settings`, mettre un
  article en favori envoie son lien à Wallabag pour archivage, avec le tag `DailySpoon`. Envoi
  uniquement à l'ajout du favori (jamais au retrait), best-effort et non bloquant (un souci Wallabag
  ne fait jamais échouer la mise en favori locale ; les échecs sont tracés dans `/admin/logs`).
- **PWA** : DailySpoon est installable sur mobile et bureau (« Ajouter à l'écran d'accueil » /
  « Installer »), avec sa propre icône ; sur mobile, le bouton/geste retour referme la fenêtre de
  lecture d'un article plutôt que de quitter la page.
- La rétention de l'historique (articles ET éditions) se règle dans `/admin/settings` (2 ans par
  défaut, 0 = illimité) ; les articles marqués favoris ne sont jamais purgés.
- Un journal technique (`/admin/logs`) trace récupérations de flux, générations et appels IA, avec
  sa propre rétention.
- DailySpoon ne modifie jamais l'état lu/non-lu de tes articles dans FreshRSS — il se contente de
  lire.
- Pas de compte utilisateur : un seul mot de passe (`ADMIN_PASSWORD`) protège tout le site (lecture
  et admin, même session).
- Les données Postgres vivent dans le volume Docker `dailyspoon_db_data` : elles survivent aux
  redéploiements, mais si tu supprimes le volume (ou la ressource entière dans Coolify), elles sont
  perdues — pense à un backup si le contenu devient précieux.
