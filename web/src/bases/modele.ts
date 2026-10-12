// Carnet · bases : création d'une base depuis le menu « / » (dossier des entrées + bloc minimal, comme une base
// Notion vide : vue tableau, propriétés Statut, Priorité, Échéance).
import { apiBases } from "../api";
import type { ContexteEditeur } from "../editeur/contexte";

/** Bloc ```base minimal pour le dossier donné (sous-ensemble documenté dans shared/bases.ts). */
export function modeleBase(dossier: string): string {
  const expr = `file.inFolder(${JSON.stringify(dossier)})`.replace(/'/g, "''");
  return [
    "filters:",
    "  and:",
    `    - '${expr}'`,
    "properties:",
    "  file.name:",
    "    displayName: Nom",
    "  statut:",
    "    displayName: Statut",
    "  priorite:",
    "    displayName: Priorité",
    "  echeance:",
    "    displayName: Échéance",
    "views:",
    "  - type: table",
    "    name: Tableau",
    "    order:",
    "      - file.name",
    "      - statut",
    "      - priorite",
    "      - echeance",
    "carnet:",
    `  dossier: ${JSON.stringify(dossier)}`,
    "  proprietes:",
    "    statut:",
    "      type: statut",
    "      options: [À faire, En cours, Terminé]",
    "    priorite:",
    "      type: selection",
    "      options: [Haute, Moyenne, Basse]",
    "    echeance:",
    "      type: date",
    "  nouvelle:",
    "    statut: À faire",
  ].join("\n");
}

/** Demande le nom de la base puis crée son dossier (nom unique) sous la page. Renvoie le dossier, ou null. */
export async function creerBase(contexte: ContexteEditeur): Promise<string | null> {
  const nom = contexte.demanderTexte
    ? await contexte.demanderTexte({ titre: "Nouvelle base", texte: "Ses pages seront rangées dans un dossier sous cette page.", valeur: "Tâches", placeholder: "Nom de la base", bouton: "Créer la base" })
    : "Base";
  if (!nom || !nom.trim()) return null;
  try {
    const r = await apiBases.dossier(contexte.chemin, nom.trim());
    return r.dossier;
  } catch (e) {
    contexte.notifier(`Base non créée : ${(e as Error).message}`);
    return null;
  }
}
