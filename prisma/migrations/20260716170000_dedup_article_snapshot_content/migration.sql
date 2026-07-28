-- Dédoublonne le contenu figé des archives : EditionArticle devient une
-- simple table de liaison (édition x article) et son contenu réel (texte,
-- image, score...) est déplacé dans ArticleSnapshotContent, partagé entre
-- toutes les lignes EditionArticle dont le contenu est strictement
-- identique (contentHash). Avant ça, régénérer plusieurs fois le même jour
-- dupliquait intégralement le texte de chaque article resté inchangé entre
-- deux régénérations.

-- 1. Nouvelle table de contenu partagé.
CREATE TABLE "ArticleSnapshotContent" (
    "id" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "headline" TEXT,
    "summary" TEXT,
    "frontPageSummary" TEXT,
    "category" TEXT,
    "priorityScore" INTEGER,
    "imageUrl" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "feedTitle" TEXT NOT NULL,
    "categoryLabel" TEXT,
    "publishedAt" TIMESTAMP(3),
    "medal" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "ArticleSnapshotContent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ArticleSnapshotContent_contentHash_key" ON "ArticleSnapshotContent"("contentHash");

-- 2. Reprise des lignes EditionArticle déjà existantes : une seule ligne de
-- contenu par combinaison distincte de champs (GROUP BY regroupe les NULL
-- ensemble), avec une empreinte MD5 (fonction native de Postgres, pas besoin
-- d'extension) calculée sur la concaténation des champs.
INSERT INTO "ArticleSnapshotContent" (
  "id", "contentHash", "headline", "summary", "frontPageSummary", "category",
  "priorityScore", "imageUrl", "sourceUrl", "sourceTitle", "feedTitle",
  "categoryLabel", "publishedAt", "medal"
)
SELECT
  gen_random_uuid()::text,
  md5(
    coalesce("headline", '') || '|' || coalesce("summary", '') || '|' ||
    coalesce("frontPageSummary", '') || '|' || coalesce("category", '') || '|' ||
    coalesce("priorityScore"::text, '') || '|' || coalesce("imageUrl", '') || '|' ||
    "sourceUrl" || '|' || "sourceTitle" || '|' || "feedTitle" || '|' ||
    coalesce("categoryLabel", '') || '|' || coalesce("publishedAt"::text, '') || '|' ||
    "medal"::text
  ),
  "headline", "summary", "frontPageSummary", "category", "priorityScore",
  "imageUrl", "sourceUrl", "sourceTitle", "feedTitle", "categoryLabel",
  "publishedAt", "medal"
FROM "EditionArticle"
GROUP BY
  "headline", "summary", "frontPageSummary", "category", "priorityScore",
  "imageUrl", "sourceUrl", "sourceTitle", "feedTitle", "categoryLabel",
  "publishedAt", "medal";

-- 3. Rattachement de chaque ligne EditionArticle existante à sa ligne de
-- contenu (même empreinte).
ALTER TABLE "EditionArticle" ADD COLUMN "contentId" TEXT;

UPDATE "EditionArticle" ea
SET "contentId" = asc_."id"
FROM "ArticleSnapshotContent" asc_
WHERE asc_."contentHash" = md5(
    coalesce(ea."headline", '') || '|' || coalesce(ea."summary", '') || '|' ||
    coalesce(ea."frontPageSummary", '') || '|' || coalesce(ea."category", '') || '|' ||
    coalesce(ea."priorityScore"::text, '') || '|' || coalesce(ea."imageUrl", '') || '|' ||
    ea."sourceUrl" || '|' || ea."sourceTitle" || '|' || ea."feedTitle" || '|' ||
    coalesce(ea."categoryLabel", '') || '|' || coalesce(ea."publishedAt"::text, '') || '|' ||
    ea."medal"::text
  );

ALTER TABLE "EditionArticle" ALTER COLUMN "contentId" SET NOT NULL;
ALTER TABLE "EditionArticle" ADD CONSTRAINT "EditionArticle_contentId_fkey" FOREIGN KEY ("contentId") REFERENCES "ArticleSnapshotContent"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "EditionArticle_contentId_idx" ON "EditionArticle"("contentId");

-- 4. Les colonnes ci-dessous sont désormais portées par ArticleSnapshotContent
-- (via "contentId") plutôt que dupliquées sur chaque ligne EditionArticle.
ALTER TABLE "EditionArticle"
  DROP COLUMN "headline",
  DROP COLUMN "summary",
  DROP COLUMN "frontPageSummary",
  DROP COLUMN "category",
  DROP COLUMN "priorityScore",
  DROP COLUMN "imageUrl",
  DROP COLUMN "sourceUrl",
  DROP COLUMN "sourceTitle",
  DROP COLUMN "feedTitle",
  DROP COLUMN "categoryLabel",
  DROP COLUMN "publishedAt",
  DROP COLUMN "medal";
