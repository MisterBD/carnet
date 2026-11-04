---
icon: 📋
resume: "Base des tâches de la Fête du vélo : une page par tâche, avec statut, priorité, échéance et responsable."
---
# Tâches de la fête

Les tâches de la [[Projets/Fête du vélo]], une page par tâche (dossier « Tâches de la fête » sous cette page). Le tableau se met à jour tout seul quand une page change ; un clic sur une cellule modifie la propriété dans le fichier.

```base
filters:
  and:
    - file.inFolder("Tâches de la fête")   # seulement les pages de ce dossier
properties:
  file.name:
    displayName: Tâche
  statut:
    displayName: Statut
  priorite:
    displayName: Priorité
  echeance:
    displayName: Échéance
  responsable:
    displayName: Responsable
views:
  - type: table
    name: À faire
    filters:
      and:
        - 'statut != "Terminé"'
    order:
      - file.name
      - priorite
      - statut
      - echeance
      - responsable
    sort:
      - property: echeance
        direction: ASC
  - type: table
    name: Cette semaine
    filters:
      and:
        - 'statut != "Terminé"'
        - 'echeance <= today() + "7d"'
    order:
      - file.name
      - statut
      - echeance
      - responsable
    sort:
      - property: echeance
        direction: ASC
  - type: table
    name: Tout
    order:
      - file.name
      - statut
      - echeance
      - priorite
      - responsable
carnet:
  dossier: Tâches de la fête
  proprietes:
    statut:
      type: statut
      options: [À faire, En cours, Terminé]
    priorite:
      type: selection
      options: [Haute, Moyenne, Basse]
    echeance:
      type: date
    responsable:
      type: selection
      options: [Camille, Inès, Noé, Yasmine]
  nouvelle:
    statut: À faire
```

Les tâches terminées restent dans le dossier : la vue « Tout » les montre.
