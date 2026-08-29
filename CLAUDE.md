# DailySpoon — notes pour Claude

Conventions du projet à respecter dans les futures sessions.

## Règle n°1 : minimiser la consommation de tokens IA

Si une fonctionnalité peut être faite sans IA (heuristique, règle simple, calcul local), on la fait
sans IA. On ne fait appel à Anthropic que quand c'est vraiment nécessaire, et on essaie toujours de
minimiser la conso de tokens quand on doit y recourir.

Exemples déjà appliqués dans le code :
- `src/lib/ai.ts` : `processArticles()` a un mode dégradé (`fallbackProcess`) qui tourne sans clé
  Anthropic — le pipeline fonctionne de bout en bout sans IA.
- `src/app/api/admin/settings/test/route.ts` : le test de la clé Anthropic utilise
  `client.models.list()` (appel de métadonnées) plutôt qu'un vrai `messages.create()`, pour ne
  consommer aucun token de complétion.

Avant d'ajouter un appel à l'API Anthropic (ou d'augmenter `max_tokens`, la taille des prompts,
etc.), se demander si une alternative sans IA suffit.

## Réglages runtime

`src/lib/settings.ts` centralise la config modifiable sans redéploiement (FreshRSS, clé Anthropic,
horaire d'édition) via `/admin/settings`, avec repli sur les variables d'environnement si un champ
est vide en base. Toujours passer par `getSettings()` plutôt que lire `process.env` directement
dans le code applicatif.

## Apparence : un seul habillage

L'application n'a plus qu'un seul habillage, sombre et minimaliste. Le thème « journal papier »
d'origine (texture froissée, timbres-poste, lettrines, surligneurs peints, polices à empattements)
a été entièrement supprimé en V1 — code, règles CSS et images. **Ne pas le réintroduire**, ni
rajouter un attribut `data-theme` ou un système de thèmes multiples.

Restent réglables dans `/admin/settings`, et uniquement ça :
- la **déclinaison de couleur** (six palettes sombres, `MATERIAL_ACCENTS` dans `src/lib/theme.ts`) ;
- les **vignettes en couleur** plutôt qu'en noir et blanc (attribut `data-images` sur `<html>`).

Les couleurs ont une **source unique**, `src/lib/theme.ts`. Le layout les pose en variables CSS
inline sur `<html>` ; `globals.css` n'en garde qu'un jeu de repli dans `:root` (déclinaison
Ardoise) pour le cas où la base serait injoignable au rendu. Le lecteur d'article
(`src/app/api/article-proxy/route.ts`) est du HTML autonome servi en iframe : il ne peut lire
aucune variable CSS de l'app et écrit donc ses couleurs en dur, mais **en les lisant dans le même
module** — ne jamais y recopier une valeur à la main.

Écrire les couleurs Tailwind en `rgb(var(--color-x) / <alpha-value>)` et les variables en
composantes seules (`"10 10 10"`, sans `rgb()`) : c'est ce qui garde fonctionnels les modificateurs
d'opacité (`bg-ink/[0.07]`, `text-sepia/70`) employés partout.

## Carrousel mobile : aucun JavaScript

`MobilePagedSection` (une page = une rubrique, swipe horizontal) est
**entièrement en CSS**, et doit le rester. Chaque page est sa PROPRE zone de
défilement vertical (`.carousel-page`, `overflow-y: auto`) : le navigateur
conserve alors nativement une position par colonne.

La version précédente faisait partager aux colonnes la seule position de la
fenêtre, puis rattrapait ce défaut en JavaScript — mémorisation manuelle des
positions, détection de fin de geste, animation de rattrapage, hauteur du
conteneur imposée et remesurée au `ResizeObserver`. Quatre mécanismes qui
interagissaient, une dizaine de correctifs successifs, et toujours des
blocages, des remontées inexpliquées et des colonnes qui ne repartaient pas de
leur sommet. **Ne pas y revenir** : si le comportement doit changer, ça se
règle en CSS ou dans la structure, pas en réintroduisant du script.

Contrainte à respecter : le carrousel a besoin d'une **hauteur bornée**. Elle
descend du `<main>` (classe `shell-md` ou `shell-sm` selon le seuil de bascule
de la page) jusqu'à lui, via une classe `shell-fill` sur CHAQUE conteneur
intermédiaire. Un maillon oublié et le carrousel n'a plus de hauteur — donc
plus rien ne défile. Voir le bloc « CARROUSEL MOBILE » de `globals.css`.

## Versions

L'application est en **V1**. Les suivantes s'appellent V1.01, V1.02… jusqu'à un passage explicite
en V2 (demandé par l'utilisateur, pas décidé seul). Deux endroits à faire évoluer ensemble :
`src/lib/version.ts` (numéro affiché en bas de `/admin/settings`) et le champ `version` de
`package.json` (contraint au format semver). La table de correspondance du `CHANGELOG.md` fait foi.

## Environnement de dev

Ce dossier est un dossier Windows synchronisé, monté dans un environnement Linux sandboxé pour les
sessions Claude. Ce montage a deux limites connues :

1. **Troncature de fichiers** en cours d'écriture (voir historique de commits "Fix corrupted
   files"). Si un fichier semble se terminer brutalement en plein milieu d'une instruction,
   comparer avec `git show HEAD:<fichier>` avant de tenter quoi que ce soit d'autre — l'historique
   Git a généralement la bonne version.
2. **Suppression de fichiers impossible** (`Operation not permitted`, y compris via `git rm`, et
   github.com est inaccessible depuis la session). Un `git rm` qui échoue laisse en plus un
   `.git/index.lock` vide qui bloquera le prochain `push.bat` — le supprimer. Quand une session
   doit faire disparaître des fichiers, écrire un `.bat` jetable à la racine que l'utilisateur
   lance lui-même côté Windows (`git rm -f --ignore-unmatch`, puis `del`/`rmdir` pour les restes
   hors index, et un balayage des `.lock` du dossier `.git`), plutôt que de prétendre les avoir
   supprimés. Ce script est à usage unique : une fois lancé et le ménage poussé, il se supprime
   lui aussi.

## Vérification avant de rendre la main

Aucun `node_modules` dans ce dossier et le registre npm est bloqué depuis la session : `tsc` et
`next build` ne peuvent pas être lancés. Se relire autrement, systématiquement après toute
modification de JSX :
- pas de commentaire `//` posé directement entre des balises JSX (il faut `{/* */}`) — ça a
  provoqué deux déploiements échoués ;
- accolades/parenthèses équilibrées (comparer le solde avec `git show HEAD:<fichier>` : certains
  fichiers ont un solde non nul à cause de chaînes de caractères, ce n'est pas une erreur) ;
- aucun import ni symbole devenu orphelin après une suppression.
