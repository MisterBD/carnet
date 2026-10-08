# Déploiement

Carnet tourne dans deux conteneurs Docker : `carnet` (l'application) et `artefacts` (le serveur d'artefacts isolés). Ce document couvre le démarrage, la configuration, et trois façons de l'ouvrir à tes appareils **sans jamais l'exposer sans authentification**.

> [!IMPORTANT]
> Carnet n'a pas de mot de passe : il fait confiance à un **proxy qui authentifie** devant lui. Les ports `3020` et `3006` ne sont publiés que sur `127.0.0.1`. Ne les ouvre jamais sur Internet, ne mets jamais `CARNET_DEV=1` derrière un proxy, et n'active jamais Tailscale Funnel pour Carnet.

## Prérequis

- Docker avec le plugin Compose (v2), git.
- Environ 500 Mo de disque pour les images, 320 Mo de mémoire au plus pour les deux conteneurs (plafonds de `compose.yml`).
- Un accès réseau à la construction (registre npm pour l'interface et pour le kit d'artefacts, dont les empreintes sont vérifiées).

## Démarrage rapide (essai en local)

```bash
git clone https://github.com/MisterBD/carnet.git
cd carnet
./scripts/initialiser.sh          # crée .env, la clé de signature (chmod 600) et le dossier d'état
docker compose up -d --build
```

Ouvre <http://127.0.0.1:3020>. Tu arrives dans l'espace de démonstration (`./demo`). `initialiser.sh` met `CARNET_DEV=1` dans `.env` : ce mode accepte les requêtes sans identité et **n'est fait que pour l'essai local** (le serveur le refuse dès qu'une origine non locale est déclarée).

Arrêter : `docker compose down`. Voir les journaux (méthode, route, statut, durée, identité ; jamais de contenu) : `docker compose logs -f carnet`.

## Utiliser tes propres pages

Carnet lit un dossier de fichiers `.md`. Dans `.env` :

```bash
CARNET_ESPACE_HOTE=/chemin/vers/mes/notes
CARNET_NOM_ESPACE=mes-notes
CARNET_PRENOM=Camille
```

puis `docker compose up -d`. Le dossier doit appartenir à l'utilisateur renseigné par `CARNET_UID` et `CARNET_GID` (ceux de la personne qui a lancé `initialiser.sh`). Les artefacts sont lus dans le sous-dossier `artefacts/` de ce dossier. Pour que tes agents y écrivent au bon format, donne-leur [format-agents.md](format-agents.md).

