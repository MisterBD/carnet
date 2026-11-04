// K10-01 : ranger une page DANS une base. Une base (bloc ```base```) range ses entrées dans un dossier
// (`carnet.dossier`, ou celui de son filtre `file.inFolder`) qui n'est pas la page qui la porte : « Déplacer vers… »
// propose donc « Ajouter à <base> » (dossier des entrées), et un déplacement sur la page conteneur demande
// explicitement s'il faut l'ajouter à la base ou en faire une simple sous-page. Le déplacement lui-même reste
// POST /api/deplacer (porte d'écriture, liens mis à jour, journal).
import { FolderInput, Table2 } from "lucide-react";
import { apiBases, type DestinationBase } from "./api";
import type { ActionMenu } from "./composants/Dialogues";

let cache: { t: number; l: DestinationBase[] } | null = null;

/** Destinations « Ajouter à <base> » (gardées 5 s : la liste sert au dialogue puis au message). */
export async function destinationsBases(frais = false): Promise<DestinationBase[]> {
  if (!frais && cache && Date.now() - cache.t < 5000) return cache.l;
  const l = (await apiBases.destinations()).destinations;
  cache = { t: Date.now(), l };
  return l;
}

/** Destination de base dont `parent` est le dossier des entrées (ou null). */
export function baseDuParent(parent: string): DestinationBase | null {
  return cache?.l.find((d) => d.parent === parent) ?? null;
}

/** « Ajouter à To-Do — Suivi » */
export const libelleAjout = (d: DestinationBase) => `Ajouter à ${d.titre}`;

/** Dossier des entrées, lisible (« Démo › To-Do — Suivi › Tâches »). */
export const lieuEntrees = (d: DestinationBase) => d.dossier.split("/").join(" › ");

/** « Tâches » (dernier segment du dossier des entrées), entre guillemets insécables. */
export const nomEntrees = (d: DestinationBase) => `«\u00a0${d.dossier.split("/").pop()}\u00a0»`;

/**
 * Dialogue « Déplacer vers… » puis, si la cible est la page qui PORTE une base, choix explicite : l'ajouter à la base
 * (dossier des entrées) ou en faire une sous-page. Renvoie le `parent` à passer à api.deplacer (« » = racine) et la
 * base visée, ou null si la personne annule.
 */
export async function choisirRangement(app: {
  choisirPage(o?: { titre?: string; exclure?: string }): Promise<string | null>;
  actions(titre: string, items: ActionMenu[]): Promise<string | null>;
}, source: string, titre: string, titreDe: (chemin: string) => string): Promise<{ parent: string; base: DestinationBase | null } | null> {
  const cible = await app.choisirPage({ titre: `Déplacer « ${titre} » dans…`, exclure: source });
  if (cible === null) return null;
  const parent = cible === "__racine__" ? "" : cible;
  const dests = await destinationsBases().catch(() => [] as DestinationBase[]);
  const directe = dests.find((d) => d.parent === parent);
  if (directe) return { parent, base: directe };
  const portees = dests.filter((d) => d.page === parent && d.parent !== parent);
  if (portees.length) {
    const page = titreDe(parent);
    const choix = await app.actions(`«\u00a0${page}\u00a0» contient une base`, [
      ...portees.map((d, i) => ({ cle: `base:${i}`, libelle: `${libelleAjout(d)} (dossier ${nomEntrees(d)})`, icone: <Table2 size={18} /> })),
      { cle: "sous-page", libelle: `En faire une sous-page de «\u00a0${page}\u00a0» (hors de la base)`, icone: <FolderInput size={18} /> },
    ]);
    if (choix === null) return null;
    if (choix.startsWith("base:")) { const d = portees[Number(choix.slice(5))]; return { parent: d.parent, base: d }; }
  }
  return { parent, base: null };
}
