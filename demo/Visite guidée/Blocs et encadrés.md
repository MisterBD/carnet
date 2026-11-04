---
icon: 🧱
tags: [demo]
statut: terminé
resume: "Titres, listes, citation, couleurs, bloc repliable, encadrés colorés, tableau, image et code."
---
# Blocs et encadrés

Tape `/` au début d'une ligne pour insérer un bloc. Tout ce qui suit est du Markdown ordinaire : un agent peut l'écrire, tu peux le modifier, et le fichier reste lisible dans n'importe quel éditeur.

![Un vélo dessiné à la va-vite devant l'atelier](_assets/velo-atelier.png)

## Texte

Du **gras**, de l'_italique_, du `code en ligne`, un [lien vers un site](https://example.org) et une ~~erreur barrée~~. Une citation fait son effet :

> Un vélo bien réglé, c'est un vélo qu'on oublie de remarquer.

1. Une liste numérotée
2. Qui compte jusqu'à trois
3. Puis s'arrête

- Une liste à puces
  - Avec une sous-liste
  - Et même deux sous-éléments

## Couleurs et repliable

Sélectionne un mot pour changer sa <span color="red">couleur</span>, lui donner un <span color="blue_bg">fond</span> ou le ==surligner==. La poignée qui apparaît à gauche d'un bloc ouvre le menu de bloc : transformer, colorer tout le paragraphe, dupliquer, monter, descendre.

<details>
<summary>Un bloc repliable : touche la flèche pour l'ouvrir</summary>

Dedans, du Markdown ordinaire. Dans le fichier, c'est une balise `<details>`, que GitHub affiche aussi comme un bloc repliable.

</details>

## Encadrés

Cinq types, tous éditables. Touche l'étiquette d'un encadré pour changer son type.

> [!NOTE]
> Une note neutre, pour donner du contexte.

> [!TIP] Bon à savoir
> Un encadré peut porter un titre. Ici : « Bon à savoir ».

> [!IMPORTANT]
> Le point à ne surtout pas rater.

> [!WARNING] À vérifier
> Les freins arrière sont donnés pour « neufs », sans reçu. On vérifie avant de promettre quoi que ce soit.

> [!CAUTION]
> Ne jamais réparer un cadre carbone fissuré. On le dit gentiment, mais fermement.

## Tableau

| Pièce | En stock | Prix moyen | État du stock |
|---|---:|---:|---|
| Chambre à air 700 | 42 | 4 € | OK |
| Plaquettes de frein | 9 | 7 € | À surveiller |
| Chaîne 9 vitesses | 3 | 12 € | Bientôt vide |
| Dérailleur arrière | 1 | 25 € | Rupture imminente |

## Code

```bash
# Écriture atomique : fichier caché, puis renommage
tmp="$(dirname "$cible")/.$(basename "$cible").tmp"
cat > "$tmp" <<'FIN'
# Ma page
FIN
mv -f "$tmp" "$cible"
```

---

Le trait ci-dessus est un séparateur. Pour suivre : [[Visite guidée/Schémas et graphiques]].

P.-S. : le chiffre d'affaires de l'atelier est de zéro euro, tout est à prix libre. Le reste est de la gratitude.
