-- Compatibilité API Google Reader (voir src/lib/greader.ts) : permet de
-- connecter DailySpoon à un lecteur externe (Readrops...) comme un FreshRSS.
--
-- greaderId : identifiant numérique stable exigé par l'API Google Reader.
-- SERIAL = colonne integer NOT NULL + séquence dédiée + default nextval, avec
-- attribution automatique d'une valeur croissante à CHAQUE ligne existante
-- (donc pas besoin de backfill manuel) et à chaque insertion future. La
-- séquence est nommée "Article_greaderId_seq" par Postgres, ce qui correspond
-- à la convention attendue par @default(autoincrement()) côté Prisma.
ALTER TABLE "Article" ADD COLUMN "greaderId" SERIAL;
CREATE UNIQUE INDEX "Article_greaderId_key" ON "Article"("greaderId");

-- readState : état lu/non-lu propre à l'API Google Reader. Default false (non
-- lu) pour les futurs articles ; les articles DÉJÀ en base sont marqués lus
-- (true) juste après, pour ne pas apparaître comme des milliers de non-lus au
-- tout premier branchement d'un lecteur externe.
ALTER TABLE "Article" ADD COLUMN "readState" BOOLEAN NOT NULL DEFAULT false;
UPDATE "Article" SET "readState" = true;
