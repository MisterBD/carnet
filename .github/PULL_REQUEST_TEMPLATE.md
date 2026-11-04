## Ce que ça change

<!-- Une phrase, puis le pourquoi. Lie l'issue : « Ferme #123 ». -->

## Vérifications

- [ ] Les tests passent (`cd server && npm test`, `cd web && npm run typecheck && npm run build`)
- [ ] Un test couvre le changement (y compris un cas refusé pour la sécurité)
- [ ] La fidélité Markdown est intacte (le fichier ne change que là où la personne a écrit)
- [ ] Aucune ressource externe, aucun code repris d'un projet GPL, AGPL, BSL ou propriétaire
- [ ] Si du code est repris d'un projet permissif ou MPL : son en-tête est conservé et `THIRD_PARTY_NOTICES.md` est à jour
- [ ] La documentation (`README.md`, `docs/`) est mise à jour si le comportement change

## Sécurité

<!-- Chaque pull request reçoit une revue de sécurité avant fusion (voir CONTRIBUTING.md). Aide-la en cochant ce qui s'applique. -->

- [ ] Aucune dépendance ajoutée ni mise à jour (sinon : laquelle, pourquoi, sa licence)
- [ ] Aucune nouvelle sortie réseau, aucune ressource externe
- [ ] Ne touche ni à la CSP, ni au confinement des chemins, ni à l'anti-CSRF, ni à l'identité (sinon : issue liée et tests négatifs)
- [ ] Ne touche ni à `Dockerfile`, `compose.yml`, `scripts/` ou `.github/` (sinon : expliqué ci-dessus)
- [ ] Aucun secret, jeton ou donnée personnelle dans le code, les tests ou les captures
