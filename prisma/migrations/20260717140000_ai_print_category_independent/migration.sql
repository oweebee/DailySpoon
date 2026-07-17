-- Découple "Impression IA" de SelectedCategory (En Direct) : nouvelle table
-- indépendante, une ligne par catégorie FreshRSS explicitement décochée pour
-- l'impression IA (absence de ligne = activée par défaut).

CREATE TABLE "AiPrintCategory" (
  "id" TEXT NOT NULL,
  "freshrssId" TEXT NOT NULL,
  "label" TEXT NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AiPrintCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AiPrintCategory_freshrssId_key" ON "AiPrintCategory"("freshrssId");

-- Reprise des choix déjà faits : les catégories jusqu'ici décochées côté
-- "Impression IA" (frontPageEnabled = false sur SelectedCategory) gardent
-- leur choix, désormais stocké indépendamment de la sélection En Direct.
INSERT INTO "AiPrintCategory" ("id", "freshrssId", "label", "enabled")
SELECT substr(md5(random()::text || clock_timestamp()::text), 1, 25), "freshrssId", "label", "frontPageEnabled"
FROM "SelectedCategory"
WHERE "frontPageEnabled" = false;

-- La colonne d'origine n'est plus utilisée (remplacée par AiPrintCategory).
ALTER TABLE "SelectedCategory" DROP COLUMN "frontPageEnabled";
