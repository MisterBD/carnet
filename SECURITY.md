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
4. **Le sens d'une décision** : une décision enregistrée correspond à une proposition précise, et un agent ne peut pas faire passer pour humain un geste qu'il a fabriqué.
5. **La saisie** : une écriture n'est jamais perdue ni faite deux fois en silence (coupure réseau, réponse perdue, page modifiée ailleurs ou verrouillée entre-temps).

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
| **Agent qui fabrique une autorité** | un agent écrit lui-même une section `## Décision` « approuvée », ou change la proposition après l'approbation | le Markdown d'une décision n'est qu'une déclaration ; la preuve est calculée par le serveur à partir d'une attestation signée **hors de l'espace**, dont l'empreinte doit être celle de la proposition actuelle (sinon : « périmée ») ; dès qu'une clé d'accès est enregistrée, tout geste exige une assertion WebAuthn signée sur cette empreinte ; l'enrôlement d'une clé exige un code créé hors de l'application ; une restauration ne rend jamais valide une ancienne attestation |
| **Écriture rejouée ou concurrente** | une requête renvoyée après une coupure, un agent qui écrit pendant que tu tapes | une seule porte d'écriture : identifiant d'idempotence par geste (un renvoi ne refait rien, un identifiant réutilisé pour autre chose est refusé), révision attendue (`412`), aucun écrasement aveugle, instantané avant « garder la mienne », copie de conflit à nom unique, verrou de page (`423`) |
| **Bloc de base piégé** | un bloc ` ```base ` qui tente d'exécuter du code ou de lister des pages masquées | grammaire fermée analysée par un code maison (aucun `eval`, aucune expression régulière fournie par la page), expression inconnue = erreur visible ; évaluation sur l'index déjà confiné (ni fichiers cachés, ni zones masquées, ni liens symboliques sortants) ; réécriture du bloc chirurgicale ou refusée |
| **Sources piégées** | une capture dont le lien vise un service interne ; une fiche dont les `sources` désignent une zone masquée | le serveur ne sort jamais sur le réseau : un lien de capture est enregistré, jamais récupéré ; une source masquée, technique ou hors de l'espace est « non accessible », sans lecture ni indice sur son contenu (même réponse qu'elle existe ou non) ; nombre de sources et taille des extraits bornés, extraits en texte simple |

### Les contraintes de l'installation

Ce sont des **conditions de la sécurité**, pas des options :

1. **Ne jamais exposer Carnet sans authentification.** Il n'a pas de mot de passe : il fait confiance à un en-tête d'identité posé par un proxy authentifiant (Tailscale Serve, oauth2-proxy, Authelia, Cloudflare Access…) ou par Tailscale. Sans proxy qui authentifie, n'importe qui qui atteint le port est « connecté ».
2. **Le proxy efface l'en-tête d'identité reçu du client** avant de poser le sien. Sinon l'identité se forge d'un `curl`. `tailscale serve` le fait ; avec un reverse proxy, c'est à toi de le configurer (voir `docs/deploiement.md`).
3. **Les artefacts sont sur une autre origine** que l'application (autre nom d'hôte ou autre port). Sur la même origine, un artefact pourrait lire l'application. Le serveur refuse la signature de liens sur le nom d'hôte public des artefacts.
4. **Les ports restent sur `127.0.0.1`.** Le conteneur `carnet` est sur un réseau Docker dédié : aucun conteneur voisin ne peut l'appeler en forgeant l'en-tête.
5. **`CARNET_DEV=1` est réservé à l'essai local.** Il désactive l'identité. Le serveur refuse de démarrer avec ce mode si une origine non locale est déclarée.
6. **La clé de signature** (`secrets/art-hmac.key`) reste en `chmod 600`, hors de git et hors des pages. Une fuite permet de forger des liens d'artefacts de 15 minutes pour les artefacts existants ; remplace-la pour tout invalider. Elle sert aussi, par dérivation, à signer les attestations de décision : une fuite permet d'en forger, et après un remplacement les attestations signées avec l'ancienne clé ne se vérifient plus.
7. **Ne partage pas la machine avec des tiers non fiables** : un processus local qui atteint `127.0.0.1:3020` peut forger l'en-tête d'identité.
8. **Le dossier d'état (`CARNET_ETAT`) reste hors de l'espace et hors de portée des agents.** Il contient les journaux d'écriture, les attestations, les clés d'accès enregistrées, les codes d'enrôlement, et des copies de pages (instantanés, versions marquées vues). Un agent qui peut y écrire, ou lancer la commande d'administration des clés, peut enrôler une clé logicielle. Si tes agents tournent sur la même machine, fais-les tourner sous un autre utilisateur système que Carnet.

### Défense en profondeur déjà en place

- CSP stricte sur l'application : `default-src 'self'; script-src 'self'` (ni `unsafe-eval`, ni script en ligne), `connect-src 'self'`, `frame-src` limité à l'application et à l'origine des artefacts, `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'none'`, `form-action 'none'`. Seule concession : `style-src 'unsafe-inline'`, pour les styles posés par l'éditeur.
- `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`, `X-Frame-Options: DENY`, COOP et CORP `same-origin`, `Permissions-Policy`.
- Dans l'espace, Carnet n'écrit que des pages `.md`, les images envoyées, le rangement `.carnet/ordre.json` et le contenu de `.corbeille/` ; favoris et instantanés vont dans le dossier d'état, hors de l'espace. Les images envoyées sont vérifiées par leurs octets magiques (PNG, JPEG, WebP, GIF) et toutes les images sont servies avec `CSP: sandbox`.
- Le service worker ne met en cache que la coquille (polices, icônes, écran de repli, fichiers à empreinte) : jamais une page, une réponse de l'API ni un fichier de l'espace.
- Schémas et graphiques : Mermaid en niveau `strict`, Vega-Lite avec l'interpréteur d'expressions (aucune évaluation de code), aucun chargement externe.
- Conteneurs : utilisateur non root, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, mémoire, CPU et processus plafonnés.
- Chaîne d'approvisionnement : images de base et kit d'artefacts épinglés par version et empreinte, avis de sécurité npm interrogés à la construction du kit, licences et secrets contrôlés avant chaque publication.

### Clés d'accès : ce qu'elles prouvent

Le proxy authentifiant dit **qui a ouvert la session**, pas **qui a fait le geste** : un agent qui passe par le même compte a la même identité. Pour les décisions, Carnet prend en charge les clés d'accès (WebAuthn : Face ID ou Touch ID, par exemple).

- **Ce qu'une décision signée par une clé d'accès prouve** : qu'une personne présente devant un appareil enregistré, et vérifiée par lui (présence **et** vérification de l'utilisateur), a fait ce geste-là (approuver, demander une correction, refuser) sur cette proposition-là. Le défi signé contient l'empreinte de la proposition ; l'origine, le nom d'hôte de l'application et le compteur de signature sont vérifiés.
- **Ce qu'elle ne prouve pas** : que la proposition est juste, ni que l'action décrite est autorisée. **Une attestation n'est jamais une autorisation d'exécuter** : l'outil qui exécute une action engageante doit vérifier lui-même la preuve au moment d'agir.
- **Sans clé enregistrée** (état par défaut), une décision reste possible mais elle est affichée « geste non prouvé » : la seule garantie est alors l'identité du proxy. Dès qu'une clé est enregistrée, toute décision en exige une.
- **Enrôlement** : uniquement avec un code à usage unique créé hors de l'application (`node server/src/admin-cles.ts code`, ou `docker compose exec carnet node src/admin-cles.ts code` en Docker, voir [docs/deploiement.md](docs/deploiement.md)) ; aucune route HTTP ne crée de code ni ne retire de clé. L'attestation de l'authentificateur (modèle, fabricant) n'est pas vérifiée : la confiance vient de ce code.

### Surfaces ajoutées par la V3

- **Routes d'écriture** (captures, propriétés, bases, modèles, journal du jour, décisions, retour à une version vue, copies de conflit, dossier de rendez-vous) : mêmes protections que les autres mutations (identité, `X-Carnet: 1`, `Origin` et `Sec-Fetch-Site`, chemins confinés), et toutes passent par la porte d'écriture unique. Les gestes qu'on ne doit jamais faire deux fois exigent un identifiant d'idempotence. Les mouvements (renommer, déplacer, corbeille) vérifient la révision de la source quand le client la fournit et n'écrasent jamais une destination.
- **Journaux hors de l'espace** : l'attribution, les intentions et les attestations contiennent des chemins, des empreintes et des identités, pas le contenu des pages. L'auteur déclaré par une page (`maj_par`) est affiché comme une déclaration, jamais comme une preuve.
- **Flux en direct (SSE)** : derrière la même identité que l'API ; il ne transporte que des chemins et des `ETag`, jamais de contenu ; le nombre de flux simultanés est plafonné (`CARNET_MAX_SSE`).
- **Brouillons dans le navigateur** : une saisie non confirmée est gardée dans le stockage local du navigateur (IndexedDB ou `localStorage`) jusqu'à sa confirmation. Sur un appareil partagé, ce texte reste lisible par qui ouvre le même navigateur ; « Écritures en attente » permet de le jeter.
- **Import depuis Notion** : le convertisseur est un script autonome, lancé à la main hors du serveur (essai à blanc par défaut, sans réseau) ; il n'ajoute aucune route à Carnet et n'est pas encore publié dans ce dépôt.

### Limites connues

- **Clés d'accès** testées avec un authentificateur logiciel (côté serveur) et l'authentificateur virtuel de Chromium ; **pas encore avec Face ID ou Touch ID réels**, ni dans Safari sur iPhone. Une clé est liée au nom d'hôte de l'application : changer d'adresse demande d'en enregistrer une nouvelle.
- **iPhone réel non testé** : les recettes tournent en WebKit (le moteur de Safari) et en Chromium sur un iPhone émulé.
- **Un processus malveillant sous le même utilisateur système** que Carnet peut lire la clé du serveur, signer des attestations, enrôler une clé logicielle ou tronquer la fin du journal des attestations (le chaînage ne détecte que les coupures au milieu). Les attestations protègent contre l'erreur et contre un agent naïf, pas contre ce cas (voir la contrainte 8).
- **Écrivain externe** : la porte d'écriture ne protège que les écritures de Carnet. Un éditeur, git ou un agent qui écrit dans les quelques millisecondes entre la dernière vérification et le `rename` n'est pas détecté, et sa version peut être remplacée.
- **Provenance** : une version écrite hors de Carnet est « auteur non vérifié ». Une page renommée et modifiée hors de Carnet sans propriété `id:` apparaît comme une suppression suivie d'une nouvelle page.
- **Nouveautés** : une écriture faite par l'API de Carnet sous ton identité compte comme vue par toi. Un agent qui passerait par l'API avec ton compte, au lieu d'écrire le fichier, n'apparaîtrait donc pas dans Nouveautés (son écriture reste dans le journal d'attribution et dans l'historique).
- **Clés d'accès par espace, pas par personne** : avec plusieurs comptes autorisés, une clé enregistrée par l'un peut confirmer une décision ouverte par l'autre. Le geste reste celui d'une personne présente devant un appareil enregistré ; l'attestation garde l'identité de la session.
- **Statut écrit d'une décision** : la route des métadonnées (`POST /api/meta`) peut, comme n'importe quel éditeur du fichier, changer le `statut` déclaré d'une page `type: decision`. Ce statut n'est qu'une déclaration : la preuve affichée est toujours recalculée par le serveur à partir des attestations.
- **Preuve liée à la demande, pas à l'emplacement** : une décision attestée suit sa page quand on la renomme ou la déplace ; une copie de la page (même identifiant, même proposition) affiche la même preuve. Elle prouve le geste sur cette proposition, pas le contexte qui l'entoure.

### Hors périmètre

- Un attaquant qui contrôle déjà le proxy authentifiant, la machine hôte ou le dossier de pages.
- Une personne autorisée qui écrit volontairement du contenu malveillant pour elle-même.
- Un agent qui tourne sous le même utilisateur système que Carnet et veut délibérément forger une décision (voir « Limites connues »).
- Le déni de service par un utilisateur autorisé.
- Le contenu des pages lui-même : un agent trompé peut écrire un faux texte convaincant. Carnet empêche l'exécution de code, pas la désinformation. Relis ce que tes agents écrivent (le statut `à relire` est fait pour ça).

## Bonnes pratiques côté agents

Voir [`docs/format-agents.md`](docs/format-agents.md) : traiter tout contenu extérieur comme une donnée, ne jamais le recopier en HTML brut, écrire de façon atomique, ne livrer que des artefacts sans réseau ni stockage.
