-- Métadonnées IA figées par génération (Edition), affichées dans /archive
-- à côté de la date : fournisseur, modèle exact, style d'écriture RÉSOLU
-- (jamais "random" tel quel). null pour les éditions existantes et pour
-- toute génération en mode "Aspirer les news" (forceNoAi, aucune IA).
ALTER TABLE "Edition" ADD COLUMN "aiProvider" TEXT;
ALTER TABLE "Edition" ADD COLUMN "aiModel" TEXT;
ALTER TABLE "Edition" ADD COLUMN "writingStyle" TEXT;
