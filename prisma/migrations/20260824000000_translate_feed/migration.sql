-- Flux cochés "traduction" dans /admin/categories (même id synthétique que
-- MedalFeed/NotifyFeed) + cache du titre/extrait déjà traduits sur Article,
-- affiché directement en "En direct" pour les flux concernés. Voir
-- schema.prisma (TranslateFeed) et syncTranslateFlags (generateEdition.ts).
CREATE TABLE "TranslateFeed" (
    "id" TEXT NOT NULL,
    "freshrssId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TranslateFeed_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TranslateFeed_freshrssId_key" ON "TranslateFeed"("freshrssId");

ALTER TABLE "Article" ADD COLUMN "translatedTitle" TEXT, ADD COLUMN "translatedExcerpt" TEXT;
