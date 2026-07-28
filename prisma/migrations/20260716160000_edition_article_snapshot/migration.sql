-- Retire l'unicité de "date" : plusieurs éditions (régénérations) peuvent
-- désormais exister pour un même jour calendaire, chacune conservée comme
-- entrée distincte plutôt que d'écraser la précédente.
DROP INDEX "Edition_date_key";

-- Photo figée du contenu de la une IA à l'instant précis de CETTE
-- génération — voir commentaire dans schema.prisma pour le détail du
-- "pourquoi" (Article.editionId ne reflète que la DERNIÈRE édition ayant
-- touché cet article, ne peut donc pas servir d'historique par lui-même).
CREATE TABLE "EditionArticle" (
    "id" TEXT NOT NULL,
    "editionId" TEXT NOT NULL,
    "articleId" TEXT NOT NULL,
    "headline" TEXT,
    "summary" TEXT,
    "frontPageSummary" TEXT,
    "category" TEXT,
    "priorityScore" INTEGER,
    "imageUrl" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "feedTitle" TEXT NOT NULL,
    "categoryLabel" TEXT,
    "publishedAt" TIMESTAMP(3),
    "medal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "EditionArticle_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EditionArticle_editionId_idx" ON "EditionArticle"("editionId");

ALTER TABLE "EditionArticle" ADD CONSTRAINT "EditionArticle_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE CASCADE ON UPDATE CASCADE;
