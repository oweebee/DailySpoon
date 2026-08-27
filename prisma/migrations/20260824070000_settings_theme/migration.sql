-- Thème visuel de l'application : "dailyspoon" (défaut, l'habillage journal
-- papier d'origine) ou "material" (sombre, minimaliste, monospace).
-- NULL par défaut, ce que getSettings() lit comme "dailyspoon" : les
-- installations existantes gardent donc exactement leur apparence actuelle
-- sans aucune action. Voir src/lib/settings.ts et Settings.theme dans
-- schema.prisma.
ALTER TABLE "Settings" ADD COLUMN "theme" TEXT;
