---
icon: 📦
tags: [projet]
statut: en pause
echeance: 2026-12-19
responsable: Noé
priorite: basse
resume: "Compter les pièces détachées en stock et définir un seuil de réapprovisionnement. En pause jusqu'après la fête."
---
# Inventaire des pièces

En pause jusqu'à la fin de la [[Projets/Fête du vélo]] : tout le monde est sur les barnums.

## État du stock (approximatif)

```vega-lite
{
  "description": "Pièces en stock (données fictives)",
  "data": {"values": [
    {"piece": "Chambres à air", "stock": 42},
    {"piece": "Plaquettes", "stock": 9},
    {"piece": "Chaînes", "stock": 3},
    {"piece": "Dérailleurs", "stock": 1}
  ]},
  "mark": {"type": "bar", "cornerRadiusEnd": 4},
  "encoding": {
    "y": {"field": "piece", "type": "nominal", "sort": "-x", "title": null},
    "x": {"field": "stock", "type": "quantitative", "title": "En stock"}
  }
}
```

- [ ] Compter les chambres à air (il y en a forcément une cachée dans chaque tiroir)
- [ ] Fixer un seuil d'alerte par pièce
- [ ] Mettre une étiquette sur chaque boîte, y compris celle qui s'appelle « divers »
