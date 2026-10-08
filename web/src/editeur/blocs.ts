// Opérations sur les blocs (menu de bloc, poignée, barre au-dessus du clavier, raccourcis) :
// trouver le bloc, monter, descendre, dupliquer, supprimer, transformer, colorer.
import type { Editor } from "@tiptap/core";
import type { Node as PMNode, ResolvedPos } from "@tiptap/pm/model";
import type { EditorState } from "@tiptap/pm/state";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { basculerTache } from "./menu";

export interface Bloc { pos: number; node: PMNode; depth: number }

const CONTENEURS = new Set(["doc", "detailsContent", "encadre", "blockquote"]);

function candidat($p: ResolvedPos, d: number): boolean {
  const n = $p.node(d);
  if (n.type.name === "listItem") return true;
  if (d === 0) return false;
  return n.isBlock && CONTENEURS.has($p.node(d - 1).type.name);
}

/** Bloc « déplaçable » qui contient la position (élément de liste, ou enfant direct de la page / d'un conteneur). */
export function blocEn(state: EditorState, pos: number): Bloc | null {
  const $p = state.doc.resolve(Math.max(0, Math.min(pos, state.doc.content.size)));
  // nœud juste après la position (bloc atomique : image, artefact, séparateur…)
  const apres = $p.nodeAfter;
  if (apres && apres.isBlock && (CONTENEURS.has($p.parent.type.name) || apres.type.name === "listItem")) {
    return { pos: $p.pos, node: apres, depth: $p.depth + 1 };
  }
  for (let d = $p.depth; d > 0; d--) {
    if (candidat($p, d)) return { pos: $p.before(d), node: $p.node(d), depth: d };
  }
  return null;
}

/** Bloc de la sélection courante. */
export function blocCourant(state: EditorState): Bloc | null {
  const s = state.selection;
  if (s instanceof NodeSelection && s.node.isBlock) return { pos: s.from, node: s.node, depth: s.$from.depth + 1 };
  return blocEn(state, s.from);
}

export function nomDuBloc(n: PMNode): string {
  switch (n.type.name) {
    case "paragraph": return "Texte";
    case "heading": return `Titre ${n.attrs.level}`;
    case "listItem": return n.attrs.checked != null ? "Tâche" : "Élément de liste";
    case "bulletList": return "Liste à puces";
    case "orderedList": return "Liste numérotée";
    case "blockquote": return "Citation";
    case "encadre": return "Encadré";
    case "codeBlock": return n.attrs.language === "mermaid" ? "Schéma" : n.attrs.language === "vega-lite" ? "Graphique" : "Code";
    case "table": return "Tableau";
    case "details": return "Repliable";
    case "imageBloc": return "Image";
    case "artefact": return "Artefact";
    case "horizontalRule": return "Séparateur";
    case "sommaire": return "Sommaire";
    case "blocBrut": return "Texte brut";
    default: return "Bloc";
  }
}

