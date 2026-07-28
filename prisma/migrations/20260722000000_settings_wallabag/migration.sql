-- Intégration Wallabag : mettre un article en favori envoie son lien à
-- Wallabag pour archivage. Wallabag n'a pas de simple clé API — il faut un
-- flux OAuth2 "password grant", d'où ces 5 champs (URL de l'instance,
-- client id/secret, identifiant, mot de passe). Voir schema.prisma et
-- src/lib/wallabagSend.ts. Tout vide = intégration inactive.
ALTER TABLE "Settings"
    ADD COLUMN "wallabagBaseUrl" TEXT,
    ADD COLUMN "wallabagClientId" TEXT,
    ADD COLUMN "wallabagClientSecret" TEXT,
    ADD COLUMN "wallabagUsername" TEXT,
    ADD COLUMN "wallabagPassword" TEXT;
