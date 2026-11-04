---
icon: 🗂️
resume: "Les chantiers de l'Atelier Cambouis, avec statut, échéance et responsable."
---
# Projets

Chaque projet est une sous-page du dossier `Projets/`, avec quelques propriétés en tête de fichier. Ces propriétés alimentent la vue **Projets** (menu de gauche), en tableau et en kanban. Changer un statut là-bas réécrit **une seule ligne** du fichier : `statut:`.

Les propriétés reconnues :

| Propriété | Exemple | Rôle |
|---|---|---|
| `tags` | `[projet]` | rend la page visible dans la vue Projets |
| `statut` | `en cours` | colonne du kanban |
| `echeance` | `2026-11-14` | tri du tableau |
| `responsable` | `Inès` | qui porte le sujet |
| `priorite` | `haute` | mention sur la carte |
| `resume` | une phrase | utile à la recherche et aux agents |

Statuts connus : `à faire`, `en cours`, `à relire`, `en pause`, `terminé`. Un autre statut est accepté, il crée simplement sa propre colonne.

## Les projets du moment

- [[Projets/Fête du vélo]]
- [[Projets/Demande de subvention]]
- [[Projets/Site web de l'atelier]]
- [[Projets/Inventaire des pièces]]
- [[Projets/Atelier du samedi]]
- [[Projets/Achat de l'établi]]
