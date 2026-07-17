-- Corrige les éditions marquées "published" alors qu'elles n'ont en réalité
-- AUCUN article figé (EditionArticle) — cas produit par un passage où TOUS
-- les appels IA ont échoué (mauvais modèle Gemini, clé invalide...) : le
-- statut se basait jusqu'ici sur un simple compte d'articles bruts inclus,
-- pas sur le contenu réellement réécrit par l'IA et présent sur la une.
--
-- Une telle édition "fantôme" pouvait devenir la plus récente "published" et
-- masquer ainsi une édition précédente parfaitement valide, donnant
-- l'impression que "la dernière impression n'apparaît plus" sur la page
-- d'accueil (qui affiche alors "Aucune édition générée").
--
-- Repasse ces éditions en "draft" pour que la page d'accueil et /archive
-- retombent naturellement sur la dernière édition "published" qui a
-- effectivement du contenu figé.
UPDATE "Edition" e
SET "status" = 'draft'
WHERE e."status" = 'published'
  AND NOT EXISTS (
    SELECT 1 FROM "EditionArticle" ea WHERE ea."editionId" = e."id"
  );
