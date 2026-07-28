-- Interrupteur explicite pour FreshRSS, décoché (NULL) par défaut : tant
-- qu'il n'est pas activé depuis /admin/settings, FreshRSS est traité comme
-- non configuré même si l'URL/identifiant/mot de passe existent (en base ou
-- via les variables d'environnement FRESHRSS_*). Voir src/lib/settings.ts et
-- src/lib/freshrss.ts.
ALTER TABLE "Settings" ADD COLUMN "freshrssEnabled" BOOLEAN;
