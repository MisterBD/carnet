// Menu « / » de Carnet : entrées en français, alias (h1, todo, bullet, divider, toggle…), recherche sans accents.
import type { Editor, Range } from "@tiptap/core";
import { plier } from "../../../shared/page.ts";
import type { ContexteEditeur } from "./contexte";
import { lienVersArtefact } from "./vues";

export const MODELE_MERMAID = `flowchart LR
  A[Idée] --> B{On y va ?}
  B -->|oui| C[Action]
  B -->|plus tard| D[Liste d'attente]`;

export const MODELE_VEGA = `{
  "$schema": "https://vega.github.io/schema/vega-lite/v6.json",
  "data": {"values": [
    {"mois": "Juil", "valeur": 12}, {"mois": "Août", "valeur": 18},
    {"mois": "Sept", "valeur": 15}, {"mois": "Oct", "valeur": 21}
  ]},
  "mark": {"type": "bar", "cornerRadiusEnd": 4},
  "encoding": {
    "x": {"field": "mois", "type": "ordinal", "sort": null, "title": null},
    "y": {"field": "valeur", "type": "quantitative", "title": "Valeur"}
  }
}`;

export type Icone =
  | "sousPage" | "lienPage" | "texte" | "h1" | "h2" | "h3" | "puces" | "numeros" | "tache" | "citation" | "repliable"
  | "separateur" | "NOTE" | "TIP" | "IMPORTANT" | "WARNING" | "CAUTION" | "tableau" | "image" | "code" | "schema"
  | "graphique" | "artefact" | "date" | "sommaire";

export interface EntreeSlash {
  cle: string;
  groupe: string;
  libelle: string;
  aide?: string;
  icone: Icone;
  mots: string;
  /** raccourci Markdown équivalent, affiché à droite */
  md?: string;
  executer: (editor: Editor, range: Range, ctx: ContexteSlash) => void;
}

export interface ContexteSlash {
  contexte: ContexteEditeur;
  choisirImage: (pos: number | null) => void;
}

const date = () => {
  const d = new Date();
  const z = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
};

/** Paragraphe courant vide (après effacement du « /requête ») : on le transforme ; sinon on insère après. */
function blocVide(editor: Editor): boolean {
  const { $from } = editor.state.selection;
  return $from.parent.type.name === "paragraph" && $from.parent.content.size === 0;
}

function insererBloc(editor: Editor, range: Range, contenu: Record<string, unknown>, curseurDedans = false): void {
  const chaine = editor.chain().focus().deleteRange(range);
  chaine.run();
  const { $from } = editor.state.selection;
  if (blocVide(editor)) {
    const debut = $from.before($from.depth);
    editor.chain().insertContentAt({ from: debut, to: debut + $from.parent.nodeSize }, contenu).run();
    if (curseurDedans) editor.commands.setTextSelection(debut + 1);
  } else {
    const fin = $from.after($from.depth);
    editor.chain().insertContentAt(fin, contenu).run();
    if (curseurDedans) editor.commands.setTextSelection(fin + 1);
  }
}

function insererEnLigne(editor: Editor, valeur: string, seulDansParagraphe: boolean): void {
  const c = editor.chain().focus().insertContent({ type: "wikilien", attrs: { valeur } });
  if (!seulDansParagraphe) c.insertContent(" ");
  c.run();
}

const GENRES: Array<[string, string, string]> = [
  ["NOTE", "Note", "info bleu"],
  ["TIP", "Astuce", "conseil vert succes"],
  ["IMPORTANT", "Important", "violet"],
  ["WARNING", "Attention", "avertissement ambre orange"],
  ["CAUTION", "Prudence", "danger rouge erreur"],
];

