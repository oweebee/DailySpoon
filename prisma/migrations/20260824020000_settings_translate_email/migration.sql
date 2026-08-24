-- Adresse e-mail optionnelle transmise à MyMemory (paramètre "de=") pour
-- faire passer le quota gratuit de traduction de 5 000 à 50 000 caractères
-- par jour. Vide par défaut : tant que ce champ n'est pas renseigné depuis
-- /admin/settings, aucune adresse n'est envoyée au service. Voir
-- src/lib/translate.ts et Settings.translateEmail dans schema.prisma.
ALTER TABLE "Settings" ADD COLUMN "translateEmail" TEXT;
