-- AlterTable
ALTER TABLE "Article" ADD COLUMN "favorite" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Article_favorite_idx" ON "Article"("favorite");
