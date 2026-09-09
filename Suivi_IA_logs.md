# Suivi_IA_logs — DailySpoon

## État
Next.js (App Router) + Prisma + Tailwind + TS. Déploiement Coolify. Git via `push.bat`.
Accueil `/` = « En direct » (zéro IA). Traduction = LibreTranslate auto-hébergé (interne, réseau Docker).
Version affichée : **V1** (`1.0.0`) — non incrémentée depuis, bump V1.01 en attente.

## Derniers changements (session en cours, commités sur disque, PAS encore déployés)
- `src/lib/translate.ts` : `TIMEOUT_MS` 20s→45s ; option `timeoutMs` par appel ; `translateBatchOrNull` (traduction par lots).
- `src/app/api/article-proxy/route.ts` : traduction article **progressive** (POST flux NDJSON, blocs 1 par 1, grisage `tr-pending` + halo, barre déterminée) ; gère blocs à balisage (liens/gras) via repères `{0}` ; lots de 8 ; budget 7 min ; abandon après 3 échecs ; repli serveur si flux KO.
- Vue **compacte** `/direct` (accueil) : bouton `.stamp-button` à côté de Télégraphier ; carte = miniature carrée 64px + titre + source, sans résumé ; état en `localStorage` (`dailyspoon:direct:compact`, par appareil) ; 2× articles/rubrique (10 + pas 10) ; `break-words` titre + source = fix débordement PWA. Fichiers : DirectView, EditionView, CategoryGrid, CategoryColumn.
- Badge couronne : `public/badges/wax-seal.png` remplacé (couronne) ; normal 53px sur photo ; compact 27px, coin bas-droite intérieur (`right/bottom:4px`).
- `libretranslate/docker-compose.yml` : interne only ; RAM 1g→1.5g ; `LT_REQ_LIMIT` retiré ; `LT_BATCH_LIMIT=64`.

## TODO
1. `push.bat` + redéploiement **DailySpoon** (Coolify).
2. Redéploiement **LibreTranslate** (1.5g RAM + batch + sans req-limit).
3. Bump **V1.01** : `src/lib/version.ts` + `package.json` version `1.0.1` + entrée `CHANGELOG.md` (règle CLAUDE.md, en attente accord).

## Pièges / contraintes projet
- Zéro IA si évitable ; jamais `process.env` direct → `getSettings()`.
- Couleurs : source unique `src/lib/theme.ts` ; le lecteur article lit ce module, aucune valeur en dur.
- Carrousel mobile (`MobilePagedSection`) = **0 JS**, tout CSS ; hauteur via chaîne `shell-fill`.
- Commentaires JSX : `{/* */}` jamais `//` entre balises.
- Env : dossier Windows monté Linux → troncature possible (comparer `git show HEAD:<f>`) ; suppression fichiers interdite (script .bat jetable) ; npm bloqué EN SESSION mais `tsc` lançable via clone `/tmp/dailyspoon-build` (a node_modules).
- Traduction Telegram : titre traduit inline à l'ingestion ; échecs = LT indispo/timeout, pas un bug de code.
