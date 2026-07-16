-- Extension pg_trgm : nécessaire pour indexer les recherches "contient"
-- (LIKE/ILIKE '%terme%'), impossibles à accélérer avec un index B-tree
-- classique. "Trusted" depuis PostgreSQL 13 : activable sans privilège
-- superuser sur une base Coolify/postgres standard.
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Un index GIN trigram par colonne interrogée dans /api/articles/search —
-- garde la recherche rapide même avec des centaines de milliers d'articles
-- en base (longue rétention + tout ce qui est aspiré, y compris les flux
-- exclus, depuis l'ajout du champ "included").
CREATE INDEX "Article_headline_trgm_idx" ON "Article" USING GIN ("headline" gin_trgm_ops);
CREATE INDEX "Article_summary_trgm_idx" ON "Article" USING GIN ("summary" gin_trgm_ops);
CREATE INDEX "Article_sourceTitle_trgm_idx" ON "Article" USING GIN ("sourceTitle" gin_trgm_ops);
CREATE INDEX "Article_feedTitle_trgm_idx" ON "Article" USING GIN ("feedTitle" gin_trgm_ops);
CREATE INDEX "Article_category_trgm_idx" ON "Article" USING GIN ("category" gin_trgm_ops);
