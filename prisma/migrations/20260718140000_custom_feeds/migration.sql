-- Catégories personnalisées + flux RSS ajoutés à la main (hors FreshRSS).
-- Voir prisma/schema.prisma (CustomCategory, CustomFeed) pour le détail.

CREATE TABLE "CustomCategory" (
    "id" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "order" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomCategory_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CustomFeed" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "categoryId" TEXT NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CustomFeed_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "CustomFeed_categoryId_idx" ON "CustomFeed"("categoryId");

ALTER TABLE "CustomFeed"
    ADD CONSTRAINT "CustomFeed_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "CustomCategory"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Intervalle global de récupération des flux personnalisés (minutes) + dernier
-- balayage complet — voir schema.prisma pour le détail.
ALTER TABLE "Settings" ADD COLUMN "customFeedsIntervalMinutes" INTEGER;
ALTER TABLE "Settings" ADD COLUMN "customFeedsLastFetchedAt" TIMESTAMP(3);
