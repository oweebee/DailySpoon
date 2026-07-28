-- morss est désormais un service interne du même docker-compose (adresse
-- toujours "http://morss:8000", codée en dur dans settings.ts) : ce champ
-- n'a plus de raison d'être configurable.
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "morssBaseUrl";