export function deplacer(editor: Editor, pos: number, sens: -1 | 1): boolean {
  const { state } = editor;
  const b = blocEn(state, pos + (state.doc.nodeAt(pos) ? 0 : 1));
  if (!b) return false;
  const $p = state.doc.resolve(b.pos);
  const parent = $p.parent;
  const i = $p.index();
  const j = i + sens;
  if (j < 0 || j >= parent.childCount) return false;
  const voisin = parent.child(j);
  let tr = state.tr;
  if (sens === -1) {
    const debutVoisin = b.pos - voisin.nodeSize;
    tr = tr.delete(b.pos, b.pos + b.node.nodeSize).insert(debutVoisin, b.node);
    tr = tr.setSelection(selectionDans(tr.doc, debutVoisin, editor.state.selection, b.pos));
  } else {
    const finVoisin = b.pos + b.node.nodeSize + voisin.nodeSize;
    tr = tr.insert(finVoisin, b.node).delete(b.pos, b.pos + b.node.nodeSize);
    const nouveau = finVoisin - b.node.nodeSize;
    tr = tr.setSelection(selectionDans(tr.doc, nouveau, editor.state.selection, b.pos));
  }
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

/** Garde le curseur au même endroit relatif dans le bloc déplacé. */
function selectionDans(doc: PMNode, nouveauPos: number, ancienne: EditorState["selection"], ancienPos: number) {
  if (ancienne instanceof NodeSelection) return NodeSelection.create(doc, nouveauPos);
  const decal = nouveauPos - ancienPos;
  const a = Math.max(0, Math.min(doc.content.size, ancienne.anchor + decal));
  const h = Math.max(0, Math.min(doc.content.size, ancienne.head + decal));
  return TextSelection.between(doc.resolve(a), doc.resolve(h));
}

export function dupliquer(editor: Editor, pos: number): boolean {
  const n = editor.state.doc.nodeAt(pos);
  if (!n) return false;
  const fin = pos + n.nodeSize;
  const tr = editor.state.tr.insert(fin, n.copy(n.content));
  tr.setSelection(TextSelection.near(tr.doc.resolve(fin + 1)));
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function supprimer(editor: Editor, pos: number): boolean {
  const n = editor.state.doc.nodeAt(pos);
  if (!n) return false;
  let tr = editor.state.tr.delete(pos, pos + n.nodeSize);
  if (tr.doc.childCount === 0) tr = tr.insert(0, editor.schema.nodes.paragraph.create());
  const p = Math.min(pos, tr.doc.content.size);
  tr.setSelection(TextSelection.near(tr.doc.resolve(p), -1));
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

export type Cible = "texte" | "h1" | "h2" | "h3" | "puces" | "numeros" | "tache" | "citation" | "encadre" | "code" | "repliable";

/** Place le curseur au début du premier bloc de texte du bloc visé. */
function curseurDans(editor: Editor, pos: number): boolean {
  const n = editor.state.doc.nodeAt(pos);
  if (!n) return false;
  let cible = -1;
  n.descendants((x, p) => {
    if (cible !== -1) return false;
    if (x.isTextblock) { cible = pos + 1 + p + 1; return false; }
    return true;
  });
  if (n.isTextblock) cible = pos + 1;
  if (cible === -1) return false;
  editor.commands.setTextSelection(cible);
  return true;
}

export function transformer(editor: Editor, pos: number, cible: Cible): boolean {
  if (!curseurDans(editor, pos)) return false;
  const c = editor.chain().focus();
  const dansListe = editor.isActive("bulletList") || editor.isActive("orderedList");
  const sortirListe = () => { let k = 0; while ((editor.isActive("bulletList") || editor.isActive("orderedList")) && k++ < 8) editor.commands.liftListItem("listItem"); };
  switch (cible) {
    case "texte": sortirListe(); return editor.chain().focus().setParagraph().run();
    case "h1": case "h2": case "h3":
      sortirListe();
      return editor.chain().focus().setNode("heading", { level: Number(cible[1]) }).run();
    case "puces":
      if (editor.isActive("listItem") && editor.isActive("bulletList")) {
        editor.commands.updateAttributes("listItem", { checked: null });
        return true;
      }
      return c.toggleBulletList().run();
    case "numeros": return dansListe && editor.isActive("orderedList") ? true : c.toggleOrderedList().run();
    case "tache": basculerTache(editor, true); return true;
    case "citation": sortirListe(); return editor.chain().focus().setParagraph().wrapIn("blockquote").run();
    case "encadre": sortirListe(); return editor.chain().focus().wrapIn("encadre", { genre: "NOTE", titre: "", pli: "" }).run();
    case "code": sortirListe(); return editor.chain().focus().setCodeBlock().run();
    case "repliable": sortirListe(); return editor.chain().focus().setDetails().run();
  }
  return false;
}

/** Couleur du texte ou du fond de tout le bloc (null : retire la couleur). */
export function colorer(editor: Editor, pos: number, quoi: "couleurTexte" | "couleurFond", c: string | null): boolean {
  const n = editor.state.doc.nodeAt(pos);
  if (!n) return false;
  const from = pos + 1;
  const to = pos + n.nodeSize - 1;
  const type = editor.schema.marks[quoi];
  let tr = editor.state.tr.removeMark(from, to, type);
  if (c) tr = tr.addMark(from, to, type.create({ c }));
  editor.view.dispatch(tr);
  return true;
}

/** Couleur de la sélection (texte surligné), comme dans la bulle de mise en forme. */
export function colorerSelection(editor: Editor, quoi: "couleurTexte" | "couleurFond", c: string | null): boolean {
  if (c) return editor.chain().focus().setMark(quoi, { c }).run();
  return editor.chain().focus().unsetMark(quoi).run();
}

export function selectionnerBloc(editor: Editor, pos: number): void {
  const n = editor.state.doc.nodeAt(pos);
  if (!n) return;
  editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
}