export const ENTREES: EntreeSlash[] = [
  {
    cle: "sous-page", groupe: "Pages", libelle: "Sous-page", aide: "Crée une page dans celle-ci", icone: "sousPage",
    mots: "page nouvelle enfant creer subpage",
    executer: (editor, range, { contexte }) => {
      editor.chain().focus().deleteRange(range).run();
      void contexte.creerSousPage().then((nom) => {
        if (!nom) return;
        if (blocVide(editor)) insererEnLigne(editor, nom, true);
        else {
          const { $from } = editor.state.selection;
          const fin = $from.after($from.depth);
          editor.chain().insertContentAt(fin, { type: "paragraph", content: [{ type: "wikilien", attrs: { valeur: nom } }] }).run();
        }
        contexte.ouvrirPage(nom);
      });
    },
  },
  {
    cle: "lien-page", groupe: "Pages", libelle: "Lien vers une page", aide: "Aussi : [[", icone: "lienPage",
    mots: "page lien relier mention wikilien link",
    executer: (editor, range, { contexte }) => {
      editor.chain().focus().deleteRange(range).run();
      void contexte.choisirPage().then((nom) => { if (nom) { editor.commands.focus(); insererEnLigne(editor, nom, false); } });
    },
  },
  { cle: "texte", groupe: "Texte", libelle: "Texte", icone: "texte", mots: "paragraphe texte normal text p",
    executer: (e, r) => e.chain().focus().deleteRange(r).setParagraph().run() },
  { cle: "h1", groupe: "Texte", libelle: "Titre 1", icone: "h1", md: "#", mots: "titre heading grand h1 title",
    executer: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 1 }).run() },
  { cle: "h2", groupe: "Texte", libelle: "Titre 2", icone: "h2", md: "##", mots: "titre heading moyen h2 sous-titre",
    executer: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 2 }).run() },
  { cle: "h3", groupe: "Texte", libelle: "Titre 3", icone: "h3", md: "###", mots: "titre heading petit h3",
    executer: (e, r) => e.chain().focus().deleteRange(r).setNode("heading", { level: 3 }).run() },
  { cle: "puces", groupe: "Texte", libelle: "Liste à puces", icone: "puces", md: "-", mots: "liste puces bullet ul",
    executer: (e, r) => e.chain().focus().deleteRange(r).toggleBulletList().run() },
  { cle: "numeros", groupe: "Texte", libelle: "Liste numérotée", icone: "numeros", md: "1.", mots: "liste numerotee nombres ordonnee ol numbered",
    executer: (e, r) => e.chain().focus().deleteRange(r).toggleOrderedList().run() },
  { cle: "tache", groupe: "Texte", libelle: "Tâche", aide: "Case à cocher", icone: "tache", md: "[]", mots: "tache case cocher todo checklist checkbox a faire",
    executer: (e, r) => { e.chain().focus().deleteRange(r).run(); basculerTache(e, true); } },
  { cle: "citation", groupe: "Texte", libelle: "Citation", icone: "citation", md: ">", mots: "citation quote extrait",
    executer: (e, r) => e.chain().focus().deleteRange(r).toggleBlockquote().run() },
  { cle: "repliable", groupe: "Texte", libelle: "Repliable", aide: "Bloc qu'on ouvre et ferme", icone: "repliable", md: "+++",
    mots: "repliable depliable toggle details accordeon plier",
    executer: (e, r) => { e.chain().focus().deleteRange(r).setDetails().run(); } },
  { cle: "separateur", groupe: "Texte", libelle: "Séparateur", icone: "separateur", md: "---", mots: "separateur ligne trait divider hr",
    executer: (e, r) => e.chain().focus().deleteRange(r).setHorizontalRule().run() },
  ...GENRES.map(([g, nom, mots]): EntreeSlash => ({
    cle: `encadre-${g}`, groupe: "Encadrés", libelle: `Encadré ${nom.toLowerCase()}`, icone: g as Icone,
    mots: `encadre callout alerte ${nom} ${mots}`,
    executer: (e, r) => { e.chain().focus().deleteRange(r).wrapIn("encadre", { genre: g, titre: "", pli: "" }).run(); },
  })),
  { cle: "tableau", groupe: "Insérer", libelle: "Tableau", icone: "tableau", mots: "tableau table grille colonnes",
    executer: (e, r) => { e.chain().focus().deleteRange(r).run(); e.chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); } },
  { cle: "image", groupe: "Insérer", libelle: "Image", aide: "Envoyer une photo", icone: "image", mots: "image photo illustration img picture",
    executer: (e, r, { choisirImage }) => { e.chain().focus().deleteRange(r).run(); choisirImage(null); } },
  { cle: "code", groupe: "Insérer", libelle: "Code", icone: "code", md: "```", mots: "code programme snippet",
    executer: (e, r) => e.chain().focus().deleteRange(r).setCodeBlock().run() },
  { cle: "schema", groupe: "Insérer", libelle: "Schéma", aide: "Mermaid", icone: "schema", mots: "schema diagramme mermaid flux organigramme",
    executer: (e, r) => insererBloc(e, r, { type: "codeBlock", attrs: { language: "mermaid" }, content: [{ type: "text", text: MODELE_MERMAID }] }) },
  { cle: "graphique", groupe: "Insérer", libelle: "Graphique", aide: "Vega-Lite", icone: "graphique", mots: "graphique courbe barres chart vega",
    executer: (e, r) => insererBloc(e, r, { type: "codeBlock", attrs: { language: "vega-lite" }, content: [{ type: "text", text: MODELE_VEGA }] }) },
  {
    cle: "artefact", groupe: "Insérer", libelle: "Artefact", aide: "Page HTML isolée", icone: "artefact", mots: "artefact html tableau de bord dashboard",
    executer: (editor, range, { contexte }) => {
      editor.chain().focus().deleteRange(range).run();
      void contexte.choisirArtefact().then((a) => {
        if (!a) return;
        const url = lienVersArtefact(contexte.dossier, a.chemin);
        insererBloc(editor, { from: editor.state.selection.from, to: editor.state.selection.from }, { type: "artefact", attrs: { url, titre: a.titre } });
      });
    },
  },
  { cle: "date", groupe: "Insérer", libelle: "Date du jour", aide: "Lien vers le journal", icone: "date", mots: "date aujourd'hui jour calendrier today",
    executer: (e, r) => { e.chain().focus().deleteRange(r).insertContent([{ type: "wikilien", attrs: { valeur: date() } }, { type: "text", text: " " }]).run(); } },
  { cle: "sommaire", groupe: "Insérer", libelle: "Sommaire", aide: "Liste des titres", icone: "sommaire", mots: "sommaire table des matieres toc plan",
    executer: (e, r) => insererBloc(e, r, { type: "sommaire" }) },
];

