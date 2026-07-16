-- Style d'écriture de l'IA (réécriture/résumé des articles) : "normal" ou
-- "ackboo". NULL = pas réglé -> getSettings() retombe sur "normal" par défaut.
ALTER TABLE "Settings" ADD COLUMN "writingStyle" TEXT;
