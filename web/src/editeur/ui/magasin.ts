// État de l'interface de l'éditeur (menus, bulles, feuilles), partagé entre les greffons ProseMirror et React.
import type { Editor, Range } from "@tiptap/core";
import type { EntreeSlash } from "../menu";

export type Rect = { left: number; top: number; right: number; bottom: number; width: number; height: number };

export interface EtatSlash {
  ouvert: boolean;
  requete: string;
  entrees: EntreeSlash[];
  index: number;
  range: Range | null;
  rect: Rect | null;
  executer: ((e: EntreeSlash) => void) | null;
}

export interface EtatMenuBloc {
  pos: number;
  ancre: Rect | null;
  /** feuille basse (iPhone) plutôt que menu ancré */
  feuille: boolean;
  /** sous-menu ouvert d'emblée */
  vue?: "principal" | "transformer" | "couleur";
}

export interface EtatLien {
  ancre: Rect;
  href: string;
  edition: boolean;
  from: number;
  to: number;
}

export interface EtatLangue {
  ancre: Rect;
  actuelle: string | null;
  choisir: (l: string | null) => void;
}

export interface Etat {
  slash: EtatSlash;
  menuBloc: EtatMenuBloc | null;
  lien: EtatLien | null;
  langue: EtatLangue | null;
  /** révision : change à chaque transaction (pour la bulle, la barre de tableau) */
  rev: number;
  focus: boolean;
}

export class Magasin {
  private etat: Etat = {
    slash: { ouvert: false, requete: "", entrees: [], index: 0, range: null, rect: null, executer: null },
    menuBloc: null,
    lien: null,
    langue: null,
    rev: 0,
    focus: false,
  };
  private abonnes = new Set<() => void>();
  editeur: Editor | null = null;

  lire = (): Etat => this.etat;

  abonner = (f: () => void): (() => void) => {
    this.abonnes.add(f);
    return () => { this.abonnes.delete(f); };
  };

  maj(p: Partial<Etat>): void {
    this.etat = { ...this.etat, ...p };
    for (const f of this.abonnes) f();
  }

  majSlash(p: Partial<EtatSlash>): void {
    this.maj({ slash: { ...this.etat.slash, ...p } });
  }

  /** Un menu est-il ouvert (le « /filtre » tapé n'est pas du contenu : on n'enregistre pas pendant ce temps) ? */
  menuOuvert(): boolean {
    return this.etat.slash.ouvert;
  }

  fermerTout(): void {
    this.maj({ menuBloc: null, lien: null, langue: null });
  }
}

export function rectDe(el: Element | DOMRect | null | undefined): Rect | null {
  if (!el) return null;
  const r = el instanceof Element ? el.getBoundingClientRect() : el;
  return { left: r.left, top: r.top, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}
