# Changelog

Toutes les évolutions notables de DailySpoon sont listées ici.

Format inspiré de [Keep a Changelog](https://keepachangelog.com/fr/1.0.0/). Numérotation :
- **x.y.Z** (ex. 1.0.1) — petit correctif, sans nouvelle fonctionnalité
- **x.Y.z** (ex. 1.1.0, 1.2.0) — fonctionnalité ou amélioration moyenne
- **X.y.z** (ex. 2.0.0, 3.0.0) — grosse feature ou refonte

## [1.2.0] - 2026-07-29

### Modifié
- Notifications Telegram : envoi de l'image réelle de l'article (og:image / illustration extraite) au lieu de la bannière fixe systématique, avec filtrage des images inexploitables (favicon générique, placeholder de lazy-load, logo de marque) et repli automatique sur la bannière fixe si l'article n'a pas d'image utilisable ou si Telegram échoue à la récupérer.

## [1.1.0] - 2026-07-28

### Ajouté
- Export/import des archives (éditions IA déjà générées) dans `/admin/settings`, section « Archives (éditions IA) » — séparé de l'export de configuration existant, qui exclut volontairement articles et éditions. L'import n'ajoute que les éditions absentes, sans jamais écraser ni supprimer.

## [1.0.3] - 2026-07-28

### Modifié
- Outil de test de scraping morss déplacé de `/admin/settings` vers `/admin/categories`, juste au-dessus du formulaire d'ajout de flux perso (plus logique pour tester une URL avant de l'ajouter directement en dessous).

## [1.0.2] - 2026-07-28

### Ajouté
- Barre de progression noire affichée en haut de la page de lecture d'un article pendant le rechargement déclenché par « Traduire en français » (la traduction peut prendre plusieurs secondes sans aucun autre signe de chargement visible).

## [1.0.1] - 2026-07-28

### Corrigé
- Flux personnalisés « Reuters World » et « Reuters Europe » (morts depuis l'arrêt du RSS officiel de Reuters en 2020) remplacés par les flux officiels BBC News (`/world` et `/world/europe`).

## [1.0.0] - 2026-07-28

Version de référence — repart d'un historique Git propre (squash), regroupant tout ce qui existait avant cette date.

### Contenu de la V1

- Génération quotidienne d'une édition (« une » de journal) à partir des catégories FreshRSS suivies, avec réécriture/résumé/classement/priorisation par IA (Anthropic ou Google Gemini, au choix)
- **En direct** (`/direct`) : tous les articles récents groupés par catégorie, recherche dans l'historique, bouton « Télégraphier les news » (0 IA)
- **Favoris** (`/favoris`) et **archives** (`/archive`, éditions figées consultables par date)
- Flux RSS/Atom personnalisés (en plus de FreshRSS), avec repli automatique **morss** (scraping) en cas de blocage d'un site source, tunnel **OpenVPN optionnel** pour morss (réglable/testable depuis `/admin/settings`), et outil de test de scraping morss intégré
- Contournement automatique des blocages Reddit au niveau flux (API JSON, miroirs Redlib auto-rafraîchis, bascule d'abonnement FreshRSS)
- Lecture des articles directement dans l'appli (extraction façon Reader View, nettoyage du « junk » des pages sources)
- Intégrations optionnelles : notifications **Telegram**, archivage **Wallabag**
- **PWA** installable (mobile et bureau)
- **Lecteur RSS externe** compatible FreshRSS/Google Reader (`/api/greader.php`)
- Rétention configurable de l'historique, journal technique (`/admin/logs`)
- Déploiement Docker Compose auto-hébergé (Coolify), 4 services : `db` / `web` / `worker` / `morss`
