-- CreateTable
CREATE TABLE "MedalFeed" (
    "id" TEXT NOT NULL,
    "freshrssId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MedalFeed_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MedalFeed_freshrssId_key" ON "MedalFeed"("freshrssId");
