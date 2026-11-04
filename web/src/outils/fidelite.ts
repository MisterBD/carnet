// Banc de fidélité (jamais servi en production) : aller-retour Markdown -> éditeur -> Markdown,
// avec le VRAI éditeur de Carnet (Tiptap, mêmes extensions, mêmes vues, mêmes réglages de sérialisation).
// Expose aussi les mesures (même rendu, pertes, lignes hors bloc) pour comparer d'autres moteurs (tests/fidelite.py).
import "../styles/jetons.css";
import "../styles/editeur.css";
import { creerEditeur, type EditeurCarnet } from "../editeur/creer";
import { fusionner, decouperBlocs } from "../editeur/fidelite";
import { decouper, dossierDe } from "../../../shared/page.ts";
import type { ContexteEditeur } from "../editeur/contexte";
import { memeTexte, memeRendu, pertes, lignesChangees, horsBloc, blocsCibles, texteDeMd, CAS } from "./mesures";

function contexte(chemin: string): ContexteEditeur {
  return {
    chemin, dossier: dossierDe(chemin), artBase: "http://127.0.0.1:3006",
    urlFichier: (u) => u, ouvrirPage: () => {}, titreDe: () => null,
    televerserImage: async () => "", creerSousPage: async () => null, choisirPage: async () => null,
    choisirArtefact: async () => null, pleinEcranArtefact: () => {}, theme: () => "clair", notifier: () => {},
  };
}

declare global {
  interface Window {
    carnetFidelite: (chemin: string, contenu: string) => Promise<unknown>;
    carnetMesures: unknown;
  }
}

/** Lignes (0-based, fin exclue) du k-ième bloc de premier niveau du corps original. */
function lignesDuBloc(corps: string, ed: EditeurCarnet, k: number): [number, number] | null {
  const blocs = decouperBlocs(corps, ed.analyser);
  if (!blocs || !blocs[k]) return null;
  const debut = corps.slice(0, blocs[k].debut).split("\n").length - 1;
  const fin = corps.slice(0, blocs[k].fin).split("\n").length;
  return [debut, fin];
}

async function nouvelEditeur(chemin: string, corps: string) {
  const racine = document.getElementById("editeur")!;
  racine.replaceChildren();
  const ed = await creerEditeur(racine, corps, contexte(chemin));
  return { ed, n0: ed.getMarkdown() };
}

window.carnetFidelite = async (chemin, contenu) => {
  const d = decouper(contenu);
  const res: Record<string, unknown> = { corps: d.corps, frontmatter: d.frontmatter, blocTitre: d.blocTitre };
  const t0 = performance.now();
  // 1. Aller-retour sans modification + ajout d'un paragraphe à la fin
  {
    const { ed, n0 } = await nouvelEditeur(chemin, d.corps);
    res.msOuvrir = Math.round((performance.now() - t0) * 10) / 10;
    res.n0 = n0;
    const vue = ed.vue();
    // le paragraphe vide final (curseur) peut exister : on écrit dedans, sinon on en ajoute un
    const der = vue.state.doc.lastChild;
    if (der && der.type.name === "paragraph" && der.content.size === 0) {
      vue.dispatch(vue.state.tr.insertText("Ajout de recette.", vue.state.doc.content.size - 1));
    } else {
      const p = vue.state.schema.nodes.paragraph.create(null, vue.state.schema.text("Ajout de recette."));
      vue.dispatch(vue.state.tr.insert(vue.state.doc.content.size, p));
    }
    res.fusion = fusionner(d.corps, n0, ed.getMarkdown(), ed.analyser);
    await ed.detruire();
  }
  // 2. Modification au milieu : un mot ajouté au début du premier paragraphe
  {
    const { ed, n0 } = await nouvelEditeur(chemin, d.corps);
    const vue = ed.vue();
    let k = -1, pos = -1;
    vue.state.doc.forEach((n, off, i) => { if (k === -1 && n.type.name === "paragraph" && n.content.size > 0) { k = i; pos = off + 1; } });
    if (k >= 0) {
      vue.dispatch(vue.state.tr.insertText("Modifié ", pos));
      res.paragraphe = { fusion: fusionner(d.corps, n0, ed.getMarkdown(), ed.analyser), lignes: lignesDuBloc(d.corps, ed, k) };
    }
    await ed.detruire();
  }
  // 3. Une case cochée / décochée
  {
    const { ed, n0 } = await nouvelEditeur(chemin, d.corps);
    const vue = ed.vue();
    let k = -1, pos = -1, attrs: Record<string, unknown> | null = null;
    vue.state.doc.forEach((top, off, i) => {
      if (k !== -1) return;
      top.descendants((n, p) => {
        if (k !== -1) return false;
        if (n.type.name === "listItem" && n.attrs.checked != null) { k = i; pos = off + 1 + p; attrs = n.attrs; return false; }
        return true;
      });
    });
    if (k >= 0 && attrs) {
      const a = attrs as Record<string, unknown>;
      vue.dispatch(vue.state.tr.setNodeMarkup(pos, undefined, { ...a, checked: !a.checked }));
      res.tache = { fusion: fusionner(d.corps, n0, ed.getMarkdown(), ed.analyser), lignes: lignesDuBloc(d.corps, ed, k) };
    }
    await ed.detruire();
  }
  return res;
};

/** Note d'un cas élémentaire : « = » identique, « ≈ » même rendu, « ✗ » perte. */
function noterCas(i: number, sortie: string): string {
  const [, md, verif] = CAS[i];
  const ok = verif ? verif(sortie) : true;
  return memeTexte(sortie, md) ? "=" : ok && memeRendu(sortie, md) ? "≈" : "✗";
}

window.carnetMesures = {
  memeTexte, memeRendu, pertes, lignesChangees, horsBloc, blocsCibles, texteDeMd, noterCas,
  CAS: CAS.map(([n, md]) => [n, md]),
};
document.title = "pret";
