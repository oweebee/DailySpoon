-- Cache auto-rafraîchi de la liste des miroirs Redlib fonctionnels (voir
-- src/lib/reddit.ts, worker/index.ts) — table singleton, une seule ligne
-- "singleton", jamais liée à aucune autre table.
CREATE TABLE "RedlibInstanceCache" (
    "id" TEXT NOT NULL DEFAULT 'singleton',
    "instancesJson" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RedlibInstanceCache_pkey" PRIMARY KEY ("id")
);
