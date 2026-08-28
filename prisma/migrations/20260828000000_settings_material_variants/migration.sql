-- Déclinaisons du thème Material : couleur globale (six variantes sur base
-- sombre) et vignettes en couleur plutôt qu'en noir et blanc.
-- NULL pour les deux = comportement actuel exactement inchangé ("ardoise",
-- images en noir et blanc). Voir src/lib/theme.ts et Settings.theme.
ALTER TABLE "Settings" ADD COLUMN "materialAccent" TEXT;
ALTER TABLE "Settings" ADD COLUMN "materialColorImages" BOOLEAN;
