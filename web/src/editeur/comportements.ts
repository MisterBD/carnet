// Comportements de l'éditeur : raccourcis (Notion + AZERTY), règles de saisie Markdown, collage et copie en Markdown,
// menu « / », images (envoi, collage, dépôt), clic sous le dernier bloc.
import { Extension, InputRule, type Editor, type Range } from "@tiptap/core";
import { Plugin, PluginKey, TextSelection, NodeSelection } from "@tiptap/pm/state";
import { Fragment, Slice, type Node as PMNode } from "@tiptap/pm/model";
import { Suggestion } from "@tiptap/suggestion";
import { mdVersBlocs, blocsVersMd } from "./markdown/index.ts";
import { ENTREES, filtrer, basculerTache, type EntreeSlash, type ContexteSlash } from "./menu";
import { blocCourant, deplacer, dupliquer } from "./blocs";
import type { Magasin } from "./ui/magasin";
import { rectDe } from "./ui/magasin";
import type { ContexteEditeur } from "./contexte";

export const TYPES_IMAGES = ["image/png", "image/jpeg", "image/webp", "image/gif"];

// ------------------------------------------------------------------------------------------------ images

let jeton = 0;

/** Envoie des images et les place dans la page (bloc « Envoi… » le temps du transfert). */
export function envoyerImages(editor: Editor, contexte: ContexteEditeur, fichiers: File[], pos: number | null): void {
  const images = fichiers.filter((f) => TYPES_IMAGES.includes(f.type) || /\.(png|jpe?g|webp|gif)$/i.test(f.name));
  if (!images.length) {
    if (fichiers.length) contexte.notifier("Seules les images PNG, JPEG, WebP et GIF peuvent être ajoutées.");
    return;
  }
  for (const f of images) {
    const id = `envoi-${Date.now()}-${++jeton}`;
    const noeud = { type: "imageBloc", attrs: { src: "", alt: "", envoi: id } };
    let cible = pos;
    if (cible == null) {
      const { $from } = editor.state.selection;
      const vide = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && $from.depth >= 1;
      if (vide) {
        const debut = $from.before($from.depth);
        editor.chain().insertContentAt({ from: debut, to: debut + $from.parent.nodeSize }, noeud).run();
      } else {
        const b = blocCourant(editor.state);
        const fin = b ? b.pos + b.node.nodeSize : editor.state.doc.content.size;
        editor.chain().insertContentAt(fin, noeud).run();
      }
    } else {
      editor.chain().insertContentAt(cible, noeud).run();
      cible = null;
    }
    const trouver = (): number | null => {
      let p: number | null = null;
      editor.state.doc.descendants((n, x) => {
        if (p != null) return false;
        if (n.type.name === "imageBloc" && n.attrs.envoi === id) { p = x; return false; }
        return true;
      });
      return p;
    };
    contexte.televerserImage(f).then((relatif) => {
      const p = trouver();
      if (p == null || editor.isDestroyed) return;
      const n = editor.state.doc.nodeAt(p)!;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(p, undefined, { ...n.attrs, src: relatif, envoi: null }));
    }).catch(() => {
      const p = trouver();
      if (p == null || editor.isDestroyed) return;
      const n = editor.state.doc.nodeAt(p)!;
      editor.view.dispatch(editor.state.tr.delete(p, p + n.nodeSize));
    });
  }
}

/** Remplace l'image d'un bloc existant (bouton « Remplacer »). */
export function remplacerImage(editor: Editor, contexte: ContexteEditeur, pos: number, f: File): void {
  const n = editor.state.doc.nodeAt(pos);
  if (!n || n.type.name !== "imageBloc") return;
  const id = `envoi-${Date.now()}-${++jeton}`;
  editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, envoi: id }));
  const trouver = () => {
    let p: number | null = null;
    editor.state.doc.descendants((x, q) => { if (p == null && x.type.name === "imageBloc" && x.attrs.envoi === id) p = q; return p == null; });
    return p;
  };
  contexte.televerserImage(f).then((relatif) => {
    const p = trouver();
    if (p == null) return;
    const m = editor.state.doc.nodeAt(p)!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(p, undefined, { ...m.attrs, src: relatif, envoi: null }));
  }).catch(() => {
    const p = trouver();
    if (p == null) return;
    const m = editor.state.doc.nodeAt(p)!;
    editor.view.dispatch(editor.state.tr.setNodeMarkup(p, undefined, { ...m.attrs, envoi: null }));
  });
}

