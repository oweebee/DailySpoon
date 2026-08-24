-- Clé d'accès optionnelle à l'instance LibreTranslate auto-hébergée, quand
-- celle-ci est protégée par LT_REQUIRE_API_KEY / LT_API_KEYS. Nécessaire dès
-- que l'instance est jointe par un domaine public plutôt que par le réseau
-- Docker interne. Vide par défaut : aucune clé n'est envoyée tant que ce
-- champ n'est pas renseigné, le comportement reste donc inchangé. Voir
-- src/lib/translate.ts et Settings.libretranslateApiKey dans schema.prisma.
ALTER TABLE "Settings" ADD COLUMN "libretranslateApiKey" TEXT;
