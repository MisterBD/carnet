---
type: fixture
description: Base de démonstration (lot 2) sur le dossier « Base exemple », valeurs limites comprises.
---
# Base exemple

```base
filters:
  and:
    - file.inFolder("Démo/V3/Base exemple")
views:
  - type: table
    name: Tableau
    order:
      - file.name
      - statut
      - priorite
      - echeance
      - montant
      - fait
      - reference
    sort:
      - property: echeance
        direction: ASC
carnet:
  proprietes:
    statut: {type: selection, options: [à faire, en cours, fait]}
    priorite: {type: selection, options: [haute, moyenne, basse]}
    echeance: {type: date}
    montant: {type: nombre}
    fait: {type: case}
    reference: {type: texte}
```
