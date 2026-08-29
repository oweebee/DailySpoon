# Changelog

Toutes les évolutions notables de DailySpoon sont listées ici.

## Numérotation

L'application repart de **V1**. Les versions suivantes s'appellent **V1.01**,
**V1.02**, etc., jusqu'à un passage explicite en **V2**.

Correspondance avec `package.json` : le champ `version` doit respecter le
format semver, qui n'accepte pas « 1.01 ». On y écrit donc le numéro
équivalent, la table ci-dessous faisant foi.

| Version affichée | Tag Git | `package.json` |
| ---------------- | ------- | -------------- |
| V1               | `v1`    | `1.0.0`        |
| V1.01            | `v1.01` | `1.0.1`        |
| V1.02            | `v1.02` | `1.0.2`        |
| …                | …       | …              |

## [V1] - 2026-08-28

Première version de référence. L'historique des versions antérieures (1.0.0 à
1.2.3) est retiré : ces numéros ne correspondent plus à rien de déployé, et
leurs tags comme leurs *releases* sont supprimés du dépôt en publiant cette
version. Ce fichier repart donc de zéro à partir d'ici.

État de l'application à cette version :

### Lecture

- Page d'accueil (`/`) : « En direct », toutes les rubriques en colonnes,
  sans aucune IA — titres et extraits bruts des flux. Carrousel horizontal en
  mobile, une rubrique par page, avec chargement infini.
- Page « Journal IA » (`/journal`) : la « une » quotidienne figée, générée par
  IA à l'impression.
- Lecteur d'article interne (extraction Readability côté serveur), plein écran
  en PWA, avec traduction à la demande.
- Navigation au doigt en PWA entièrement refondue : chaque rubrique est
  désormais sa propre zone de défilement, gérée nativement par le navigateur.
  Une colonne jamais lue s'ouvre en haut, une colonne déjà parcourue retrouve
  sa position, et le swipe horizontal ne touche plus au défilement vertical.
  Le carrousel ne contient plus une seule ligne de JavaScript.
- Favoris avec filtre par mot-clé, archives et recherche sur tout
  l'historique.

### Sources

- Flux FreshRSS et flux RSS personnalisés, gérés depuis `/admin/categories`.
- Options par flux : médaille (mise en avant), notification Telegram,
  traduction automatique en français.
- Cas Reddit traités à part (miroirs Redlib, API JSON, image et vidéo
  directes).

### Apparence

Un seul habillage : sombre et minimaliste. Titres de rubrique en filet
d'accent plutôt qu'en bandeau plein, séparateurs dégradés, boutons d'action
plats, cuillères du logotype dans le rouge profond de l'icône. L'habillage « journal papier »
d'origine (texture froissée, timbres-poste, lettrines, surligneurs peints,
polices de presse) a été entièrement retiré — code, règles CSS et images.

Deux réglages restent disponibles dans `/admin/settings` :

- six déclinaisons de couleur, toutes sur base sombre (« Ardoise » par
  défaut) ;
- vignettes en noir et blanc (défaut) ou en couleur.

### Traduction

- Instance LibreTranslate auto-hébergée, déployée séparément et raccordée par
  une simple URL. Aucun quota, aucune donnée envoyée à un tiers.
- Les flux cochés « traduction » sortent en français **partout** : vignettes
  « En direct », notifications Telegram, et articles servis aux lecteurs RSS
  externes via l'API Google Reader. Ouvrir l'article reste en langue
  d'origine, avec un bouton de traduction à la demande.

### Intégrations (toutes optionnelles)

- **Telegram** : photo + légende poussées dans un canal à chaque nouvel
  article des flux cochés « notification ».
- **Wallabag** : mettre un article en favori l'envoie à l'instance pour
  archivage, avec le tag `DailySpoon`.
- **morss** : repli de scraping pour les sites qui bloquent la lecture
  directe, avec tunnel OpenVPN optionnel réglable et testable depuis l'admin.
- **Lecteur RSS externe** : API Google Reader exposée sur `/api/greader.php`,
  compatible avec n'importe quel client FreshRSS.
- **PWA** installable sur mobile et bureau.

### Sécurité

- Un seul mot de passe (`ADMIN_PASSWORD`) protège tout le site, lecture
  comprise : un visiteur sans session ne voit que l'écran de connexion.
- Ce mot de passe est **obligatoire en production**. S'il n'est pas
  renseigné, l'application refuse tout accès au lieu de s'ouvrir, et l'écran
  de connexion indique que la variable manque côté serveur. La même règle
  s'applique à l'API Google Reader, qui contourne le middleware et fait sa
  propre vérification.
- En développement local, l'absence de mot de passe laisse au contraire le
  site ouvert — confort assumé, sans effet sur une instance déployée.

### Administration

- Réglages modifiables sans redéploiement (`/admin/settings`) : fournisseur
  IA, horaire d'impression, rétention, apparence, intégrations.
- Export/import de la configuration et des archives.
- Journal technique consultable dans `/admin/logs`.