Carnet ajoute deux choses dans ton dossier, toutes deux cachées : `.carnet/ordre.json` (le rangement manuel de l'arbre, créé au premier glisser-déposer) et `.corbeille/` (les pages supprimées). Si ton dossier est sous git, tu peux les versionner ou les ignorer, au choix.

### Masquer des dossiers

`CARNET_MASQUES=prive brouillons` : ces dossiers de **premier niveau** ne sont jamais lus, listés, cherchés ni servis (un dossier du même nom plus profond n'est pas concerné). Les dossiers et fichiers cachés (`.git`, `.corbeille`, `.carnet`, `.env`…) et le dossier `artefacts/` (comme pages) le sont toujours, sans réglage. Sers-t'en pour un dossier que tes agents remplissent de données brutes (journaux de session, exports) qui n'ont rien à faire dans une interface.

## Configuration

Les réglages vont dans `.env` (modèle : `.env.example`). Le fichier n'est jamais versionné et ne contient aucun secret : la clé de signature est dans `secrets/art-hmac.key`.

### Réglages de Compose

| Variable | Défaut | Rôle |
|---|---|---|
| `CARNET_UID`, `CARNET_GID` | 1000, 1000 | utilisateur des conteneurs : propriétaire du dossier de pages et de la clé |
| `CARNET_ESPACE_HOTE` | `./demo` | dossier de pages monté dans le conteneur |
| `CARNET_PORT_HOTE`, `ART_PORT_HOTE` | 3020, 3006 | ports publiés sur `127.0.0.1` |
| `CARNET_ART_BASE` | `http://127.0.0.1:3006` | origine par défaut du serveur d'artefacts (hôte non reconnu) |
| `TZ` | `Europe/Paris` | fuseau horaire (dates « il y a… », corbeille, instantanés) |

`compose.yml` transmet au conteneur les variables de Carnet ci-dessous qui ont un sens dans `.env` ; les autres (`CARNET_ESPACE`, `CARNET_PORT`, `CARNET_HOTE`, `CARNET_STATIQUE`, `CARNET_CLE`, `CARNET_ETAT`) sont fixées par `compose.yml` lui-même.

### Réglages de Carnet (service `carnet`)

Toutes les variables lues par le serveur (`server/src/config.ts`, plus `CARNET_JOURNAL` dans `server/src/http.ts`). Une valeur invalide empêche le démarrage, avec un message qui dit laquelle.

| Variable | Défaut | Rôle |
|---|---|---|
| `CARNET_ESPACE` | (obligatoire) | dossier des pages (dans le conteneur : `/espace`) |
| `CARNET_NOM_ESPACE` | nom du dossier | nom affiché ; sert aussi à ranger les instantanés de cet espace |
| `CARNET_PRENOM` | vide | prénom affiché à l'accueil (« Bonjour, Camille ») ; sert de mention par défaut |
| `CARNET_MENTIONS` | `@` + premier mot du prénom, en minuscules et sans accents | mentions qui placent une page dans « À relire », séparées par des espaces (`@camille @relecture`) ; une valeur vide n'en garde aucune |
| `CARNET_MASQUES` | vide | dossiers de premier niveau jamais lus, listés ni servis, séparés par des espaces |
| `CARNET_UTILISATEURS_AUTORISES` | vide | **comptes autorisés** (login ou e-mail posé par le proxy), séparés par des espaces. Obligatoire hors `CARNET_DEV=1` : le serveur refuse de démarrer sans. Ancien nom accepté : `CARNET_UTILISATEURS` |
| `CARNET_ENTETE_IDENTITE` | `Tailscale-User-Login` | en-tête qui porte le login |
| `CARNET_ENTETE_NOM` | `Tailscale-User-Name` | en-tête qui porte le nom affiché (facultatif) |
| `CARNET_ORIGINES_ARTEFACTS` | `http://127.0.0.1:<port>` et `http://localhost:<port>` → `http://127.0.0.1:3006` | table `origine_application=origine_artefacts`, séparée par des espaces. Ancien nom accepté : `CARNET_ORIGINES` |
| `CARNET_DEV` | 0 | 1 : requêtes sans identité acceptées. Essai local seulement, refusé si une origine n'est pas locale |
| `CARNET_CLE` | vide (signature coupée) | fichier de la clé de signature des liens d'artefacts (64 caractères hexadécimaux) |
| `CARNET_ART_TTL` | 900 | durée de vie d'un lien d'artefact, en secondes (30 à 86400) |
| `CARNET_ETAT` | `~/.local/state/carnet` | dossier d'état, **hors** des pages : favoris et instantanés de l'historique |
| `CARNET_CORBEILLE_JOURS` | 30 | jours avant l'effacement automatique d'une page de la corbeille (0 : jamais) |
| `CARNET_GIT` | `auto` | historique git : `auto` (le dépôt qui contient le dossier de pages), `non`, ou chemin absolu d'un dossier git (voir plus bas) |
| `CARNET_GIT_PREFIXE` | vide | chemin du dossier de pages dans le dépôt, quand `CARNET_GIT` est un chemin (`notes`) |
| `CARNET_RESEAU` | vide | nom du réseau privé à allumer, cité par l'écran hors ligne (« Tailscale est-il allumé ? ») ; vide : texte générique |
| `CARNET_CONTACT` | vide | qui prévenir quand le serveur répond mal (« dis-le à Camille ») ; vide : « la personne qui gère ton Carnet » |
| `CARNET_PORT`, `CARNET_HOTE` | 3020, 127.0.0.1 | écoute (dans le conteneur : `0.0.0.0`, port publié sur `127.0.0.1`) |
| `CARNET_STATIQUE` | `web/dist` du dépôt | dossier du build de l'interface |
| `CARNET_MAX_SSE` | 20 | connexions d'événements en direct simultanées (1 à 1000) |
| `CARNET_REBALAYAGE_MS` | 60000 | rebalayage de sécurité du dossier (1 s à 1 h) |
| `CARNET_REGROUPEMENT_MS` | 120 | regroupement des événements du disque avant l'envoi en direct |
| `CARNET_PING_MS` | 20000 | battement du flux en direct |
| `CARNET_JOURNAL` | 1 | 0 coupe le journal |

### Réglages du serveur d'artefacts (service `artefacts`)

| Variable | Défaut | Rôle |
|---|---|---|
| `ART_PUBLIC_BASE` | (obligatoire) | origine publique par défaut des artefacts |
| `ART_ORIGINES` | vide | même table que `CARNET_ORIGINES_ARTEFACTS` (Compose la lui passe ; `CARNET_ORIGINES_ARTEFACTS` est aussi acceptée si `ART_ORIGINES` est absente) |
| `APP_ORIGINS` | vide | origines supplémentaires autorisées à embarquer un artefact (`frame-ancestors`) ; facultatif quand la table est renseignée |
| `ART_TTL` | 900 | durée des liens signés, en secondes (30 à 86400) |
| `ART_ROOT` | `/data/artefacts` | dossier des artefacts (lecture seule) |
| `KIT_ROOT` | `/kit` | dossier du kit construit par `maj-kit.py` |
| `ART_HMAC_KEY_FILE` | `/run/secrets/art-hmac.key` | clé de signature, la même que `CARNET_CLE` |
| `ART_LISTEN_HOST`, `ART_LISTEN_PORT` | `0.0.0.0`, 3006 | écoute. **Hors conteneur, mets `127.0.0.1`** |
| `ART_MAX_FILE` | 5 Mio | taille maximale d'un fichier d'artefact |
| `ART_MAX_CONN` | 96 | connexions simultanées |
| `ART_ATTENTE_PLACE` | 10 | secondes d'attente d'une place quand toutes les connexions sont prises, avant un `503` |
| `ART_REFUSE_SIGN_ON_PUBLIC_HOST` | 1 | refuse la signature de liens sur le nom d'hôte public des artefacts |
| `RENDU_ROOT` | `rendu/` à côté de `art.py` | pages de rendu isolées Mermaid et Vega-Lite |

## Historique des versions et git

L'écran « Historique des versions » (menu « … » d'une page) réunit deux sources :

- **les instantanés**, toujours disponibles : des copies prises à la main (« Prendre un instantané ») ou automatiquement avant une restauration, rangées dans `CARNET_ETAT/instantanes/`, hors de tes pages ;
- **les versions git**, si le dossier de pages est dans un dépôt git **et** si la commande `git` est installée là où tourne le serveur. Carnet ne fait que lire (`git log` et `git cat-file`), sans shell, et ne crée jamais de commit : versionner le dossier reste ton affaire ou celle de tes agents (un commit par intention).

L'image Docker fournie embarque `git` (paquet Alpine épinglé). Hors Docker (voir plus bas), git est utilisé dès qu'il est installé. Sans dépôt git visible, l'écran affiche « Pas de sauvegarde git ici : seuls tes instantanés sont gardés. »

Trois cas :

| Ton dossier de pages | Réglage |
|---|---|
| est lui-même la racine d'un dépôt (il contient `.git/`) | rien : `CARNET_GIT=auto` le trouve |
| est un sous-dossier d'un dépôt dont la racine n'est pas visible par Carnet (cas du conteneur, qui ne voit que le dossier monté) | monte le dossier `.git` du dépôt **en lecture seule** hors de l'espace, puis `CARNET_GIT=/chemin/du/depot.git` et `CARNET_GIT_PREFIXE=chemin/du/dossier/dans/le/depot` |
| n'est pas sous git, ou tu ne veux pas de l'historique git | `CARNET_GIT=non` (ou rien : sans dépôt, git est simplement ignoré) |

Le dépôt doit appartenir à l'utilisateur qui fait tourner Carnet : git refuse un dépôt dont le propriétaire est un autre utilisateur, et Carnet ignore toute configuration git système ou globale (donc tout `safe.directory`). Si l'historique git reste vide, le journal de démarrage contient une ligne `historique_git` avec la raison.

## Sans Docker

Pour développer, ou sur une machine sans Docker : Node 22.18 ou plus, Python 3.12, et les mêmes réglages en variables d'environnement.

```bash
./scripts/initialiser.sh                                  # clé de signature (chmod 600) et dossier d'état
(cd web && npm ci && npm run build)                       # construit web/dist
(cd server && npm ci --omit=dev)
(cd artefacts && python3 maj-kit.py)                      # construit artefacts/kit (empreintes vérifiées)

ART_LISTEN_HOST=127.0.0.1 ART_PUBLIC_BASE=http://127.0.0.1:3006 \
ART_ORIGINES="http://127.0.0.1:3020=http://127.0.0.1:3006" ART_ROOT=demo/artefacts \
KIT_ROOT=artefacts/kit ART_HMAC_KEY_FILE=secrets/art-hmac.key python3 artefacts/app/art.py &

CARNET_ESPACE=demo CARNET_DEV=1 CARNET_CLE=secrets/art-hmac.key CARNET_ETAT=.etat CARNET_PRENOM=Camille \
node server/src/main.ts
```

Ouvre <http://127.0.0.1:3020>. Les deux processus écoutent sur `127.0.0.1` seulement ; les mêmes règles d'exposition s'appliquent (un proxy authentifiant devant, `CARNET_DEV` à 0 et une liste de comptes dès que ce n'est plus un essai local).

## Trois façons de l'ouvrir à tes appareils

Dans les trois cas, **l'application et les artefacts doivent avoir deux origines différentes** (deux noms d'hôte, ou le même nom avec deux ports) : c'est ce qui isole le code des artefacts de tes pages. La table `CARNET_ORIGINES_ARTEFACTS` associe l'origine de l'application à celle de ses artefacts.

