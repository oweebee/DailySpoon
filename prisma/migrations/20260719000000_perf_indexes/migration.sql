-- Index de performance ajoutés AVANT que la table Article ne grossisse —
-- voir les commentaires dans schema.prisma (@@index) pour le détail des
-- requêtes couvertes par chacun. "IF NOT EXISTS" par sécurité : idempotent
-- si un index homonyme a déjà été posé à la main.

CREATE INDEX IF NOT EXISTS "Article_feedId_idx" ON "Article"("feedId");
CREATE INDEX IF NOT EXISTS "Article_categoryLabel_idx" ON "Article"("categoryLabel");
CREATE INDEX IF NOT EXISTS "Article_publishedAt_idx" ON "Article"("publishedAt");
CREATE INDEX IF NOT EXISTS "Article_included_publishedAt_idx" ON "Article"("included", "publishedAt");
CREATE INDEX IF NOT EXISTS "Article_sourceUrl_idx" ON "Article"("sourceUrl");

CREATE INDEX IF NOT EXISTS "Edition_date_generatedAt_idx" ON "Edition"("date", "generatedAt");
CREATE INDEX IF NOT EXISTS "Edition_status_date_idx" ON "Edition"("status", "date");
