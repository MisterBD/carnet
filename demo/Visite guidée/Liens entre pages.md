---
icon: 🔗
tags: [demo]
statut: terminé
resume: "Les liens [[…]] entre pages : simples, avec alias, vers un titre, et rangée de page façon Notion."
---
# Liens entre pages

Un lien interne s'écrit entre doubles crochets, avec le chemin de la page depuis la racine de l'espace, sans `.md`. Tape `[[` dans l'éditeur pour choisir une page dans une liste.

## Les formes

- Un lien simple : [[Projets/Fête du vélo]]
- Avec un alias : [[Projets/Fête du vélo|la grande fête]]
- Vers un titre de la page : [[To-do#Cette semaine]] (l'ancre est conservée dans le fichier ; la page s'ouvre en haut, le saut jusqu'au titre viendra)
- Vers une page d'index : [[Projets]]

Un lien dans une phrase s'affiche comme une pastille cliquable : voir [[Projets/Site web de l'atelier]] pour la refonte du site, ou [[Réunions/2026-10-05 Point du lundi]] pour la dernière réunion.

## La rangée de page

Une ligne qui ne contient qu'un lien devient une rangée de page, façon Notion :

[[Projets/Inventaire des pièces]]

[[Projets/Achat de l'établi]]

## Renommer sans casser

Quand tu renommes ou déplaces une page dans Carnet, les liens `[[…]]` des autres pages sont mis à jour dans leurs fichiers. Les liens écrits dans des blocs de code ne sont jamais touchés.

Dernière étape de la visite : [[Visite guidée/Artefacts HTML]].
