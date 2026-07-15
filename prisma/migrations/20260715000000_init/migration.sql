-- CreateTable
CREATE TABLE "SelectedCategory" (
    "id" TEXT NOT NULL,
    "freshrssId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SelectedCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Article" (
    "id" TEXT NOT NULL,
    "freshrssItemId" TEXT NOT NULL,
    "feedTitle" TEXT NOT NULL,
    "categoryLabel" TEXT,
    "sourceUrl" TEXT NOT NULL,
    "sourceTitle" TEXT NOT NULL,
    "sourceExcerpt" TEXT,
    "publishedAt" TIMESTAMP(3),
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed" BOOLEAN NOT NULL DEFAULT false,
    "headline" TEXT,
    "summary" TEXT,
    "category" TEXT,
    "priorityScore" INTEGER,
    "editionId" TEXT,

    CONSTRAINT "Article_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Edition" (
    "id" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "headline" TEXT,
    "status" TEXT NOT NULL DEFAULT 'draft',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Edition_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "SelectedCategory_freshrssId_key" ON "SelectedCategory"("freshrssId");

-- CreateIndex
CREATE UNIQUE INDEX "Article_freshrssItemId_key" ON "Article"("freshrssItemId");

-- CreateIndex
CREATE INDEX "Article_editionId_idx" ON "Article"("editionId");

-- CreateIndex
CREATE UNIQUE INDEX "Edition_date_key" ON "Edition"("date");

-- AddForeignKey
ALTER TABLE "Article" ADD CONSTRAINT "Article_editionId_fkey" FOREIGN KEY ("editionId") REFERENCES "Edition"("id") ON DELETE SET NULL ON UPDATE CASCADE;
