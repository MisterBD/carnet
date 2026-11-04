---
icon: 🤝
resume: "Base des partenaires sollicités pour la Fête du vélo : une fiche par commerce ou structure du quartier, avec des vues qui suivent la date du jour."
---
# Partenaires — Prospects

Pour la [[Projets/Fête du vélo]], on sollicite les commerces et les structures du quartier : **un lot pour la tombola**, un coup de main, un prêt de matériel. Une fiche par partenaire, dans le dossier « Partenaires — Prospects » sous cette page.

La vue **À relancer** est **relative à aujourd'hui** : elle montre les fiches dont la prochaine relance tombe aujourd'hui ou avant, sauf celles qui ont déjà dit oui ou non. Elle change toute seule chaque jour, sans que le fichier soit réécrit, et son compteur apparaît sur l'écran **Aujourd'hui**.

```base
filters:
  and:
    - file.inFolder("Partenaires — Prospects")   # seulement les fiches de ce dossier
properties:
  file.name:
    displayName: Partenaire
  statut:
    displayName: Statut
  prochaine_relance:
    displayName: Prochaine relance
  derniere_relance:
    displayName: Dernière relance
  apport:
    displayName: Apport (€)
  suivi_par:
    displayName: Suivi par
views:
  - type: table
    name: À relancer
    filters:
      and:
        - prochaine_relance.date() <= today()
        - 'statut != "Partenaire"'
        - 'statut != "Décliné"'
    order:
      - file.name
      - statut
      - prochaine_relance
      - suivi_par
    sort:
      - property: prochaine_relance
        direction: ASC
  - type: table
    name: Sans nouvelles depuis 30 jours
    filters:
      and:
        - 'derniere_relance < today() - "30d"'
    order:
      - file.name
      - statut
      - derniere_relance
      - prochaine_relance
    sort:
      - property: derniere_relance
        direction: ASC
  - type: table
    name: Tous
    order:
      - file.name
      - statut
      - prochaine_relance
      - derniere_relance
      - apport
      - suivi_par
carnet:
  dossier: Partenaires — Prospects
  proprietes:
    statut:
      type: statut
      options: [Nouveau, En discussion, Proposition envoyée, Partenaire, Décliné]
    prochaine_relance:
      type: date
    derniere_relance:
      type: date
    apport:
      type: nombre
    suivi_par:
      type: texte
  nouvelle:
    statut: Nouveau
```

Les vues se créent sans écrire une ligne de YAML : bouton **…** à côté des onglets (Nouvelle vue, Dupliquer, Renommer, Supprimer), ou **Enregistrer comme nouvelle vue…** après avoir filtré. Le bloc ci-dessus reste lisible par Obsidian (format Bases).
