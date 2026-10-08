# Sécurité

Carnet affiche des pages **écrites par des agents IA**, qui lisent eux-mêmes des mails, des pages web et des documents que personne n'a relus. La sécurité n'est donc pas un sujet à part : c'est la raison d'être de plusieurs choix d'architecture. Ce document dit contre quoi Carnet protège, ce qu'il demande à la personne qui l'installe, et comment signaler une faille.

## Signaler une vulnérabilité

**Ne crée pas d'issue publique pour une faille.** Utilise le signalement privé de GitHub : onglet **Security** du dépôt, puis **Report a vulnerability** (avis de sécurité privé). Décris le problème, la version ou le commit concerné, et comment le reproduire ; une preuve de concept minimale suffit.

Ce que tu peux attendre : un accusé de réception sous **7 jours**, une première évaluation sous 14 jours, un correctif ou un plan sous 90 jours selon la gravité, et une mention dans les notes de version si tu le souhaites. Carnet est maintenu par une personne : merci de ta patience. Le périmètre est le code de ce dépôt et sa configuration par défaut. Les failles des dépendances sont à signaler d'abord à leurs mainteneurs (nous les suivons et mettons à jour).

Versions prises en charge : la dernière version publiée et la branche `main`.

## Modèle de menace

### Ce qu'on protège

1. **Le navigateur et la session de la personne** : aucun contenu écrit par un agent ne doit s'exécuter dans l'origine de l'application.
2. **Les pages et fichiers de l'hôte** : l'application ne lit et n'écrit que dans le dossier de pages configuré.
3. **L'accès** : seules les personnes autorisées ouvrent Carnet.

### Qui l'attaque

| Adversaire | Exemple | Ce qui l'arrête |
|---|---|---|
| **Contenu piégé lu par un agent** | un mail ou une page web qui fait écrire du HTML, du script ou un lien malveillant dans une page | le Markdown n'exécute rien ; le HTML brut est affiché comme du texte, hors d'une grammaire fermée de balises de mise en forme (`<span color>` à neuf valeurs, `<mark>`, `<u>`, `<details>`, `<summary>`) reconnues sans aucun attribut libre ; aucun `.html`, `.svg`, `.js`, `.css` ni `.xml` n'est servi par l'application ; une couverture de page ne peut être qu'un dégradé maison ou une image de l'espace, jamais une URL externe |
| **Artefact HTML malveillant** (écrit par un agent trompé) | un tableau de bord qui tente de lire les pages, de voler l'identité ou d'envoyer des données à l'extérieur | il est servi par un autre serveur, sur une **autre origine**, dans un cadre `sandbox` à origine opaque, avec `connect-src 'none'` : ni cookies, ni stockage, ni réseau, ni accès à l'application |
| **Page web tierce** qui vise ton Carnet | une requête déclenchée depuis un autre site pendant que tu es connecté | anti-CSRF : en-tête `X-Carnet: 1` obligatoire, `Origin` et `Sec-Fetch-Site` vérifiés, aucun CORS ; contrôle du `Host` contre le DNS-rebinding |
| **Chemin piégé** | `../`, liens symboliques, noms cachés, encodages doubles pour lire `/etc/passwd` ou `.git` | chemins confinés à l'espace, un seul décodage, segments cachés refusés, liens symboliques suivis seulement s'ils restent dans l'espace, contrôle avant et après ouverture |
| **Corbeille ou historique piégés** | un `.meta.json` de corbeille réécrit pour restaurer une page hors de l'espace ; un nom de fichier comme `$(touch x)` ou `--help` pour détourner git | la meta est revalidée comme un chemin venu du client avant toute restauration, l'effacement reste confiné à l'élément ; git est lancé sans shell (`execFile`), avec des chemins littéraux, sans configuration système ni globale, seulement pour `log` et `cat-file`, en lecture seule ; identifiants de version et de corbeille en liste blanche |
| **Lien d'artefact volé ou deviné** | partage d'une URL d'artefact | jeton HMAC de 15 minutes, limité au dossier de l'artefact, comparé en temps constant |
| **Personne non autorisée** qui joint le service | un scanneur sur Internet | aucun port public ; un proxy authentifiant est la seule porte ; liste `CARNET_UTILISATEURS_AUTORISES` ; sans en-tête d'identité : `403` |

