-- Ajoute la colonne de suivi d'erreur de récupération sur CustomFeed, pour
-- rendre visible dans /admin/categories un flux qui échoue silencieusement
-- côté worker (parsing RSS impossible, hôte injoignable, timeout...).
ALTER TABLE "CustomFeed" ADD COLUMN "lastFetchError" TEXT;
