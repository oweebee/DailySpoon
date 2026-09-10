# Suivi_IA_logs — DailySpoon

## Stack
Next.js (App Router) + Prisma + Tailwind + TS. Déploiement Coolify. Git via `push.bat`. Version **V1** (`1.0.0`).
Accueil `/` = « En direct » (zéro IA). Traduction = LibreTranslate auto-hébergé, interne.

## À DÉPLOYER (code commité, pas encore live)
1. `push.bat` + redéploiement **DailySpoon**.
2. Redéploiement **LibreTranslate** (RAM 1.5g + batch + sans req-limit).

## TODO
- Bump **V1.01** : `src/lib/version.ts` + `package.json`→`1.0.1` + entrée `CHANGELOG.md` (règle CLAUDE.md, accord user en attente).

## Fait cette session
- **Auto-refresh** : `GET /api/articles/latest-check` → `syncedAt` de la dernière édition. `DirectView` poll toutes les 60s → `router.refresh()` si changement. Zéro IA, zéro WS.
- (sessions précédentes : traduction progressive, vue compacte, badge couronne, LibreTranslate)

## Pièges / règles projet (voir CLAUDE.md)
- Zéro IA si évitable ; `getSettings()` jamais `process.env`.
- Couleurs : source unique `src/lib/theme.ts`.
- Carrousel mobile = 0 JS (CSS) ; hauteur via chaîne `shell-fill`.
- Commentaires JSX en `{/* */}`.
- Env Windows→Linux : troncature possible (`git show HEAD:<f>`) ; suppression fichiers interdite ; `tsc` via clone `/tmp/dailyspoon-build`.
