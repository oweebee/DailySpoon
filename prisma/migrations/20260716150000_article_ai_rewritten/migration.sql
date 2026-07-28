ALTER TABLE "Article" ADD COLUMN "aiRewritten" BOOLEAN NOT NULL DEFAULT false;

-- Backfill rétroactif : fallbackProcess copie sourceExcerpt tel quel dans
-- summary (aucune réécriture), alors qu'un vrai passage IA ne produit
-- (quasi) jamais un texte identique au brut. On s'en sert comme signal pour
-- distinguer, sur les articles déjà en base, ceux qui ont vraiment été
-- réécrits par l'IA de ceux tombés en fallback (plafond par catégorie,
-- absence de clé IA...) — sans quoi ces derniers resteraient affichés sur la
-- une jusqu'à la prochaine génération complète.
UPDATE "Article"
SET "aiRewritten" = true
WHERE "processed" = true
  AND "summary" IS NOT NULL
  AND "summary" IS DISTINCT FROM "sourceExcerpt";
