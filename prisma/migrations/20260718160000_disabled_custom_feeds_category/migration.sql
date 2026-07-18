-- Bascule groupée : masque tous les flux personnalisés rattachés à une
-- catégorie FreshRSS donnée, sans toucher aux cases individuelles des flux
-- ni à la catégorie FreshRSS elle-même. Voir prisma/schema.prisma
-- (DisabledCustomFeedsCategory) pour le détail.

CREATE TABLE "DisabledCustomFeedsCategory" (
    "id" TEXT NOT NULL,
    "freshrssCategoryId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DisabledCustomFeedsCategory_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "DisabledCustomFeedsCategory_freshrssCategoryId_key" ON "DisabledCustomFeedsCategory"("freshrssCategoryId");
