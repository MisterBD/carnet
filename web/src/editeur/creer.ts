// Fabrique de l'éditeur d'une page : Tiptap 3 (extensions officielles MIT) + nos nœuds, vues et comportements.
// Le Markdown passe par notre couche (markdown/) : grammaire fermée, sérialisation réglée, fidélité mesurée.
// L'interface (menu « / », bulle, menu de bloc, liens, langages) est rendue par React dans un conteneur à part.
import { Editor, type AnyExtension } from "@tiptap/core";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import type { EditorView } from "@tiptap/pm/view";
import { CodeBlockLowlight } from "@tiptap/extension-code-block-lowlight";
import { FileHandler } from "@tiptap/extension-file-handler";
import { UndoRedo, Dropcursor, Gapcursor, Placeholder, TrailingNode } from "@tiptap/extensions";
import { createRoot, type Root } from "react-dom/client";
import { createElement } from "react";
import { extensionsSchema, BlocCode } from "./schema";
import { mdVersDoc, docVersMd, analyseurBlocs } from "./markdown/index.ts";
import type { ContexteEditeur } from "./contexte";
import type { Analyseur } from "./fidelite";
import {
  vueEncadre, vueWikilien, vueArtefact, vueImageBloc, vueImageEnLigne, vueElementListe, vueRepliable,
  vueContenuRepliable, vueCode, vueSommaire, surSelectionCode,
} from "./vues";
import { lowlightCarnet } from "./langues";
import { extensionsComportement, envoyerImages, remplacerImage, choisirFichierImage, TYPES_IMAGES, ouvrirEditionLien } from "./comportements";
import { extensionPoignee } from "./poignee";
import { Magasin } from "./ui/magasin";
import { InterfaceEditeur } from "./ui/InterfaceEditeur";
import { basculerTache } from "./menu";
import { blocCourant, deplacer } from "./blocs";

export interface OutilsClavier {
  inserer(): void;
  caseACocher(): void;
  liste(): void;
  titre(niveau: 0 | 1 | 2 | 3): void;
  gras(): void;
  italique(): void;
  surligner(): void;
  lien(): void;
  retrait(): void;
  desindenter(): void;
  monter(): void;
  descendre(): void;
  menuBloc(): void;
  annuler(): void;
  retablir(): void;
}

export interface EditeurCarnet {
  getMarkdown(): string;
  analyser: Analyseur;
  vue(): EditorView;
  /** Vue ProseMirror, ou null si l'éditeur est détruit. */
  vueOuNull(): EditorView | null;
  tiptap: Editor;
  magasin: Magasin;
  /** Remplace tout le contenu (mise à jour venue d'ailleurs), sans passer pour une modification de la personne. */
  remplacer(md: string): void;
  detruire(): Promise<void>;
  /** Curseur au début du corps (Entrée dans le titre). Crée un paragraphe si le premier bloc n'en est pas un. */
  focusDebut(): void;
  /** Curseur à la fin du corps (clic sous le dernier bloc). */
  focusFin(): void;
  /** Un menu de saisie est ouvert (« /filtre » en cours : ce n'est pas du contenu). */
  menuOuvert(): boolean;
  /** Actions de la barre au-dessus du clavier (iPhone). */
  outils: OutilsClavier;
  /** État des marques et du bloc courant (barre clavier). */
  etatFormat(): { gras: boolean; italique: boolean; surligne: boolean; lien: boolean; titre: number; liste: boolean; tache: boolean; peutAnnuler: boolean; peutRetablir: boolean };
}

export interface OptionsEditeur {
  lectureSeule?: boolean;
  /** Appelé (avec un léger délai) après chaque modification du document par la personne. */
  surModification?: (md: string) => void;
  /** Appelé tout de suite à chaque modification faite par la personne (frappe, menu, bouton, glisser…). */
  surInteraction?: () => void;
}

