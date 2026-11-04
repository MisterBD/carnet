// Schéma de l'éditeur de Carnet (Tiptap 3, extensions officielles MIT + nœuds maison).
// Ce module est « pur » : aucune vue, aucun DOM. Les vues (encadrés, cartes, aperçus…) sont branchées dans creer.ts.
// Chaque attribut existe pour réécrire le fichier à l'identique (marqueurs d'origine, formes, alignements…).
import { Extension, Mark, Node, mergeAttributes, type AnyExtension } from "@tiptap/core";
import { Document } from "@tiptap/extension-document";
import { Paragraph } from "@tiptap/extension-paragraph";
import { Text } from "@tiptap/extension-text";
import { Heading } from "@tiptap/extension-heading";
import { Blockquote } from "@tiptap/extension-blockquote";
import { Bold } from "@tiptap/extension-bold";
import { Italic } from "@tiptap/extension-italic";
import { Strike } from "@tiptap/extension-strike";
import { Code } from "@tiptap/extension-code";
import { Underline } from "@tiptap/extension-underline";
import { Link } from "@tiptap/extension-link";
import { HardBreak } from "@tiptap/extension-hard-break";
import { HorizontalRule } from "@tiptap/extension-horizontal-rule";
import { CodeBlock } from "@tiptap/extension-code-block";
import { BulletList, OrderedList, ListItem } from "@tiptap/extension-list";
import { Table, TableRow, TableHeader, TableCell } from "@tiptap/extension-table";
import { Details, DetailsSummary, DetailsContent } from "@tiptap/extension-details";
import { Highlight } from "@tiptap/extension-highlight";

export const COULEURS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;

const attr = (defaut: unknown, opts: Record<string, unknown> = {}) => ({ default: defaut, rendered: false, ...opts });

/** « ecart » : nombre de lignes vides entre ce bloc et le précédent dans le fichier (null : bloc nouveau).
 *  Réécrit pareil quand c'est sans danger pour le sens (0 = blocs collés, 2+ = lignes vides en plus). */
const AttributsCarnet = Extension.create({
  name: "attributsCarnet",
  addGlobalAttributes() {
    return [{
      types: ["paragraph", "heading", "bulletList", "orderedList", "listItem", "codeBlock", "blockquote", "table", "horizontalRule",
        "encadre", "details", "blocBrut", "artefact", "imageBloc", "sommaire"],
      attributes: { ecart: attr(null, { keepOnSplit: false }) },
    }];
  },
});

// ---------------------------------------------------------------------------------------------- blocs standard

const Titre = Heading.extend({
  addAttributes() {
    return { ...this.parent?.(), setext: attr(false, { keepOnSplit: false }) };
  },
}).configure({ levels: [1, 2, 3, 4, 5, 6] });

const Separateur = HorizontalRule.extend({
  addAttributes() { return { brut: attr("---") }; },
});

const Saut = HardBreak.extend({
  addAttributes() { return { forme: attr("antislash") }; },
});

const ListePuces = BulletList.extend({
  addAttributes() { return { ...this.parent?.(), marqueur: attr("-"), aere: attr(false) }; },
});

const ListeNumeros = OrderedList.extend({
  addAttributes() { return { ...this.parent?.(), marqueur: attr("."), aere: attr(false) }; },
});

export const ElementListe = ListItem.extend({
  addAttributes() {
    return {
      checked: {
        default: null,
        keepOnSplit: true,
        parseHTML: (el: HTMLElement) => (el.hasAttribute("data-coche") ? el.getAttribute("data-coche") === "true" : null),
        renderHTML: (a: Record<string, unknown>) => (a.checked == null ? {} : { "data-coche": String(a.checked) }),
      },
      aere: attr(false),
      sansParagraphe: attr(false, { keepOnSplit: false }),
    };
  },
});

export const BlocCode = CodeBlock.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      meta: attr(null),
      cloture: attr("```"),
      indente: attr(false),
    };
  },
});

// ---------------------------------------------------------------------------------------------- tableaux

const alignement = {
  align: {
    default: null,
    parseHTML: (el: HTMLElement) => el.style.textAlign || el.getAttribute("align") || null,
    renderHTML: (a: Record<string, unknown>) => (a.align ? { style: `text-align: ${a.align}` } : {}),
  },
};

