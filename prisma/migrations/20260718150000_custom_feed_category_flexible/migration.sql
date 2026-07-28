-- CustomFeed.categoryId (catégorie personnalisée obligatoire, voir la
-- migration 20260718140000_custom_feeds) devient facultative et flexible :
-- soit une catégorie personnalisée (customCategoryId, renommée depuis
-- categoryId), soit une vraie catégorie FreshRSS existante
-- (freshrssCategoryId/Label, copiée telle quelle — pas de table locale pour
-- FreshRSS, donc pas de FK possible). Exactement l'un des deux couples est
-- renseigné selon le choix fait à la création/édition du flux — voir
-- prisma/schema.prisma (CustomFeed) pour le détail complet.
--
-- Migration CORRECTIVE en ALTER TABLE plutôt qu'un simple edit de la
-- migration précédente : celle-ci était déjà appliquée en production avec
-- l'ancien schéma avant que ce design évolue (catégorie FreshRSS directe +
-- édition d'un flux) — Prisma ne rejoue jamais une migration déjà marquée
-- comme appliquée, même si son fichier source change ensuite.

ALTER TABLE "CustomFeed" DROP CONSTRAINT IF EXISTS "CustomFeed_categoryId_fkey";
DROP INDEX IF EXISTS "CustomFeed_categoryId_idx";

ALTER TABLE "CustomFeed" RENAME COLUMN "categoryId" TO "customCategoryId";
ALTER TABLE "CustomFeed" ALTER COLUMN "customCategoryId" DROP NOT NULL;

ALTER TABLE "CustomFeed" ADD COLUMN "freshrssCategoryId" TEXT;
ALTER TABLE "CustomFeed" ADD COLUMN "freshrssCategoryLabel" TEXT;

CREATE INDEX "CustomFeed_customCategoryId_idx" ON "CustomFeed"("customCategoryId");

ALTER TABLE "CustomFeed"
    ADD CONSTRAINT "CustomFeed_customCategoryId_fkey"
    FOREIGN KEY ("customCategoryId") REFERENCES "CustomCategory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
