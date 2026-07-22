-- Mot de passe dédié pour l'API Google Reader (lecteur externe type Readrops,
-- voir src/lib/greader.ts). Optionnel : vide = le ClientLogin accepte le mot
-- de passe admin (rétrocompat). Sert à contourner les 403 dus à un caractère
-- spécial du mot de passe admin déformé en form-urlencoded lors du transit
-- depuis le lecteur.
ALTER TABLE "Settings" ADD COLUMN "greaderApiPassword" TEXT;
