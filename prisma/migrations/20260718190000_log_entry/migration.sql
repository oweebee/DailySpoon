-- Journal technique persistant (/admin/logs) + réglage de rétention associé.
ALTER TABLE "Settings" ADD COLUMN "logRetentionMinutes" INTEGER;

CREATE TABLE "LogEntry" (
    "id" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "level" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "detail" TEXT,

    CONSTRAINT "LogEntry_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LogEntry_createdAt_idx" ON "LogEntry"("createdAt");
CREATE INDEX "LogEntry_level_idx" ON "LogEntry"("level");