export const Tableau = Table.extend({
  addAttributes() {
    return { ...this.parent?.(), separateur: attr(null), colonnes: attr(0) };
  },
}).configure({ resizable: false, renderWrapper: true, cellMinWidth: 96, HTMLAttributes: { class: "carnet-tableau" } });

const CelluleTete = TableHeader.extend({
  content: "paragraph",
  addAttributes() { return { ...this.parent?.(), ...alignement }; },
});
const Cellule = TableCell.extend({
  content: "paragraph",
  addAttributes() { return { ...this.parent?.(), ...alignement }; },
});

// ---------------------------------------------------------------------------------------------- repliables

export const Repliable = Details.extend({
  addAttributes() {
    return {
      ouvert: attr(false),
      forme: attr("aere"),
      sansResume: attr(false),
    };
  },
}).configure({ persist: false, openClassName: "est-ouvert", HTMLAttributes: { class: "carnet-repliable" } });

const ResumeRepliable = DetailsSummary.extend({ marks: "" });

// ---------------------------------------------------------------------------------------------- nœuds maison

export const Encadre = Node.create({
  name: "encadre",
  group: "block",
  content: "block+",
  defining: true,
  addAttributes() {
    return {
      genre: { default: "NOTE", parseHTML: (el: HTMLElement) => el.getAttribute("data-encadre") || "NOTE", renderHTML: (a: Record<string, unknown>) => ({ "data-encadre": a.genre }) },
      titre: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-titre") || "", renderHTML: (a: Record<string, unknown>) => (a.titre ? { "data-titre": a.titre } : {}) },
      pli: attr(""),
    };
  },
  parseHTML() { return [{ tag: "div[data-encadre]", contentElement: ".carnet-encadre__contenu" }]; },
  renderHTML({ HTMLAttributes }) {
    return ["div", mergeAttributes(HTMLAttributes, { class: "carnet-encadre" }), ["div", { class: "carnet-encadre__contenu" }, 0]];
  },
});

export const Wikilien = Node.create({
  name: "wikilien",
  group: "inline",
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,
  addAttributes() {
    return { valeur: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-wikilien") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-wikilien": a.valeur }) } };
  },
  parseHTML() { return [{ tag: "a[data-wikilien]" }]; },
  renderHTML({ HTMLAttributes, node }) {
    return ["a", mergeAttributes(HTMLAttributes, { class: "carnet-wikilien" }), `[[${node.attrs.valeur}]]`];
  },
  renderText({ node }) { return `[[${node.attrs.valeur}]]`; },
});

export const Artefact = Node.create({
  name: "artefact",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  isolating: true,
  addAttributes() {
    return {
      url: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-artefact") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-artefact": a.url }) },
      titre: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-titre") ?? "", renderHTML: (a: Record<string, unknown>) => ({ "data-titre": a.titre }) },
      image: attr(null), alt: attr(null),
    };
  },
  parseHTML() { return [{ tag: "div[data-artefact]" }]; },
  renderHTML({ HTMLAttributes }) { return ["div", mergeAttributes(HTMLAttributes, { class: "carnet-artefact" })]; },
});

export const ImageBloc = Node.create({
  name: "imageBloc",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      src: { default: "", parseHTML: (el: HTMLElement) => el.querySelector("img")?.getAttribute("data-src") ?? el.querySelector("img")?.getAttribute("src") ?? "", renderHTML: () => ({}) },
      alt: { default: "", parseHTML: (el: HTMLElement) => el.querySelector("img")?.getAttribute("alt") ?? "", renderHTML: () => ({}) },
      titre: attr(null),
      envoi: attr(null),
    };
  },
  parseHTML() { return [{ tag: "figure[data-image-bloc]" }]; },
  renderHTML({ node }) {
    return ["figure", { "data-image-bloc": "", class: "carnet-image" }, ["img", { "data-src": node.attrs.src, alt: node.attrs.alt }]];
  },
});

export const ImageEnLigne = Node.create({
  name: "imageEnLigne",
  group: "inline",
  inline: true,
  atom: true,
  addAttributes() {
    return {
      src: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("data-src") ?? "", renderHTML: () => ({}) },
      alt: { default: "", parseHTML: (el: HTMLElement) => el.getAttribute("alt") ?? "", renderHTML: (a: Record<string, unknown>) => ({ alt: a.alt }) },
      titre: attr(null),
    };
  },
  parseHTML() { return [{ tag: "img[data-image-en-ligne]" }]; },
  renderHTML({ node }) { return ["img", { "data-image-en-ligne": "", "data-src": node.attrs.src, alt: node.attrs.alt }]; },
});

