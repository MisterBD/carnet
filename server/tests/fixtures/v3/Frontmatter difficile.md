---
# En-tête volontairement difficile : commentaires, multilignes, clés inconnues.
title: Frontmatter difficile
reference: "00123"
code_brut: 00123
compteur: 0
actif: false
responsable: null
vide:
texte_vide: ""
tags:
  - fixture
  - socle # commentaire dans la liste
liste_flux: [un, deux, "trois, quatre"]
liste_colonne0:
- a
- b
resume: |
  Première ligne du résumé.
  Deuxième ligne, avec des « guillemets ».
plie: >
  Texte plié
  sur deux lignes.
echeance: 2026-10-12
cree: 2026-10-11T08:12:03+02:00
cle_inconnue_agent: {source: agent, version: 3}   # objet imbriqué : non modifiable par Carnet
"clé citée": valeur
statut:    en cours   # espaces conservés
maj_par: Lina
---
# Frontmatter difficile

Le corps ne doit jamais changer quand une propriété change.
