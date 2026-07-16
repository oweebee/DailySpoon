-- AlterTable
ALTER TABLE "Article" ADD COLUMN "medal" BOOLEAN NOT NULL DEFAULT false;

-- CreateIndex
CREATE INDEX "Article_medal_idx" ON "Article"("medal");
