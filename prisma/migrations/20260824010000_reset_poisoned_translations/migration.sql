-- Purge unique du cache de traduction "En direct" (voir TranslateFeed /
-- syncTranslateFlags).
--
-- La toute première version de syncTranslateFlags enregistrait le texte
-- D'ORIGINE (anglais) dans translatedTitle quand l'appel à Google Translate
-- échouait, "par sécurité". Effet de bord : le champ n'étant alors plus vide,
-- l'article sortait définitivement du filtre des candidats (translatedTitle
-- IS NULL) et restait affiché en anglais pour toujours, quel que soit le
-- nombre d'aspirations relancées ensuite. Comme le traitement partait des
-- articles les plus récents, ce sont justement ceux du HAUT des colonnes qui
-- se sont retrouvés figés.
--
-- Le code corrigé n'écrit plus rien en cas d'échec (voir translateOrNull dans
-- src/lib/translate.ts), mais il ne peut pas distinguer après coup une vraie
-- traduction d'un texte anglais mis en cache par erreur. On remet donc tout à
-- zéro une bonne fois : la prochaine aspiration reconstruira le cache
-- proprement, borné aux N articles les plus récents de chaque flux coché
-- (RECENT_ARTICLES_PER_FEED_TO_TRANSLATE), donc quelques dizaines d'appels
-- tout au plus.
UPDATE "Article"
SET "translatedTitle" = NULL, "translatedExcerpt" = NULL
WHERE "translatedTitle" IS NOT NULL OR "translatedExcerpt" IS NOT NULL;
