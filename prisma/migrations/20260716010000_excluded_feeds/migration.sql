-- AlterTable
ALTER TABLE "Article" ADD COLUMN "feedId" TEXT;

-- CreateTable
CREATE TABLE "ExcludedFeed" (
    "id" TEXT NOT NULL,
    "freshrssId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExcludedFeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ExcludedFeed_freshrssId_key" ON "ExcludedFeed"("freshrssId");
