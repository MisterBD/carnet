// État partagé de l'application : configuration, arbre, favoris, dialogues, notifications.
import { createContext, useContext } from "react";
import type { Config, Noeud, Position } from "./api";
import type { ActionMenu } from "./composants/Dialogues";

export interface OptionsTexte { titre: string; texte?: string; valeur?: string; placeholder?: string; bouton?: string }
export interface OptionsConfirmation { titre: string; texte: string; bouton: string; danger?: boolean }

export interface App {
  config: Config | null;
  arbre: Noeud[];
  /** L'arbre est arrivé au moins une fois (avant : squelette, jamais « Aucune page »). */
  arbreCharge: boolean;
  index: Map<string, Noeud>;
  rechargerArbre(): Promise<void>;
  favoris: string[];
  basculerFavori(chemin: string): void;
  demanderTexte(o: OptionsTexte): Promise<string | null>;
  confirmer(o: OptionsConfirmation): Promise<boolean>;
  choisirPage(o?: { titre?: string; exclure?: string }): Promise<string | null>;
  choisirArtefact(): Promise<{ chemin: string; titre: string } | null>;
  choisirEmoji(avecRetrait: boolean): Promise<string | null>;
  actions(titre: string, items: ActionMenu[]): Promise<string | null>;
  /** Toast ; `duree` en ms (par défaut 3,5 s, 6 s avec un bouton ; 8 s pour « Annuler » une suppression). */
  notifier(message: string, action?: { libelle: string; faire: () => void }, duree?: number): void;
  pleinEcran(cheminArtefact: string, titre: string): void;
  ouvrirRecherche(): void;
  ouvrirTiroir(): void;
  fermerTiroir(): void;
  /** Crée « Sans titre » (sous `parent`, "" = racine), l'ouvre et place le curseur dans le titre. */
  nouvellePage(parent: string): Promise<string | null>;
  /** Menu « … » d'une page, ancré sous `ancre` sur ordinateur (à défaut : le dernier bouton touché), feuille sur iPhone. */
  menuPage(chemin: string, ancre?: HTMLElement | null): Promise<void>;
  deplacerPage(source: string, parent: string): Promise<string | null>;
  /** Glisser-déposer, Monter / Descendre : avant ou après une page sœur, ou dans une page. */
  placerPage(source: string, cible: string, position: Position): Promise<void>;
  /** Corbeille sans confirmation, avec « Annuler » pendant 8 s. */
  supprimerPage(chemin: string): Promise<void>;
  deplier(chemin: string): void;
}

export const ContexteApp = createContext<App | null>(null);

export function useApp(): App {
  const a = useContext(ContexteApp);
  if (!a) throw new Error("ContexteApp absent");
  return a;
}

/** Chaîne des ancêtres d'une page (chemins .md), de la racine au parent. */
export function ancetres(chemin: string): string[] {
  const segs = chemin.replace(/\.md$/i, "").split("/");
  const res: string[] = [];
  for (let i = 1; i < segs.length; i++) res.push(segs.slice(0, i).join("/") + ".md");
  return res;
}
