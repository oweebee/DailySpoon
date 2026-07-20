-- Flux cochés "notification" (même id synthétique que MedalFeed/ExcludedFeed,
-- valable pour un vrai flux FreshRSS OU un flux perso) + réglages Telegram
-- pour le futur envoi via bot. Voir schema.prisma.
CREATE TABLE "NotifyFeed" (
    "id" TEXT NOT NULL,
    "freshrssId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NotifyFeed_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "NotifyFeed_freshrssId_key" ON "NotifyFeed"("freshrssId");

ALTER TABLE "Settings" ADD COLUMN "telegramBotToken" TEXT, ADD COLUMN "telegramChatId" TEXT;
