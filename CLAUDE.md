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

## Environnement de dev

Ce dossier est un dossier Windows synchronisé, monté dans un environnement Linux sandboxé pour les
sessions Claude. Ce montage a un bug connu : certains fichiers peuvent se tronquer en cours
d'écriture (voir historique de commits "Fix corrupted files"). Si un fichier semble se terminer
brutalement en plein milieu d'une instruction, comparer avec `git show HEAD:<fichier>` avant de
tenter quoi que ce soit d'autre — l'historique Git a généralement la bonne version.
