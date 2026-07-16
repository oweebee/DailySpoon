-- Vivier total d'articles "included" du jour couvert par cette édition,
-- avant le plafond IA par catégorie (MAX_AI_ITEMS_PER_CATEGORY) — permet
-- d'afficher "33 articles (IA) sur 409 récupérés" plutôt que seulement le
-- compte final retenu sur la une.
ALTER TABLE "Edition" ADD COLUMN "sourcePoolCount" INTEGER;
