---
icon: ✅
tags: [demo]
statut: terminé
resume: "Cases à cocher, tâches rassemblées sur l'Accueil et mentions qui font remonter une page « à relire »."
---
# Tâches et mentions

## Les cases à cocher

Une case est une ligne `- [ ]`. Cocher une case dans Carnet ne change que cette ligne du fichier, rien d'autre.

- [x] Allumer la lumière de l'atelier
- [x] Brancher la bouilloire (priorité absolue)
- [ ] Ranger les clés de 15 dans le bon tiroir
- [ ] Demander à Noé d'arrêter de nommer les outils

Toutes les tâches ouvertes de toutes les pages sont rassemblées sur l'écran **Accueil**. Tu peux les cocher de là, sans ouvrir la page.

## Les mentions

Écris `@camille` dans le texte ou dans une case, et la page remonte dans la rubrique **À relire** de l'Accueil. Le prénom vient du réglage `CARNET_PRENOM` de ton installation (ou de la liste `CARNET_MENTIONS`), c'est donc le tien qui compte.

- [ ] Relire la demande de subvention avant l'envoi @camille
- [ ] Valider le visuel de l'affiche de la fête du vélo @camille

L'autre façon de demander une relecture, c'est le statut. Il suffit d'écrire `statut: à relire` en tête de page, dans le frontmatter : voir [[Projets/Demande de subvention]].

> [!TIP] Pour les agents
> Une mention dans un bloc de code ou entre accents graves, comme `@camille` ici, est ignorée. Seule la vraie mention compte.

Suite de la visite : [[Visite guidée/Liens entre pages]].