/** Passe le bloc courant en tâche (liste à puces + case), ou retire la case. */
export function basculerTache(editor: Editor, forcer = false): void {
  const { $from } = editor.state.selection;
  for (let d = $from.depth; d > 0; d--) {
    const n = $from.node(d);
    if (n.type.name === "listItem") {
      const checked = forcer ? false : n.attrs.checked == null ? false : null;
      editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(d), undefined, { ...n.attrs, checked }));
      return;
    }
  }
  if (editor.chain().focus().toggleBulletList().run()) basculerTache(editor, true);
}

/** Filtre sans accents, plusieurs mots ; les libellés qui commencent par la requête d'abord. */
export function filtrer(requete: string, entrees = ENTREES): EntreeSlash[] {
  const f = plier(requete.trim());
  if (!f) return entrees;
  const mots = f.split(/\s+/);
  const notes: Array<[EntreeSlash, number]> = [];
  entrees.forEach((e, i) => {
    const lib = plier(e.libelle);
    const botte = `${lib} ${plier(e.mots)} ${e.md ?? ""}`;
    if (!mots.every((m) => botte.includes(m))) return;
    let note = i;
    if (lib.startsWith(f)) note -= 1000;
    else if (plier(e.mots).split(/\s+/).some((m) => m.startsWith(mots[0]))) note -= 500;
    notes.push([e, note]);
  });
  return notes.sort((a, b) => a[1] - b[1]).map(([e]) => e);
}
