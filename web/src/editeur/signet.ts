// Signets (lot 4, réflexe Notion « Coller une URL → Lien · Signet »).
//
// Format (le fichier reste la vérité, aucune syntaxe nouvelle) : un SIGNET est un paragraphe qui ne contient QUE
// l'adresse, en autolien entre chevrons :
//
//     <https://example.com/guide>
//
// C'est du Markdown courant (CommonMark) : Obsidian, GitHub et les agents y voient un lien. Carnet l'affiche en carte
// (domaine + adresse) par une simple décoration : rien n'est jamais téléchargé (ni titre, ni image, ni icône du site :
// le serveur ne sort pas). Un lien nu (`https://…`) ou un lien `[texte](url)` reste un lien dans le texte.
//
// Coller une adresse seule (sélection vide) laisse le lien et propose un petit menu « Lien · Signet » à côté.
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { Magasin } from "./ui/magasin";

const RE_URL = /^https?:\/\/[^\s<>()[\]`*"']+$/i;

/** Adresse web lisible seule (http ou https), sans espace ni caractère que l'autolien ne sait pas porter. */
export function estAdresse(t: string | null | undefined): t is string {
  return Boolean(t && t.length <= 2000 && RE_URL.test(t) && !/[.,:;!?]$/.test(t));
}

/** Le paragraphe est-il un signet ? (un seul texte, lien entre chevrons, texte = adresse) */
export function estSignet(p: PMNode): string | null {
  if (p.type.name !== "paragraph" || p.childCount !== 1) return null;
  const t = p.firstChild!;
  if (!t.isText) return null;
  const lien = t.marks.find((m) => m.type.name === "link");
  if (!lien || lien.attrs.forme !== "chevrons" || t.marks.length !== 1) return null;
  const href = String(lien.attrs.href ?? "");
  return href === t.text && estAdresse(href) ? href : null;
}

/** Domaine affiché sur la carte (« example.com »), sans « www. ». */
export function domaineDe(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./i, ""); } catch { return url.replace(/^https?:\/\//i, "").split("/")[0]; }
}

function decorations(doc: PMNode): DecorationSet {
  const deco: Decoration[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name === "codeBlock") return false;
    if (n.type.name !== "paragraph") return true;
    const href = estSignet(n);
    if (href) {
      const d = domaineDe(href);
      deco.push(Decoration.node(pos, pos + n.nodeSize, {
        class: "carnet-signet", "data-domaine": d, "data-initiale": (d.match(/[\p{L}\p{N}]/u)?.[0] ?? "↗").toUpperCase(),
      }));
    }
    return false;
  });
  return DecorationSet.create(doc, deco);
}

const cleSignet = new PluginKey<DecorationSet>("carnetSignet");

/** Lien collé à [from, to] : en faire un signet (paragraphe à lui seul, adresse entre chevrons). */
export function enSignet(editor: Editor, from: number, to: number): boolean {
  const { state } = editor;
  const $a = state.doc.resolve(from);
  const para = $a.parent;
  if (para.type.name !== "paragraph" || $a.depth < 1) return false;
  const href = state.doc.textBetween(from, to);
  if (!estAdresse(href)) return false;
  const lien = state.schema.marks.link.create({ href, forme: "chevrons" });
  const debutPara = $a.before();
  const finPara = $a.after();
  const seul = from === $a.start() && to === $a.end();
  let tr = state.tr;
  if (seul) {
    tr = tr.removeMark(from, to, state.schema.marks.link).addMark(from, to, lien);
    tr.setSelection(TextSelection.create(tr.doc, Math.min(finPara, tr.doc.content.size)));
  } else {
    // l'adresse quitte la ligne et devient un bloc à part, juste en dessous (comme Notion)
    const signet = state.schema.nodes.paragraph.create(null, state.schema.text(href, [lien]));
    tr = tr.delete(from, to);
    const apres = tr.mapping.map(finPara);
    tr = tr.insert(apres, signet);
    tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(apres + signet.nodeSize, tr.doc.content.size)), -1));
    void debutPara;
  }
  editor.view.dispatch(tr.scrollIntoView());
  editor.view.focus();
  return true;
}

/** Signet → lien dans le texte (autolien nu, comme un collage simple). */
export function enLien(editor: Editor, pos: number): boolean {
  const n = editor.state.doc.nodeAt(pos);
  if (!n || !estSignet(n)) return false;
  const href = estSignet(n)!;
  const tr = editor.state.tr.removeMark(pos + 1, pos + n.nodeSize - 1, editor.schema.marks.link)
    .addMark(pos + 1, pos + n.nodeSize - 1, editor.schema.marks.link.create({ href, forme: "nu" }));
  editor.view.dispatch(tr);
  return true;
}

export function extensionSignet(magasin: Magasin) {
  return Extension.create({
    name: "carnetSignet",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [new Plugin<DecorationSet>({
        key: cleSignet,
        state: {
          init: (_c, state: EditorState) => decorations(state.doc),
          apply: (tr, ancien) => (tr.docChanged ? decorations(tr.doc) : ancien),
        },
        props: {
          decorations: (state) => cleSignet.getState(state),
          handlePaste: (view, event) => {
            const brut = event.clipboardData?.getData("text/plain") ?? "";
            const url = brut.trim();
            const { selection } = view.state;
            const $d = selection.$from;
            if (!estAdresse(url) || !selection.empty || $d.parent.type.name !== "paragraph") return false;
            // pas de carte dans un tableau ni dans un titre de repliable
            for (let d = $d.depth; d > 0; d--) if (/^(tableCell|tableHeader|detailsSummary)$/.test($d.node(d).type.name)) return false;
            const debut = selection.from;
            const doc = view.state.doc;
            // le collage se fait normalement (le lien est posé par Tiptap) ; on propose ensuite « Lien · Signet »
            window.setTimeout(() => {
              if (editor.isDestroyed || editor.state.doc === doc) return;
              const st = editor.state;
              const fin = debut + url.length;
              if (fin > st.doc.content.size || st.doc.textBetween(debut, fin) !== url) return;
              if (!st.doc.rangeHasMark(debut, fin, st.schema.marks.link)) {
                editor.view.dispatch(st.tr.addMark(debut, fin, st.schema.marks.link.create({ href: url, forme: "nu" })));
              }
              const a = editor.view.coordsAtPos(debut);
              const b = editor.view.coordsAtPos(fin);
              magasin.maj({
                collage: {
                  from: debut, to: fin, href: url, doc: editor.state.doc,
                  ancre: { left: a.left, top: a.top, right: b.right, bottom: b.bottom, width: Math.max(1, b.right - a.left), height: b.bottom - a.top },
                },
              });
            }, 0);
            return false;
          },
        },
      })];
    },
  });
}