/** Texte brut (HTML libre, définitions, notes…) : affiché et modifiable comme du texte, jamais interprété. */
export const BlocBrut = Node.create({
  name: "blocBrut",
  group: "block",
  content: "text*",
  marks: "",
  code: true,
  defining: true,
  addAttributes() { return { origine: attr("html") }; },
  parseHTML() { return [{ tag: "pre[data-brut]", preserveWhitespace: "full" }]; },
  renderHTML() { return ["pre", { "data-brut": "", class: "carnet-brut-bloc", spellcheck: "false" }, 0]; },
});

export const Sommaire = Node.create({
  name: "sommaire",
  group: "block",
  atom: true,
  selectable: true,
  draggable: true,
  parseHTML() { return [{ tag: "nav[data-sommaire]" }]; },
  renderHTML() { return ["nav", { "data-sommaire": "", class: "carnet-sommaire" }]; },
});

// ---------------------------------------------------------------------------------------------- marques

/** Code en ligne : peut être gras ou en italique (« **`x`** »), contrairement au réglage par défaut de Tiptap. */
const CodeEnLigne = Code.extend({ excludes: "" });
const Gras = Bold.extend({ addAttributes() { return { marqueur: attr("*") }; } });
const Italique = Italic.extend({ addAttributes() { return { marqueur: attr("_") }; } });
const Barre = Strike.extend({ addAttributes() { return { marqueur: attr("~~") }; } });
export const Lien = Link.extend({
  addAttributes() { return { ...this.parent?.(), forme: attr("normal") }; },
}).configure({
  openOnClick: false,
  autolink: true,
  linkOnPaste: true,
  enableClickSelection: false,
  defaultProtocol: "https",
  HTMLAttributes: { rel: "noopener noreferrer nofollow", target: "_blank", class: null },
});
const Surlignage = Highlight.extend({ addAttributes() { return { forme: attr("egal") }; } }).configure({ multicolor: false });

function marqueCouleur(nom: string, donnee: string) {
  return Mark.create({
    name: nom,
    addAttributes() {
      return {
        c: {
          default: "gray",
          parseHTML: (el: HTMLElement) => {
            const v = el.getAttribute(donnee);
            return (COULEURS as readonly string[]).includes(v ?? "") ? v : null;
          },
          renderHTML: (a: Record<string, unknown>) => ({ [donnee]: a.c }),
        },
      };
    },
    parseHTML() { return [{ tag: `span[${donnee}]`, getAttrs: (el: HTMLElement | string) => (typeof el !== "string" && (COULEURS as readonly string[]).includes(el.getAttribute(donnee) ?? "") ? null : false) }]; },
    renderHTML({ HTMLAttributes }) { return ["span", HTMLAttributes, 0]; },
  });
}
export const CouleurTexte = marqueCouleur("couleurTexte", "data-couleur");
export const CouleurFond = marqueCouleur("couleurFond", "data-fond");

/** HTML en ligne non reconnu, références, notes : texte gardé tel quel. */
export const Brut = Mark.create({
  name: "brut",
  inclusive: false,
  code: true,
  parseHTML() { return [{ tag: "span[data-brut]" }]; },
  renderHTML() { return ["span", { "data-brut": "", class: "carnet-brut" }, 0]; },
});

/** Extensions qui définissent le schéma (sans les vues ni les comportements d'interface). */
export function extensionsSchema(): AnyExtension[] {
  return [
    Document, Paragraph, Text, Titre, Blockquote, Separateur, Saut, ListePuces, ListeNumeros, ElementListe, BlocCode,
    Tableau, TableRow, CelluleTete, Cellule, Repliable, ResumeRepliable, DetailsContent,
    Encadre, Wikilien, Artefact, ImageBloc, ImageEnLigne, BlocBrut, Sommaire,
    Gras, Italique, Barre, CodeEnLigne, Underline, Lien, Surlignage, CouleurTexte, CouleurFond, Brut,
    AttributsCarnet,
  ];
}