export async function creerEditeur(racine: HTMLElement, corps: string, contexte: ContexteEditeur, options: OptionsEditeur = {}): Promise<EditeurCarnet> {
  const magasin = new Magasin();
  // Lignes vides en tête du corps (page sans titre « # ») : gardées telles quelles
  const prefixe = /^(?:[ \t]*\n)+/.exec(corps)?.[0] ?? "";

  const choisirPourBloc = (pos: number) => choisirFichierImage((f) => { if (f[0] && magasin.editeur) remplacerImage(magasin.editeur, contexte, pos, f[0]); });

  const vues: Record<string, unknown> = {
    encadre: vueEncadre(),
    wikilien: vueWikilien(contexte),
    artefact: vueArtefact(contexte),
    imageBloc: vueImageBloc(contexte, choisirPourBloc),
    imageEnLigne: vueImageEnLigne(contexte),
    listItem: vueElementListe(),
    details: vueRepliable(contexte),
    detailsContent: vueContenuRepliable(),
    sommaire: vueSommaire(),
  };

  const CodeAvecVue = CodeBlockLowlight.extend({
    addAttributes() { return BlocCode.config.addAttributes!.call(this as never) as never; },
    addNodeView() { return vueCode(contexte, magasin) as never; },
  }).configure({ lowlight: lowlightCarnet, defaultLanguage: null, enableTabIndentation: false, HTMLAttributes: { spellcheck: "false" } });

  const schema: AnyExtension[] = extensionsSchema().map((e) => {
    if (e.name === "codeBlock") return CodeAvecVue;
    const v = vues[e.name];
    return v ? e.extend({ addNodeView() { return v as never; } }) : e;
  });

  const extensions: AnyExtension[] = [
    ...schema,
    UndoRedo.configure({ depth: 200, newGroupDelay: 600 }),
    Dropcursor.configure({ color: "var(--indigo)", width: 2, class: "carnet-depose" }),
    Gapcursor,
    TrailingNode.configure({ node: "paragraph", notAfter: ["paragraph"] }),
    Placeholder.configure({
      showOnlyCurrent: true,
      includeChildren: true,
      placeholder: ({ node, editor: e }) => {
        if (node.type.name === "heading") return `Titre ${node.attrs.level}`;
        if (node.type.name === "detailsSummary") return "Titre du repliable";
        if (node.type.name === "paragraph") {
          const { $from } = e.state.selection;
          if ($from.depth >= 2 && $from.node(-1).type.name === "listItem") return $from.node(-1).attrs.checked != null ? "À faire" : "Liste";
          return "Écris, ou tape « / » pour insérer un bloc";
        }
        return "";
      },
    }),
    FileHandler.configure({
      allowedMimeTypes: TYPES_IMAGES,
      onPaste: (e, fichiers) => envoyerImages(e, contexte, fichiers, null),
      onDrop: (e, fichiers, pos) => envoyerImages(e, contexte, fichiers, pos),
    }),
    ...extensionsComportement(contexte, magasin),
    extensionPoignee(magasin),
  ];

  let silencieux = 0;
  let minuterie: number | null = null;
  // Créé sans être monté : le document est posé AVANT le premier rendu (un seul rendu de la page)
  const editor = new Editor({
    element: null,
    extensions,
    editable: !options.lectureSeule,
    injectCSS: false,
    content: null,
    editorProps: {
      attributes: { class: "carnet-pm", spellcheck: "true", autocapitalize: "sentences", "aria-label": "Contenu de la page", lang: "fr" },
      scrollThreshold: { top: 80, bottom: 120, left: 0, right: 0 },
      scrollMargin: { top: 80, bottom: 120, left: 0, right: 0 },
    },
    onTransaction: () => { magasin.maj({ rev: magasin.lire().rev + 1 }); },
    onSelectionUpdate: () => { surSelectionCode(); },
    onFocus: () => { magasin.maj({ focus: true }); },
    onBlur: () => { magasin.maj({ focus: false }); },
    onUpdate: () => {
      if (silencieux > 0) return;
      // Toute modification hors chargement et mise à jour en direct vient de la personne (clavier, menus flottants, boutons)
      options.surInteraction?.();
      if (minuterie) window.clearTimeout(minuterie);
      minuterie = window.setTimeout(() => {
        minuterie = null;
        if (silencieux > 0 || editor.isDestroyed) return;
        options.surModification?.(getMarkdown());
      }, 120);
    },
  });
  magasin.editeur = editor;

  // Contenu initial : document construit par notre couche Markdown, sans passer pour une modification
  const poser = (md: string) => {
    const doc = mdVersDoc(md, editor.schema);
    const ancienne = editor.state.selection;
    let etat = EditorState.create({ doc, plugins: editor.state.plugins, schema: editor.schema });
    if (editor.isFocused) {
      const p = Math.min(ancienne.from, doc.content.size);
      try { etat = etat.apply(etat.tr.setSelection(TextSelection.near(doc.resolve(p)))); } catch { /* sélection impossible */ }
    }
    editor.view.updateState(etat);
    // le nœud de fin (paragraphe après un tableau…) est ajouté par appendTransaction au premier tour : on le force
    editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  };
  silencieux++;
  editor.view.updateState(EditorState.create({ doc: mdVersDoc(corps, editor.schema), schema: editor.schema }));
  editor.mount(racine);
  // le nœud de fin (paragraphe après un tableau…) est ajouté par appendTransaction au premier tour : on le force
  editor.view.dispatch(editor.state.tr.setMeta("addToHistory", false));
  silencieux--;

  const getMarkdown = () => prefixe + docVersMd(editor.state.doc);

  // Interface React (menus, bulle, menu de bloc) dans un conteneur à part, au-dessus de la page
  const hote = document.createElement("div");
  hote.className = "carnet-interface";
  document.body.append(hote);
  const racineUI: Root = createRoot(hote);
  // rendue juste après le premier affichage de la page (rien n'y est visible à l'ouverture)
  const rendreUI = () => { if (!editor.isDestroyed) racineUI.render(createElement(InterfaceEditeur, { magasin, contexte })); };
  window.setTimeout(rendreUI, 0);

  // Clic sous le dernier bloc : curseur à la fin (paragraphe ajouté si le dernier bloc n'en est pas un)
  const surClicFond = (e: MouseEvent) => {
    if (e.target !== racine || !editor.isEditable) return;
    const r = editor.view.dom.getBoundingClientRect();
    if (e.clientY > r.bottom - 8) { e.preventDefault(); focusFin(); }
  };
  racine.addEventListener("mousedown", surClicFond);

  const focusFin = () => {
    const doc = editor.state.doc;
    const der = doc.lastChild;
    if (!der || der.type.name !== "paragraph" || der.content.size > 0) {
      editor.chain().insertContentAt(doc.content.size, { type: "paragraph" }).focus("end").run();
    } else editor.commands.focus("end");
  };

  const focusDebut = () => {
    const premier = editor.state.doc.firstChild;
    if (!premier || !premier.isTextblock) editor.chain().insertContentAt(0, { type: "paragraph" }).focus("start").run();
    else editor.commands.focus("start");
  };

  const outils: OutilsClavier = {
    inserer: () => {
      const { $from, empty } = editor.state.selection;
      const vide = $from.parent.type.name === "paragraph" && $from.parent.content.size === 0 && empty;
      if (vide) { editor.chain().focus().insertContent("/").run(); return; }
      const b = blocCourant(editor.state);
      const fin = b ? b.pos + b.node.nodeSize : $from.after(1);
      const tr = editor.state.tr.insert(fin, editor.schema.nodes.paragraph.create());
      tr.setSelection(TextSelection.create(tr.doc, fin + 1));
      editor.view.dispatch(tr.scrollIntoView());
      editor.chain().focus().insertContent("/").run();
    },
    caseACocher: () => basculerTache(editor),
    liste: () => {
      if (editor.isActive("listItem") && editor.isActive("bulletList")) {
        const { $from } = editor.state.selection;
        for (let d = $from.depth; d > 0; d--) {
          const n = $from.node(d);
          if (n.type.name === "listItem" && n.attrs.checked != null) {
            editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked: null }));
            return;
          }
        }
      }
      editor.chain().focus().toggleBulletList().run();
    },
    titre: (niveau) => {
      if (niveau === 0) editor.chain().focus().setParagraph().run();
      else editor.chain().focus().toggleHeading({ level: niveau }).run();
    },
    gras: () => { editor.chain().focus().toggleBold().run(); },
    italique: () => { editor.chain().focus().toggleItalic().run(); },
    surligner: () => { editor.chain().focus().toggleHighlight().run(); },
    lien: () => { const { from, to } = editor.state.selection; ouvrirEditionLien(editor, magasin, from, to); },
    retrait: () => { editor.chain().focus().sinkListItem("listItem").run(); },
    desindenter: () => { editor.chain().focus().liftListItem("listItem").run(); },
    monter: () => { const b = blocCourant(editor.state); if (b) deplacer(editor, b.pos, -1); },
    descendre: () => { const b = blocCourant(editor.state); if (b) deplacer(editor, b.pos, 1); },
    menuBloc: () => {
      const b = blocCourant(editor.state);
      if (b) magasin.maj({ menuBloc: { pos: b.pos, ancre: null, feuille: true, vue: "principal" } });
    },
    annuler: () => { editor.chain().focus().undo().run(); },
    retablir: () => { editor.chain().focus().redo().run(); },
  };

  return {
    getMarkdown,
    analyser: analyseurBlocs as unknown as Analyseur,
    vue: () => editor.view,
    vueOuNull: () => (editor.isDestroyed ? null : editor.view),
    tiptap: editor,
    magasin,
    remplacer: (md: string) => {
      silencieux++;
      try { poser(md); } finally {
        window.setTimeout(() => { silencieux--; }, 200);
      }
    },
    detruire: async () => {
      if (minuterie) window.clearTimeout(minuterie);
      racine.removeEventListener("mousedown", surClicFond);
      magasin.editeur = null;
      // l'interface est démontée après le cycle de rendu en cours (React n'aime pas un démontage synchrone)
      window.setTimeout(() => { racineUI.unmount(); hote.remove(); }, 0);
      editor.destroy();
    },
    focusDebut,
    focusFin,
    menuOuvert: () => magasin.menuOuvert(),
    outils,
    etatFormat: () => {
      const { $from } = editor.state.selection;
      let tache = false;
      for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "listItem") { tache = $from.node(d).attrs.checked != null; break; }
      return {
        gras: editor.isActive("bold"), italique: editor.isActive("italic"), surligne: editor.isActive("highlight"),
        lien: editor.isActive("link"), titre: editor.isActive("heading") ? Number(editor.getAttributes("heading").level) : 0,
        liste: editor.isActive("bulletList") && !tache, tache,
        peutAnnuler: editor.can().undo(), peutRetablir: editor.can().redo(),
      };
    },
  };
}
