---
icon: 🌐
tags: [projet]
statut: à faire
echeance: 2026-12-05
responsable: Malo
priorite: moyenne
resume: "Refaire le site de l'atelier : horaires, tarifs à prix libre, agenda des ateliers et formulaire de contact."
---
# Site web de l'atelier

Le site actuel date de l'époque où l'atelier avait un seul établi et une seule bénévole. Il est temps d'un coup de neuf.

## Ce qu'on veut

- Les horaires, lisibles en un coup d'œil sur téléphone
- L'agenda des ateliers du samedi, voir [[Projets/Atelier du samedi]]
- Un formulaire de contact (et un seul)
- Une page « Comment ça marche, le prix libre ? »

## Plan du site

```mermaid
flowchart TD
  Accueil --> Horaires
  Accueil --> Agenda
  Accueil --> Prix[Prix libre]
  Accueil --> Contact
  Agenda --> Fete[Fête du vélo]
```

> [!TIP]
> Un site statique suffit. Pas de base de données, pas de panneau d'administration, pas de maintenance. Les bénévoles ont mieux à faire.
