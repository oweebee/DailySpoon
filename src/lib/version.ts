/**
 * Version affichée de l'application, en bas de la page d'administration.
 *
 * Source UNIQUE de ce numéro côté interface. À faire évoluer en même temps
 * que le champ "version" de package.json, en suivant la table de
 * correspondance du CHANGELOG :
 *
 *   V1     -> package.json 1.0.0
 *   V1.01  -> package.json 1.0.1
 *   V1.02  -> package.json 1.0.2
 *
 * Deux champs séparés parce que package.json doit respecter le format semver,
 * qui n'accepte pas « 1.01 ». Déduire l'un de l'autre automatiquement
 * demanderait une conversion fragile (que faire de 1.0.10 ?) pour une chaîne
 * qu'on écrit de toute façon à la main au moment de publier.
 */
export const APP_VERSION = "V1";
