# Contribuer à Carnet

Merci de l'intérêt ! Carnet est un petit projet, maintenu par une personne, avec une idée directrice : **un Notion maison, libre, où les agents IA écrivent en Markdown**, sur des fichiers qui restent la vérité. Les contributions qui servent cette idée sont les bienvenues.

Le projet, son interface et sa documentation sont **en français**. Les issues et les pull requests sont acceptées en français ou en anglais.

## Avant de commencer

- Un bug : ouvre une issue avec le modèle « Bug » (version, étapes, ce que tu attendais).
- Une idée ou une fonctionnalité : ouvre d'abord une issue avec le modèle « Idée », avant d'écrire du code. Le périmètre est volontairement étroit (voir plus bas), on évite à chacun un travail inutile.
- Une faille de sécurité : **pas d'issue publique**, voir [SECURITY.md](SECURITY.md).

## Mettre en route le développement

Prérequis : Node 22.18 ou plus (le serveur exécute TypeScript directement), Python 3.12, Docker pour l'essai complet.

```bash
# Serveur : une dépendance (yaml), tests avec node --test (169 tests, dont 1 ignoré sans vrai serveur d'artefacts ;
# les tests de l'historique ont besoin de git)
cd server && npm ci && npm test

# Interface : typage puis construction ; service worker : 11 tests sans navigateur
cd web && npm ci && npm run typecheck && npm run build
node --test outils-pwa/sw.test.mjs

# Serveur d'artefacts : bibliothèque standard seulement (22 tests)
cd artefacts/tests && python3 -m unittest test_unitaires -v
```

Pour essayer l'ensemble avec l'espace de démonstration, suis le démarrage rapide du [README](README.md), ou la section « Sans Docker » de [docs/deploiement.md](docs/deploiement.md). Pour travailler sur l'interface avec rechargement à chaud : `cd web && npm run dev`, avec un serveur lancé en mode développement local (`CARNET_DEV=1`).

### Recette de bout en bout

`tests/recette.py` (Playwright, `pip install playwright` puis `playwright install chromium`) parcourt l'interface comme une personne : arbre, menu `/`, sous-page, écriture, case à cocher, image, schémas, artefact, mise à jour en direct, conflit, recherche, glisser-déposer, renommer, corbeille, Projets, et vérifie à chaque fois le **fichier** sur le disque. Elle crée ses pages dans un dossier `Recette/` de l'espace et le retire à la fin. Lance-la sur une **copie** de l'espace de démonstration, jamais sur tes vraies notes.

La recette envoie une identité (`--login`, par défaut `ami@exemple.test`) : le Carnet visé doit l'avoir dans sa liste, même en mode développement, sinon tout répond `403`.

```bash
cp -r demo /tmp/demo-recette
# Carnet lancé sur cette copie avec CARNET_UTILISATEURS_AUTORISES=ami@exemple.test (et CARNET_DEV=1 en local),
# le serveur d'artefacts sur ses artefacts/ (voir « Sans Docker » dans docs/deploiement.md), puis :
python3 tests/recette.py --navigateur chromium --base http://127.0.0.1:3020 --art http://127.0.0.1:3006 --espace /tmp/demo-recette

# WebKit (le moteur de Safari), sans sudo, dans le conteneur officiel de Playwright :
ESPACE=/tmp/demo-recette tests/recette-webkit.sh --base http://127.0.0.1:3020 --art http://127.0.0.1:3006
```

Toute modification de l'éditeur repasse aussi le banc de fidélité : `(cd web && npx vite build --mode outils)` puis `python3 tests/fidelite.py demo=demo`.

## Ce qu'on attend d'une contribution

1. **Des tests.** Un correctif de bug vient avec le test qui l'aurait attrapé. Une fonctionnalité du serveur vient avec ses tests ; une fonctionnalité de l'interface avec son étape de recette quand elle touche au parcours de la personne.
2. **La fidélité Markdown reste intacte.** Quand une personne modifie un bloc, seul ce bloc change dans le fichier ; une page ouverte sans modification n'est jamais réécrite. Toute modification de l'éditeur doit repasser le banc de fidélité (`tests/fidelite.py`). Une nouvelle écriture Markdown (comme les couleurs ou le bloc repliable) entre dans la grammaire fermée de `web/src/editeur/markdown/` : une forme exacte, des valeurs en liste blanche, lisible ailleurs, réécrite à l'octet.
3. **Un changement, une pull request.** Petite, avec un message qui explique le pourquoi. Le message de commit décrit l'intention (« Corbeille : purge après 30 jours »), en français ou en anglais.
4. **Code lisible.** Les commentaires expliquent le *pourquoi*, en français. Pas de dépendance ajoutée sans en parler d'abord dans l'issue : le serveur n'en a qu'une, c'est voulu.
5. **Accessibilité et mobile.** L'interface est pensée pour le téléphone d'abord : cibles tactiles d'au moins 44 px, contraste AA, clavier utilisable, thèmes clair et sombre.

