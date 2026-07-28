-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "freshrssBaseUrl" TEXT,
    "freshrssUsername" TEXT,
    "freshrssApiPassword" TEXT,
    "anthropicApiKey" TEXT,
    "anthropicModel" TEXT,
    "editionHour" INTEGER,
    "editionMinute" INTEGER,
    "editionTz" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);
