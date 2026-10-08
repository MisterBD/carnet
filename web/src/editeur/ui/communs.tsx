// Éléments communs de l'interface de l'éditeur : icônes des blocs, palette de couleurs, hook du magasin.
import { useSyncExternalStore } from "react";
import {
  FilePlus, FileSymlink, Pilcrow, Heading1, Heading2, Heading3, List, ListOrdered, ListTodo, TextQuote, ListCollapse,
  Minus, Info, Lightbulb, MessageSquareWarning, TriangleAlert, OctagonAlert, Table, Image, CodeXml, Workflow,
  ChartColumn, AppWindow, Calendar, ListTree, type LucideIcon,
} from "lucide-react";
import type { Magasin, Etat } from "./magasin";
import type { Icone } from "../menu";

export function useMagasin(m: Magasin): Etat {
  return useSyncExternalStore(m.abonner, m.lire, m.lire);
}

export const ICONES: Record<Icone, LucideIcon> = {
  sousPage: FilePlus, lienPage: FileSymlink, texte: Pilcrow, h1: Heading1, h2: Heading2, h3: Heading3, puces: List,
  numeros: ListOrdered, tache: ListTodo, citation: TextQuote, repliable: ListCollapse, separateur: Minus,
  NOTE: Info, TIP: Lightbulb, IMPORTANT: MessageSquareWarning, WARNING: TriangleAlert, CAUTION: OctagonAlert,
  tableau: Table, image: Image, code: CodeXml, schema: Workflow, graphique: ChartColumn, artefact: AppWindow,
  date: Calendar, sommaire: ListTree,
};

/** Les 9 couleurs portables (noms écrits dans le fichier) et leur nom français. */
export const PALETTE: Array<[string, string]> = [
  ["gray", "Gris"], ["brown", "Marron"], ["orange", "Orange"], ["yellow", "Jaune"], ["green", "Vert"],
  ["blue", "Bleu"], ["purple", "Violet"], ["pink", "Rose"], ["red", "Rouge"],
];

export const tactile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** Empêche un bouton de voler le focus (et de fermer le clavier sur iPhone). */
export const garderFocus = (e: React.PointerEvent | React.MouseEvent) => { e.preventDefault(); };

/** À poser sur un conteneur de menu : un clic de souris (ou le mousedown de compatibilité d'un toucher)
 *  ne déplace jamais le focus, sauf vers un champ de saisie. */
export const sansFocus = (e: React.MouseEvent) => {
  if (!(e.target as Element).closest("input, textarea")) e.preventDefault();
};

export function Palette({ texte, fond, choisir }: {
  texte: string | null; fond: string | null;
  choisir: (quoi: "couleurTexte" | "couleurFond", c: string | null) => void;
}) {
  return (
    <div className="carnet-palette">
      <div className="carnet-palette__titre">Couleur du texte</div>
      <div className="carnet-palette__grille" role="group" aria-label="Couleur du texte">
        <button type="button" className="carnet-palette__case" data-actif={texte == null} onPointerDown={garderFocus}
          onClick={() => choisir("couleurTexte", null)} title="Par défaut" aria-label="Couleur du texte : par défaut">
          <span className="carnet-palette__a">A</span>
        </button>
        {PALETTE.map(([c, nom]) => (
          <button key={c} type="button" className="carnet-palette__case" data-actif={texte === c} onPointerDown={garderFocus}
            onClick={() => choisir("couleurTexte", c)} title={nom} aria-label={`Couleur du texte : ${nom}`}>
            <span className="carnet-palette__a" data-couleur={c}>A</span>
          </button>
        ))}
      </div>
      <div className="carnet-palette__titre">Surlignage (fond)</div>
      <div className="carnet-palette__grille" role="group" aria-label="Couleur du fond">
        <button type="button" className="carnet-palette__case" data-actif={fond == null} onPointerDown={garderFocus}
          onClick={() => choisir("couleurFond", null)} title="Aucun" aria-label="Fond : aucun">
          <span className="carnet-palette__fond carnet-palette__fond--aucun" />
        </button>
        {PALETTE.map(([c, nom]) => (
          <button key={c} type="button" className="carnet-palette__case" data-actif={fond === c} onPointerDown={garderFocus}
            onClick={() => choisir("couleurFond", c)} title={nom} aria-label={`Fond : ${nom}`}>
            <span className="carnet-palette__fond" data-fond={c} />
          </button>
        ))}
      </div>
    </div>
  );
}