## Règles de sécurité (non négociables)

- Rien d'exécutable sur l'origine de l'application : aucun HTML de page interprété, aucun `.html`, `.svg`, `.js`, `.css`, `.xml` servi par l'application. Le code vit dans les artefacts, sur une autre origine.
- On **n'assouplit jamais** la CSP, le confinement des chemins, l'anti-CSRF ni le contrôle d'identité sans discussion préalable dans une issue. `style-src 'unsafe-inline'` est la seule concession actuelle et n'est pas à étendre.
- **Aucune ressource externe** : ni CDN, ni police distante, ni télémétrie, ni appel réseau sortant du serveur. Tout est servi localement.
- Un changement dans `server/src/securite.ts`, `server/src/art.ts` ou `artefacts/app/art.py` doit être accompagné de tests, y compris négatifs (le chemin piégé doit toujours être refusé).

## Revue de sécurité de chaque pull request

Carnet affiche des pages écrites par des agents qui lisent des contenus non fiables : une faille y coûte cher. **Chaque pull request reçoit une revue de sécurité avant d'être fusionnée**, sans exception, y compris les mises à jour de dépendances proposées par Dependabot et les changements qui ne touchent que la documentation.

- La branche `main` est protégée : on n'y entre que par une pull request, avec la CI verte et l'approbation du mainteneur. Les fusions se font en *squash*.
- Pour une première contribution, la CI ne démarre qu'après l'accord du mainteneur (règle de GitHub pour les contributions venues d'un fork).
- La revue regarde au minimum :
  - les secrets ;
  - les dépendances ajoutées ou changées (licence, provenance, scripts d'installation, fichiers de verrouillage) ;
  - toute nouvelle sortie réseau ou ressource externe ;
  - la CSP, le confinement des chemins, l'anti-CSRF et le contrôle d'identité ;
  - le rendu du contenu des pages (rien ne doit devenir exécutable) ;
  - les fichiers `Dockerfile`, `compose.yml`, `scripts/` et `.github/` ;
  - les tests négatifs.
- Le code d'une pull request n'est jamais exécuté hors de la CI de GitHub ou d'un bac à sable isolé (conteneur sans réseau ni secret).
- La revue est écrite sur la pull request. Une remarque de sécurité se règle avant la fusion, jamais « dans une prochaine PR ».

Les petites pull requests, centrées sur un seul sujet, sont revues bien plus vite.

## Licences : la règle la plus stricte du projet

Carnet est sous [licence MIT](LICENSE). Pour que ça reste vrai :

- **Ne copie jamais de code** (ni de texte, ni d'icône) depuis un projet sous **GPL, AGPL, LGPL, BSL, SSPL** ou une licence propriétaire. Pas même un petit extrait.
- Les projets sous AGPL ou BSL (Docmost, Outline, AppFlowy…) sont étudiés en **salle blanche** : on décrit leurs comportements avec nos propres mots, et le code s'écrit à partir de cette description, jamais de leurs sources. Si tu as lu leur code, ne reproduis pas leur implémentation : propose un comportement à la place.
- Le code sous licence **permissive** (MIT, BSD, Apache-2.0, ISC) ou MPL-2.0 peut être repris, à condition de **garder son en-tête de copyright**, d'ajouter une ligne dans [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) (fichier, origine, licence, copyright, modifications) et de signaler les modifications. Un fichier MPL-2.0 repris reste sous MPL-2.0.
- Pour les **dépendances** : MIT, ISC, BSD, Apache-2.0 ou équivalent. Les paquets payants (Tiptap « Pro », BlockNote `xl-*`) sont exclus.
- En contribuant, tu acceptes que ta contribution soit publiée sous la licence MIT du projet.

## Périmètre : ce que Carnet ne sera pas

Pour rester simple, sûr et rapide, Carnet n'ambitionne pas :

- la collaboration en temps réel à plusieurs curseurs (une personne, ou un petit cercle de confiance) ;
- une base de données, un format de stockage autre que Markdown, un service externe obligatoire ;
- la gestion de comptes et de mots de passe (l'identité vient d'un proxy authentifiant) ;
- l'exécution de code dans les pages (c'est le rôle, isolé, des artefacts).

Si ton idée sort de ce cadre, elle trouvera peut-être sa place dans un projet voisin : n'hésite pas à forker.

## Code de conduite

Sois aimable, précis et patient. On discute des idées, pas des personnes. Les échanges irrespectueux, le harcèlement et les attaques personnelles n'ont pas leur place ici ; les mainteneurs peuvent modérer ou fermer une discussion.