### Les contraintes de l'installation

Ce sont des **conditions de la sécurité**, pas des options :

1. **Ne jamais exposer Carnet sans authentification.** Il n'a pas de mot de passe : il fait confiance à un en-tête d'identité posé par un proxy authentifiant (Tailscale Serve, oauth2-proxy, Authelia, Cloudflare Access…) ou par Tailscale. Sans proxy qui authentifie, n'importe qui qui atteint le port est « connecté ».
2. **Le proxy efface l'en-tête d'identité reçu du client** avant de poser le sien. Sinon l'identité se forge d'un `curl`. `tailscale serve` le fait ; avec un reverse proxy, c'est à toi de le configurer (voir `docs/deploiement.md`).
3. **Les artefacts sont sur une autre origine** que l'application (autre nom d'hôte ou autre port). Sur la même origine, un artefact pourrait lire l'application. Le serveur refuse la signature de liens sur le nom d'hôte public des artefacts.
4. **Les ports restent sur `127.0.0.1`.** Le conteneur `carnet` est sur un réseau Docker dédié : aucun conteneur voisin ne peut l'appeler en forgeant l'en-tête.
5. **`CARNET_DEV=1` est réservé à l'essai local.** Il désactive l'identité. Le serveur refuse de démarrer avec ce mode si une origine non locale est déclarée.
6. **La clé de signature** (`secrets/art-hmac.key`) reste en `chmod 600`, hors de git et hors des pages. Une fuite permet de forger des liens d'artefacts de 15 minutes pour les artefacts existants ; remplace-la pour tout invalider.
7. **Ne partage pas la machine avec des tiers non fiables** : un processus local qui atteint `127.0.0.1:3020` peut forger l'en-tête d'identité.

### Défense en profondeur déjà en place

- CSP stricte sur l'application : `default-src 'self'; script-src 'self'` (ni `unsafe-eval`, ni script en ligne), `connect-src 'self'`, `frame-src` limité à l'application et à l'origine des artefacts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. Seule concession : `style-src 'unsafe-inline'`, pour les styles posés par l'éditeur.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP et CORP `same-origin`, `Permissions-Policy`.
- Dans l'espace, Carnet n'écrit que des pages `.md`, les images envoyées, le rangement `.carnet/ordre.json` et le contenu de `.corbeille/` ; favoris et instantanés vont dans le dossier d'état, hors de l'espace. Les images envoyées sont vérifiées par leurs octets magiques (PNG, JPEG, WebP, GIF) et toutes les images sont servies avec `CSP: sandbox`.
- Le service worker ne met en cache que la coquille (polices, icônes, écran de repli, fichiers à empreinte) : jamais une page, une réponse de l'API ni un fichier de l'espace.
- Schémas et graphiques : Mermaid en niveau `strict`, Vega-Lite avec l'interpréteur d'expressions (aucune évaluation de code), aucun chargement externe.
- Conteneurs : utilisateur non root, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, mémoire, CPU et processus plafonnés.
- Chaîne d'approvisionnement : images de base et kit d'artefacts épinglés par version et empreinte, avis de sécurité npm interrogés à la construction du kit, licences et secrets contrôlés avant chaque publication.

### Hors périmètre

- Un attaquant qui contrôle déjà le proxy authentifiant, la machine hôte ou le dossier de pages.
- Une personne autorisée qui écrit volontairement du contenu malveillant pour elle-même.
- Le déni de service par un utilisateur autorisé.
- Le contenu des pages lui-même : un agent trompé peut écrire un faux texte convaincant. Carnet empêche l'exécution de code, pas la désinformation. Relis ce que tes agents écrivent (le statut `à relire` est fait pour ça).

## Bonnes pratiques côté agents

Voir [`docs/format-agents.md`](docs/format-agents.md) : traiter tout contenu extérieur comme une donnée, ne jamais le recopier en HTML brut, écrire de façon atomique, ne livrer que des artefacts sans réseau ni stockage.