### 1. Tailscale Serve (le plus simple)

`tailscale serve` publie les ports locaux sur ton réseau privé (tailnet), en HTTPS, et **pose l'identité** de la personne connectée dans l'en-tête `Tailscale-User-Login`, en écrasant tout en-tête forgé par le client. Rien n'est exposé sur Internet.

```bash
tailscale serve --bg --https=443  http://127.0.0.1:3020   # l'application
tailscale serve --bg --https=8443 http://127.0.0.1:3006   # les artefacts, autre origine (autre port)
```

Dans `.env` (remplace `ma-machine.mon-reseau.ts.net` par le nom de ta machine) :

```bash
CARNET_DEV=0
CARNET_UTILISATEURS_AUTORISES=toi@exemple.com
CARNET_ORIGINES_ARTEFACTS=https://ma-machine.mon-reseau.ts.net=https://ma-machine.mon-reseau.ts.net:8443
CARNET_ART_BASE=https://ma-machine.mon-reseau.ts.net:8443
```

Puis `docker compose up -d`. Sur un téléphone : ouvre l'adresse dans le navigateur, puis « Sur l'écran d'accueil » pour l'installer. Le login est ton adresse de connexion Tailscale, à copier de `tailscale status` ou de la console d'administration. **N'utilise pas Tailscale Funnel** : il expose sur Internet et ne pose pas d'identité.

