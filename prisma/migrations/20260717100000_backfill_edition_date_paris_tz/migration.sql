-- Recalcule rétroactivement Edition.date en jour calendaire Europe/Paris
-- (au lieu du jour UTC brut utilisé jusqu'ici) à partir de generatedAt, qui
-- lui reste un instant précis non ambigu. Corrige les éditions générées
-- entre 00h et 01h/02h heure de Paris (selon heure d'été/hiver), qui
-- s'affichaient encore étiquetées "hier" alors que leur contenu (scopé en
-- heure de Paris) était déjà celui du jour courant.
UPDATE "Edition"
SET "date" = (("generatedAt" AT TIME ZONE 'UTC') AT TIME ZONE 'Europe/Paris')::date;
