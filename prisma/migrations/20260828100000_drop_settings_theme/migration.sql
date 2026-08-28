-- L'application n'a plus qu'un seul habillage (sombre, minimaliste) : le
-- thème "dailyspoon" (journal papier) a été entièrement supprimé, code et
-- images comprises. La colonne qui mémorisait le thème choisi n'a donc plus
-- d'objet — seules restent réglables la déclinaison de couleur
-- (materialAccent) et les vignettes en couleur (materialColorImages).
--
-- "IF EXISTS" : la colonne peut ne jamais avoir été créée sur une base
-- fraîche déployée après coup, auquel cas cette migration ne fait rien
-- plutôt que d'échouer.
ALTER TABLE "Settings" DROP COLUMN IF EXISTS "theme";
