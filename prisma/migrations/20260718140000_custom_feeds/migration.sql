-- Catégories personnalisées + flux RSS ajoutés à la main (hors FreshRSS).
-- Voir prisma/schema.prisma (CustomCategory, CustomFeed) pour le détail.

CREATE TABLE "CustomCategory" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomCategory_pkey" PRIMARY KEY ("id")
);

-- customCategoryId (catégorie perso) et freshrssCategoryId/Label (vraie
-- catégorie FreshRSS existante) sont mutuellement exclusifs : exactement
-- l'un des deux est renseigné selon le choix fait à la création du flux.
CREATE TABLE "CustomFeed" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "customCategoryId" TEXT,
    "freshrssCategoryId" TEXT,
    "freshrssCategoryLabel" TEXT,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomFeed_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomFeed_customCategoryId_idx" ON "CustomFeed"("customCategoryId");

ALTER TABLE "CustomFeed"
    ADD CONSTRAINT "CustomFeed_customCategoryId_fkey"
    FOREIGN KEY ("customCategoryId") REFERENCES "CustomCategory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Intervalle global de récupération des flux personnalisés (minutes) + dernier
-- balayage complet — voir schema.prisma pour le détail.
ALTER TABLE "Settings" ADD COLUMN "customFeedsIntervalMinutes" INTEGER;
ALTER TABLE "Settings" ADD COLUMN "customFeedsLastFetchedAt" TIMESTAMP(3);
