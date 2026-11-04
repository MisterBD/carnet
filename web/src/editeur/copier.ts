// Lot 6 V3 « Pages » : bouton « Copier » des citations, encadrés et blocs de code (bibliothèque de prompts).
// Le texte copié est le « texte utile » du bloc, tel qu'il est écrit dans le fichier :
//   - bloc de code : son contenu exact (sans clôtures ni langage, aucun saut de ligne ajouté) ;
//   - citation / encadré : les lignes du fichier SANS le préfixe « > » (un niveau) ni, pour l'encadré, la ligne
//     « [!NOTE] titre » (le titre de l'encadré n'est pas copié) ; listes, sauts de ligne, lignes vides et marques
//     Markdown en ligne (**gras**…) gardés à l'identique. Le bloc est retrouvé dans le Markdown chargé dans
//     l'éditeur (même contenu) ; s'il a été modifié depuis (ou s'il est imbriqué dans une liste), son contenu est
//     écrit comme Carnet l'enregistrerait (même couche Markdown que le fichier).
// Copier ne crée AUCUNE transaction : ni modification, ni enregistrement, ni révision, ni état « vu ».
import { Extension } from "@tiptap/core";
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { analyser, blocsVersMd, mdVersBlocs } from "./markdown/index.ts";
import { ic } from "./icones";
import "../styles/pages-copier.css";

/** Markdown chargé dans chaque éditeur (création et mises à jour en direct : `poserSource`, appelé par creer.ts). */
const sources = new WeakMap<object, string>();
export function poserSource(editeur: object, md: string): void { sources.set(editeur, md); }

/** Même bloc, à l'attribut « ecart » près (lignes vides AVANT le bloc : dépend de son voisin, pas de lui). */
function memeBloc(a: PMNode, b: PMNode): boolean {
  if (a.type !== b.type) return false;
  const { ecart: _a, ...aa } = a.attrs;
  const { ecart: _b, ...bb } = b.attrs;
  return JSON.stringify(aa) === JSON.stringify(bb) && a.content.eq(b.content);
}

/** Lignes du fichier d'une citation ou d'un encadré de premier niveau, sans « > » ni ligne d'en-tête d'encadré. */
function depuisSource(node: PMNode, src: string, schema: Schema): string | null {
  for (const m of analyser(src).children ?? []) {
    if (m.type !== "blockquote" && m.type !== "encadre") continue;
    const d = m.position?.start.offset;
    const f = m.position?.end.offset;
    if (d == null || f == null) continue;
    const tranche = src.slice(d, f);
    const blocs = mdVersBlocs(tranche, schema);
    if (blocs.length !== 1 || !memeBloc(blocs[0], node)) continue;
    const lignes = tranche.split("\n").map((l) => l.replace(/^ {0,3}> ?/, ""));
    if (m.type === "encadre") lignes.shift();
    return lignes.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
  }
  return null;
}

/** Texte utile d'un bloc citation / encadré / code (`editeur` : celui qui l'affiche, pour retrouver le fichier). */
export function texteUtile(node: PMNode, editeur?: { schema: Schema }): string {
  if (node.type.name === "codeBlock") return node.textContent;
  const src = editeur ? sources.get(editeur) : undefined;
  if (src !== undefined && editeur) {
    try {
      const t = depuisSource(node, src, editeur.schema);
      if (t !== null) return t;
    } catch { /* repli : écriture de Carnet */ }
  }
  const blocs: PMNode[] = [];
  node.forEach((c) => { blocs.push(c); });
  return blocsVersMd(blocs).replace(/\n+$/, "");
}

/** Copie dans le geste de l'utilisateur ; repli execCommand (adresse Tailscale en http, vieux Safari). */
export function copierPressePapiers(texte: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(texte).catch(() => copierAncien(texte));
      return true;
    }
  } catch { /* repli */ }
  return copierAncien(texte);
}

function copierAncien(texte: string): boolean {
  const t = document.createElement("textarea");
  t.value = texte;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  const actif = document.activeElement as HTMLElement | null;
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  t.remove();
  actif?.focus?.({ preventScroll: true });
  return ok;
}

/**
 * Bouton « Copier » (élément d'interface, jamais du contenu) : `texte()` est lu au moment du clic.
 * `classe` s'ajoute à « carnet-copier » (placement propre à chaque bloc).
 */
export function boutonCopier(classe: string, etiquette: string, texte: () => string, notifier?: (m: string) => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.type = "button";
  b.className = `carnet-copier ${classe}`.trim();
  b.title = etiquette;
  b.setAttribute("aria-label", etiquette);
  b.setAttribute("contenteditable", "false");
  b.setAttribute("data-carnet-ui", "");
  const rendre = (copie: boolean) => {
    b.innerHTML = `${copie ? ic.valider : ic.copier}<span class="carnet-copier__libelle" aria-live="polite"></span>`;
    (b.lastChild as HTMLElement).textContent = copie ? "Copié" : "Copier";
    b.dataset.copie = String(copie);
  };
  rendre(false);
  let minuterie: number | null = null;
  // ne pas voler le focus ni la sélection de l'éditeur
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    const ok = copierPressePapiers(texte());
    if (!ok) { notifier?.("Copie refusée par le navigateur"); return; }
    rendre(true);
    if (minuterie) window.clearTimeout(minuterie);
    minuterie = window.setTimeout(() => { minuterie = null; rendre(false); }, 1500);
  });
  return b;
}

/** Méta des transactions venues du fichier (chargement, mise à jour en direct par `remplacer`) : jamais refusées. */
export const META_DISTANT = "carnet-distant";

/**
 * Page en lecture seule (page verrouillée, `editor.setEditable(false)`) : aucune transaction qui modifie le document
 * n'est appliquée, quelle que soit son origine (bulle de format, pastille de tâche, glisser, coller, vue de nœud…),
 * sauf celles qui viennent du fichier (méta `carnet-distant`, posée par creer.ts au chargement et dans `remplacer`,
 * y compris les transactions ajoutées à leur suite, comme le paragraphe de fin).
 */
export const extensionGardeLectureSeule = Extension.create({
  name: "gardeLectureSeule",
  addProseMirrorPlugins() {
    const editor = this.editor;
    return [new Plugin({
      key: new PluginKey("gardeLectureSeule"),
      filterTransaction: (tr) => {
        if (!tr.docChanged || editor.isEditable) return true;
        const racine = (tr.getMeta("appendedTransaction") as typeof tr | undefined) ?? tr;
        return racine.getMeta(META_DISTANT) === true;
      },
    })];
  },
});
