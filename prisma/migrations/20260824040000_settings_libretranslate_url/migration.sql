-- URL d'une instance LibreTranslate auto-hébergée (conteneur déployé
-- séparément, voir libretranslate/docker-compose.yml). Renseignée, elle
-- devient le moteur de traduction principal, DeepL et MyMemory passant en
-- repli. Vide par défaut : sans elle, rien ne change. Voir
-- src/lib/translate.ts et Settings.libretranslateUrl dans schema.prisma.
ALTER TABLE "Settings" ADD COLUMN "libretranslateUrl" TEXT;