export function choisirFichierImage(rappel: (f: File[]) => void): void {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = "image/png,image/jpeg,image/webp,image/gif,image/*";
  input.multiple = true;
  input.style.display = "none";
  input.addEventListener("change", () => {
    const f = [...(input.files ?? [])];
    input.remove();
    if (f.length) rappel(f);
  });
  document.body.append(input);
  input.click();
}

// ------------------------------------------------------------------------------------------------ Markdown collé

/** Le texte collé ressemble-t-il à du Markdown (au moins une construction de bloc ou deux indices) ? */
export function ressembleMarkdown(t: string): boolean {
  if (t.length > 500_000) return false;
  let indices = 0;
  if (/^#{1,6} \S/m.test(t)) indices += 2;
  if (/^\s*[-*+] \S/m.test(t)) indices++;
  if (/^\s*\d+[.)] \S/m.test(t)) indices++;
  if (/^\s*[-*+] \[[ xX]\] /m.test(t)) indices += 2;
  if (/^```/m.test(t)) indices += 2;
  if (/^\|.*\|\s*$/m.test(t) && /^\|?\s*:?-{3,}/m.test(t)) indices += 2;
  if (/^> /m.test(t)) indices++;
  if (/\*\*[^*\n]+\*\*/.test(t) || /\[[^\]\n]+\]\([^)\s]+\)/.test(t) || /\[\[[^\]\n]+\]\]/.test(t)) indices++;
  return indices >= 2;
}

// ------------------------------------------------------------------------------------------------ menu « / »

const cleSlash = new PluginKey("carnetSlash");

function extensionSlash(magasin: Magasin, ctxSlash: () => ContexteSlash) {
  return Extension.create({
    name: "carnetSlash",
    addProseMirrorPlugins() {
      const editor = this.editor;
      return [Suggestion<EntreeSlash, EntreeSlash>({
        editor,
        pluginKey: cleSlash,
        char: "/",
        allowSpaces: false,
        allowedPrefixes: [" ", " "],
        startOfLine: false,
        decorationClass: "carnet-slash-requete",
        allow: ({ state, range }) => {
          const $from = state.doc.resolve(range.from);
          if ($from.parent.type.spec.code) return false;
          if ($from.parent.type.name === "detailsSummary") return false;
          return !$from.marks().some((m) => m.type.name === "code" || m.type.name === "link");
        },
        items: ({ query }) => filtrer(query),
        command: ({ editor: e, range, props }) => { props.executer(e, range, ctxSlash()); },
        render: () => {
          let courant: { command: (e: EntreeSlash) => void; range: Range } | null = null;
          const ouvrir = (p: { items: EntreeSlash[]; query: string; range: Range; clientRect?: (() => DOMRect | null) | null; command: (e: EntreeSlash) => void }) => {
            courant = { command: p.command, range: p.range };
            magasin.majSlash({
              ouvert: true, requete: p.query, entrees: p.items, index: 0, range: p.range,
              rect: rectDe(p.clientRect?.() ?? null), executer: (e) => p.command(e),
            });
          };
          return {
            onStart: ouvrir,
            onUpdate: (p) => {
              courant = { command: p.command, range: p.range };
              const s = magasin.lire().slash;
              magasin.majSlash({
                ouvert: true, requete: p.query, entrees: p.items, range: p.range,
                index: Math.min(s.index, Math.max(0, p.items.length - 1)),
                rect: rectDe(p.clientRect?.() ?? null), executer: (e) => p.command(e),
              });
            },
            onExit: () => { courant = null; magasin.majSlash({ ouvert: false, entrees: [], range: null, executer: null }); },
            onKeyDown: ({ event }) => {
              const s = magasin.lire().slash;
              if (!s.ouvert) return false;
              const n = s.entrees.length;
              if (event.key === "ArrowDown") { magasin.majSlash({ index: n ? (s.index + 1) % n : 0 }); return true; }
              if (event.key === "ArrowUp") { magasin.majSlash({ index: n ? (s.index - 1 + n) % n : 0 }); return true; }
              if (event.key === "Enter" || event.key === "Tab") {
                const e = s.entrees[s.index];
                if (e && courant) { courant.command(e); return true; }
                return false;
              }
              if (event.key === "Escape") { magasin.majSlash({ ouvert: false }); return true; }
              return false;
            },
          };
        },
      })];
    },
  });
}

// ------------------------------------------------------------------------------------------------ comportements

export function extensionsComportement(contexte: ContexteEditeur, magasin: Magasin) {
  const ctxSlash = (): ContexteSlash => ({
    contexte,
    choisirImage: (pos) => choisirFichierImage((f) => { if (magasin.editeur) envoyerImages(magasin.editeur, contexte, f, pos); }),
  });

  const Comportements = Extension.create({
    name: "carnetComportements",
    priority: 900,

    addKeyboardShortcuts() {
      const e = this.editor;
      const bloc = () => blocCourant(e.state);
      return {
        "Mod-d": () => { const b = bloc(); return b ? dupliquer(e, b.pos) : false; },
        "Mod-Shift-ArrowUp": () => { const b = bloc(); return b ? (deplacer(e, b.pos, -1), true) : false; },
        "Mod-Shift-ArrowDown": () => { const b = bloc(); return b ? (deplacer(e, b.pos, 1), true) : false; },
        "Alt-Shift-ArrowUp": () => { const b = bloc(); return b ? (deplacer(e, b.pos, -1), true) : false; },
        "Alt-Shift-ArrowDown": () => { const b = bloc(); return b ? (deplacer(e, b.pos, 1), true) : false; },
        "Mod-Shift-9": () => { basculerTache(e); return true; },
        "Mod-Enter": () => {
          const { $from } = e.state.selection;
          for (let d = $from.depth; d > 0; d--) {
            const n = $from.node(d);
            if (n.type.name === "listItem" && n.attrs.checked != null) {
              e.view.dispatch(e.state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked: !n.attrs.checked }));
              return true;
            }
          }
          return false;
        },
        // Entrée dans le titre d'un repliable : il s'ouvre et le curseur va au début de son contenu
        Enter: () => {
          const { $head, empty } = e.state.selection;
          if (!empty || $head.parent.type.name !== "detailsSummary") return false;
          const details = $head.node(-1);
          const posDetails = $head.before(-1);
          (e.view.nodeDOM(posDetails) as HTMLElement | null)?.dispatchEvent(new CustomEvent("carnet:ouvrir"));
          const posContenu = posDetails + 1 + details.child(0).nodeSize;
          e.view.dispatch(e.state.tr.setSelection(TextSelection.near(e.state.doc.resolve(posContenu + 1), 1)).scrollIntoView());
          return true;
        },
        // Retour arrière au début d'un titre : il redevient du texte (la fusion avec le bloc précédent vient ensuite)
        Backspace: () => {
          const { $from, empty } = e.state.selection;
          if (!empty || $from.parentOffset !== 0) return false;
          if ($from.parent.type.name === "heading") return e.commands.setParagraph();
          return false;
        },
        // Tab dans un bloc de code : deux espaces (le focus ne quitte jamais l'éditeur)
        Tab: () => {
          if (e.isActive("codeBlock")) return e.commands.insertContent("  ");
          if (e.isActive("listItem") || e.isActive("table")) return false;
          return true;
        },
        "Shift-Tab": () => {
          if (e.isActive("listItem") || e.isActive("table")) return false;
          return true;
        },
        Escape: () => {
          if (magasin.lire().slash.ouvert) return false;
          const b = bloc();
          if (!b || e.state.selection instanceof NodeSelection) return false;
          e.view.dispatch(e.state.tr.setSelection(NodeSelection.create(e.state.doc, b.pos)));
          return true;
        },
      };
    },

    addInputRules() {
      const e = this.editor;
      return [
        // « [] », « [ ] », « [x] » en début de bloc : une tâche (Notion)
        new InputRule({
          find: /^\s*\[([ xX]?)\]\s$/,
          handler: ({ state, range, match }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name !== "paragraph") return null;
            const coche = match[1].toLowerCase() === "x";
            state.tr.delete(range.from, range.to);
            const li = $from.depth >= 2 && $from.node(-1).type.name === "listItem" && $from.index(-1) === 0 ? $from.before(-1) : null;
            if (li != null) {
              const n = state.tr.doc.nodeAt(li)!;
              state.tr.setNodeMarkup(li, undefined, { ...n.attrs, checked: coche });
              return;
            }
            queueMicrotask(() => {
              e.chain().toggleBulletList().run();
              const { $from: f } = e.state.selection;
              for (let d = f.depth; d > 0; d--) {
                if (f.node(d).type.name === "listItem") {
                  e.view.dispatch(e.state.tr.setNodeMarkup(f.before(d), undefined, { ...f.node(d).attrs, checked: coche }));
                  break;
                }
              }
            });
          },
        }),
        // « +++ » : un repliable
        new InputRule({
          find: /^\+\+\+\s$/,
          handler: ({ state, range }) => {
            const $from = state.doc.resolve(range.from);
            if ($from.parent.type.name !== "paragraph") return null;
            state.tr.delete(range.from, range.to);
            queueMicrotask(() => { e.commands.setDetails(); });
          },
        }),
        // Flèches typographiques
        new InputRule({ find: /->$/, handler: ({ state, range }) => { state.tr.insertText("→", range.from, range.to); } }),
        new InputRule({ find: /<-$/, handler: ({ state, range }) => { state.tr.insertText("←", range.from, range.to); } }),
        // « [[Page]] » tapé en entier : une pastille de page
        new InputRule({
          find: /\[\[([^[\]\n]+)\]\]$/,
          handler: ({ state, range, match }) => {
            state.tr.replaceWith(range.from, range.to, state.schema.nodes.wikilien.create({ valeur: match[1] }));
          },
        }),
        // « [[ » : choisir une page à lier
        new InputRule({
          find: /\[\[$/,
          handler: () => {
            window.setTimeout(async () => {
              const nom = await contexte.choisirPage();
              if (e.isDestroyed) return;
              const pos = e.state.selection.from;
              const avant = e.state.doc.textBetween(Math.max(0, pos - 2), pos);
              if (!nom) { e.commands.focus(); return; }
              const c = e.chain().focus();
              if (avant === "[[") c.deleteRange({ from: pos - 2, to: pos });
              c.insertContent([{ type: "wikilien", attrs: { valeur: nom } }, { type: "text", text: " " }]).run();
            }, 0);
            return null;
          },
        }),
      ];
    },

    addProseMirrorPlugins() {
      const e = this.editor;
      return [
        new Plugin({
          key: new PluginKey("carnetPresse"),
          props: {
            // Texte collé qui ressemble à du Markdown : converti en blocs (Mod+Maj+V : texte brut)
            clipboardTextParser: (texte, $contexte, brut) => {
              if (brut || $contexte.parent.type.spec.code || !ressembleMarkdown(texte)) {
                const lignes = texte.replace(/\r\n?/g, "\n").split("\n");
                const schema = e.schema;
                const paras = lignes.map((l) => schema.nodes.paragraph.create(null, l ? schema.text(l) : null));
                return new Slice(Fragment.from(paras), 1, 1);
              }
              const blocs = mdVersBlocs(texte.replace(/\r\n?/g, "\n"), e.schema);
              return new Slice(Fragment.from(blocs), 1, 1);
            },
            // Copie : le presse-papiers « texte » reçoit le Markdown du passage
            clipboardTextSerializer: (tranche) => {
              const blocs: PMNode[] = [];
              let enLigne = true;
              tranche.content.forEach((n) => { blocs.push(n); if (n.isBlock) enLigne = false; });
              if (enLigne) return tranche.content.textBetween(0, tranche.content.size, "\n", (n) => (n.type.name === "wikilien" ? `[[${n.attrs.valeur}]]` : ""));
              try { return blocsVersMd(blocs).replace(/\n+$/, ""); } catch { return tranche.content.textBetween(0, tranche.content.size, "\n\n"); }
            },
            handleKeyDown: (_v, ev) => {
              // ⌘K avec une sélection ou dans un lien : modifier le lien (pas la recherche de l'appli)
              if ((ev.metaKey || ev.ctrlKey) && !ev.altKey && ev.key.toLowerCase() === "k") {
                const { from, to, empty } = e.state.selection;
                if (!empty || e.isActive("link")) {
                  ev.preventDefault();
                  ev.stopPropagation();
                  ouvrirEditionLien(e, magasin, from, to);
                  return true;
                }
              }
              return false;
            },
            handleClickOn: (_v, _pos, noeud, _np, ev) => {
              // Clic sur un lien : petite barre « Ouvrir · Modifier · Retirer » ; ⌘/Ctrl + clic : ouvrir
              const a = (ev.target as Element)?.closest?.("a[href]:not(.carnet-wikilien)") as HTMLAnchorElement | null;
              if (!a || noeud.type.name === "wikilien") return false;
              if (ev.metaKey || ev.ctrlKey) { window.open(a.href, "_blank", "noopener,noreferrer"); return true; }
              const pos = e.view.posAtDOM(a, 0);
              const r = etendueLien(e, pos);
              if (r) magasin.maj({ lien: { ancre: rectDe(a)!, href: a.getAttribute("href") ?? "", edition: false, from: r.from, to: r.to } });
              return false;
            },
          },
        }),
      ];
    },
  });

  return [Comportements, extensionSlash(magasin, ctxSlash)];
}

export function etendueLien(e: Editor, pos: number): { from: number; to: number } | null {
  const $p = e.state.doc.resolve(pos);
  const type = e.schema.marks.link;
  const parent = $p.parent;
  if (!parent.isTextblock) return null;
  const debut = $p.start();
  const items: Array<{ n: PMNode; a: number; b: number }> = [];
  parent.forEach((n, off) => items.push({ n, a: debut + off, b: debut + off + n.nodeSize }));
  let i = items.findIndex((it) => pos >= it.a && pos < it.b);
  if (i === -1) i = items.findIndex((it) => pos === it.b);
  const m = i === -1 ? undefined : items[i].n.marks.find((x) => x.type === type);
  if (!m) return null;
  let j = i, k = i;
  while (j > 0 && items[j - 1].n.marks.some((x) => x.eq(m))) j--;
  while (k < items.length - 1 && items[k + 1].n.marks.some((x) => x.eq(m))) k++;
  return { from: items[j].a, to: items[k].b };
}

export function ouvrirEditionLien(e: Editor, magasin: Magasin, from: number, to: number): void {
  let f = from, t = to;
  const r = etendueLien(e, from);
  if (r && from === to) { f = r.from; t = r.to; }
  const href = (e.getAttributes("link").href as string | undefined) ?? "";
  const coords = e.view.coordsAtPos(f);
  const fin = e.view.coordsAtPos(t);
  magasin.maj({
    lien: {
      ancre: { left: coords.left, top: coords.top, right: fin.right, bottom: fin.bottom, width: Math.max(1, fin.right - coords.left), height: fin.bottom - coords.top },
      href, edition: true, from: f, to: t,
    },
  });
  void TextSelection;
}

export { ENTREES };