### 2. Reverse proxy + Authelia (Caddy)

Un nom d'hôte pour l'application, un autre pour les artefacts. L'application est derrière l'authentification ; l'hôte des artefacts n'expose que les chemins à jeton (le jeton, signé et valable 15 minutes, tient lieu de session, parce qu'un cadre intégré ne reçoit pas toujours les cookies d'un autre domaine). Le Caddy tourne sur la machine (sinon, remplace `127.0.0.1` par l'adresse de l'hôte Docker).

```caddyfile
carnet.exemple.org {
	encode zstd gzip
	route {
		# Jamais d'identité venue du client : on efface ces en-têtes AVANT l'authentification.
		request_header -Remote-User
		request_header -Remote-Name
		request_header -Remote-Email
		request_header -Remote-Groups
		forward_auth authelia:9091 {
			uri /api/authz/forward-auth
			copy_headers Remote-User Remote-Name Remote-Email Remote-Groups
		}
		reverse_proxy 127.0.0.1:3020
	}
}

# Serveur d'artefacts : AUTRE nom d'hôte. Seuls les chemins à jeton, le kit et les pages de rendu sont exposés.
art.exemple.org {
	encode zstd gzip
	@permis path /a/* /kit/* /rendu/* /sante
	handle @permis {
		reverse_proxy 127.0.0.1:3006
	}
	handle {
		respond "Introuvable" 404
	}
}
```

```bash
CARNET_DEV=0
CARNET_ENTETE_IDENTITE=Remote-Email
CARNET_ENTETE_NOM=Remote-Name
CARNET_UTILISATEURS_AUTORISES=toi@exemple.org
CARNET_ORIGINES_ARTEFACTS=https://carnet.exemple.org=https://art.exemple.org
CARNET_ART_BASE=https://art.exemple.org
```

### 3. Reverse proxy + oauth2-proxy (Caddy)

