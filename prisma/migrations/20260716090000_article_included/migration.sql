-- AlterTable
ALTER TABLE "Article" ADD COLUMN "included" BOOLEAN NOT NULL DEFAULT true;

-- CreateIndex
CREATE INDEX "Article_included_idx" ON "Article"("included");