Même principe avec [oauth2-proxy](https://oauth2-proxy.github.io/oauth2-proxy/) (Google, GitHub, un fournisseur OIDC…), qui écoute ici sur `127.0.0.1:4180`. Le bloc des artefacts est identique au précédent.

```caddyfile
carnet.exemple.org {
	encode zstd gzip
	handle /oauth2/* {
		reverse_proxy 127.0.0.1:4180
	}
	handle {
		route {
			request_header -X-Auth-Request-Email
			request_header -X-Auth-Request-User
			forward_auth 127.0.0.1:4180 {
				uri /oauth2/auth
				copy_headers X-Auth-Request-Email X-Auth-Request-User
				@error status 401
				handle_response @error {
					redir * /oauth2/sign_in?rd={scheme}://{host}{uri}
				}
			}
			reverse_proxy 127.0.0.1:3020
		}
	}
}
```

```bash
CARNET_ENTETE_IDENTITE=X-Auth-Request-Email
CARNET_UTILISATEURS_AUTORISES=toi@exemple.org
```

### Règles à respecter avec n'importe quel proxy

1. Le proxy **efface** l'en-tête d'identité reçu du client avant de poser le sien (`request_header -…` ci-dessus, ou le comportement de `tailscale serve`). Sinon n'importe qui peut se faire passer pour toi.
2. Le proxy est la **seule porte** : Carnet n'écoute que sur `127.0.0.1`, le pare-feu bloque le reste.
3. Les artefacts sont sur **une autre origine** que l'application, et le proxy n'expose pas `/_art/` sur leur nom d'hôte.
4. Le proxy sert en HTTPS.

## Opérations

**Sauvegarde.** Tes pages sont des fichiers : sauvegarde le dossier (`rsync`, git, instantané du disque). Il contient aussi le rangement de l'arbre (`.carnet/ordre.json`) et la corbeille (`.corbeille/`). Le dossier d'état (`.etat/` en Docker, `CARNET_ETAT` sinon) garde les favoris et les instantanés de l'historique : sauvegarde-le aussi si tu y tiens. Mets le dossier de pages sous git pour garder l'historique complet : tes agents peuvent y faire un commit par intention.

**Corbeille.** Une page supprimée y reste `CARNET_CORBEILLE_JOURS` jours (30 par défaut), puis elle est effacée (vérification au démarrage, puis toutes les 24 heures). La page **Corbeille** de l'interface permet de restaurer, d'effacer un élément ou de tout vider.

**Mise à jour.** `git pull && docker compose up -d --build`. Relis `THIRD_PARTY_NOTICES.md` et le journal des changements. Les images de base sont épinglées par version et empreinte dans les `Dockerfile` : leur mise à jour est une modification de fichier, à relire.

**Kit d'artefacts.** Il est reconstruit à la construction de l'image (versions épinglées, empreintes sha512 vérifiées, avis de sécurité interrogés). Pour comparer aux dernières versions : `cd artefacts && ./maj-kit.sh --etat`.

**Rotation de la clé.** Remplace le contenu de `secrets/art-hmac.key` (64 caractères hexadécimaux) : elle est relue sans redémarrage et tous les liens en cours deviennent invalides.

**Durcissement déjà en place.** Utilisateur non root, système de fichiers en lecture seule, `cap_drop: ALL`, `no-new-privileges`, mémoire, CPU et processus plafonnés, réseaux Docker distincts, ports sur `127.0.0.1` seulement, images épinglées.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `403 Accès réservé : identité absente` | le proxy ne pose pas l'en-tête (`CARNET_ENTETE_IDENTITE` ne correspond pas) ou `CARNET_DEV` est à 0 en accès direct |
| `403 Accès refusé pour ce compte` | le login posé par le proxy n'est pas dans `CARNET_UTILISATEURS_AUTORISES` |
| `421` | le `Host` reçu n'est pas dans la table `CARNET_ORIGINES_ARTEFACTS` |
| le serveur refuse de démarrer avec `CARNET_DEV=1` | une origine non locale est déclarée : retire `CARNET_DEV` ou l'origine |
| schémas, graphiques ou artefacts vides | l'origine des artefacts est absente de la table, ou identique à celle de l'application, ou injoignable depuis ton navigateur |
| `Permission denied` à l'écriture | le dossier de pages n'appartient pas à `CARNET_UID`:`CARNET_GID` |
| la construction de l'image des artefacts échoue | registre npm injoignable, ou avis de sécurité sur une version épinglée (le message le dit) |
| l'historique dit « Pas de sauvegarde git ici » | pas de commande `git` (installation hors Docker), dossier hors d'un dépôt, dépôt invisible pour le conteneur (voir `CARNET_GIT`), ou dépôt appartenant à un autre utilisateur ; la ligne `historique_git` du journal donne la raison |
| l'écran hors ligne parle d'un réseau qui n'est pas le tien | `CARNET_RESEAU` ; il est retenu par le navigateur au dernier démarrage réussi |
