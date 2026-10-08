// Banc de fidélité « rapide » (Node, sans navigateur) de la couche Markdown de l'éditeur Tiptap :
// aller-retour Markdown -> document -> Markdown, et fusion bloc par bloc après trois modifications.
// Usage : node outils/banc.ts <nom>=<dossier> [...] [--cas] [--detail] [--exclure=dossier1,dossier2]
// Le banc de référence reste celui du navigateur (tests/fidelite.py), avec le vrai éditeur et ses greffons.
import { readFileSync, readdirSync, lstatSync } from "node:fs";
import { join, relative } from "node:path";
import { getSchema } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { extensionsSchema } from "../src/editeur/schema.ts";
import { mdVersDoc, docVersMd, analyseurBlocs } from "../src/editeur/markdown/index.ts";
import { fusionner } from "../src/editeur/fidelite.ts";
import { decouper } from "../../shared/page.ts";
import { memeTexte, memeRendu, pertes, lignesChangees, horsBloc, blocsCibles, texteDeMd, CAS } from "../src/outils/mesures.ts";

const args = process.argv.slice(2);
const detail = args.includes("--detail");
const schema = getSchema(extensionsSchema());
const EXCLUS = new Set([".git", ".corbeille", "node_modules"]);
for (const a of args) if (a.startsWith("--exclure=")) for (const d of a.slice(10).split(",")) if (d) EXCLUS.add(d);

function fichiers(racine: string): string[] {
  const res: string[] = [];
  const parcourir = (d: string) => {
    for (const e of readdirSync(d).sort()) {
      if (e.startsWith(".") || EXCLUS.has(e)) continue;
      const p = join(d, e);
      const st = lstatSync(p, { throwIfNoEntry: false });
      if (!st) continue;
      if (st.isDirectory()) parcourir(p);
      else if (e.endsWith(".md") && st.isFile()) res.push(p);
    }
  };
  parcourir(racine);
  return res;
}

const allerRetour = (corps: string) => docVersMd(mdVersDoc(corps, schema));

function apresModif(corps: string, quoi: "fin" | "paragraphe" | "tache"): string | null {
  const doc = mdVersDoc(corps, schema);
  let tr = null;
  if (quoi === "fin") {
    const p = schema.nodes.paragraph.create(null, schema.text("Ajout de recette."));
    return docVersMd(doc.copy(doc.content.addToEnd(p)));
  }
  if (quoi === "paragraphe") {
    let pos = -1;
    doc.forEach((n, off) => { if (pos === -1 && n.type.name === "paragraph" && n.content.size > 0) pos = off + 1; });
    if (pos === -1) return null;
    const t = doc.type.schema.text("Modifié ");
    const nd = doc.replace(pos, pos, new (doc.slice(0, 0).constructor as never)(doc.type.schema.nodes.paragraph.create(null, t).content, 0, 0));
    void tr;
    return docVersMd(nd);
  }
  let trouve: { pos: number; attrs: Record<string, unknown> } | null = null;
  doc.descendants((n, p) => {
    if (trouve) return false;
    if (n.type.name === "listItem" && n.attrs.checked != null) { trouve = { pos: p, attrs: n.attrs }; return false; }
    return true;
  });
  if (!trouve) return null;
  const t = trouve as { pos: number; attrs: Record<string, unknown> };
  const noeud = doc.nodeAt(t.pos)!;
  const nouveau = noeud.type.create({ ...t.attrs, checked: !t.attrs.checked }, noeud.content, noeud.marks);
  const nd = doc.replace(t.pos, t.pos + noeud.nodeSize, new (doc.slice(0, 0).constructor as never)(nouveau.type.schema.nodes.doc.create(null, nouveau).content, 0, 0));
  return docVersMd(nd);
}
void TextSelection;

if (args.includes("--cas")) {
  let n = { "=": 0, "≈": 0, "✗": 0 } as Record<string, number>;
  for (const [nom, md, verif] of CAS) {
    const d = decouper(md);
    let sortie: string;
    try { sortie = d.frontmatter + d.blocTitre + allerRetour(d.corps); } catch (e) { sortie = "ERREUR " + String(e); }
    const ok = verif ? verif(sortie) : true;
    const note = memeTexte(sortie, md) ? "=" : ok && memeRendu(sortie, md) ? "≈" : "✗";
    n[note]++;
    if (note !== "=" || detail) console.log(`${note} ${nom}\n    ${JSON.stringify(md)}\n -> ${JSON.stringify(sortie.replace(/\n+$/, ""))}`);
  }
  console.log(`cas : ${n["="]} = / ${n["≈"]} ≈ / ${n["✗"]} ✗ sur ${CAS.length}`);
}

for (const a of args.filter((x) => x.includes("=") && !x.startsWith("--"))) {
  const [nom, dossier] = a.split("=");
  const tot = { pages: 0, identiques: 0, memeRendu: 0, texteAltere: 0, lignes: 0, fin: [0, 0], par: [0, 0], tache: [0, 0], erreurs: 0 };
  for (const f of fichiers(dossier)) {
    const rel = relative(dossier, f);
    const contenu = readFileSync(f, "utf8");
    const corps = decouper(contenu).corps;
    tot.pages++;
    try {
      const n0 = allerRetour(corps);
      const id = memeTexte(n0, corps);
      const mr = memeRendu(n0, corps);
      const p = pertes(corps, n0);
      tot.identiques += id ? 1 : 0;
      tot.memeRendu += mr ? 1 : 0;
      tot.texteAltere += p.texte !== "intact" ? 1 : 0;
      tot.lignes += lignesChangees(corps.replace(/\n+$/, ""), n0.replace(/\n+$/, ""));
      const L = corps.replace(/\n+$/, "") === "" ? 0 : corps.replace(/\n+$/, "").split("\n").length;
      const n1 = apresModif(corps, "fin")!;
      const fFin = fusionner(corps, n0, n1, analyseurBlocs as never);
      const hFin = horsBloc(corps, fFin, L, L);
      tot.fin[1]++; if (!hFin.length) tot.fin[0]++;
      const cibles = blocsCibles(corps);
      const notes: string[] = [];
      if (cibles.paragraphe) {
        const n1p = apresModif(corps, "paragraphe");
        if (n1p) {
          const fP = fusionner(corps, n0, n1p, analyseurBlocs as never);
          const [a2, b2] = cibles.paragraphe;
          const cible = texteDeMd(corps.split("\n").slice(a2, b2).join("\n")).trim().slice(0, 12);
          if (texteDeMd(fP).includes(`Modifié ${cible}`)) {
            const h = horsBloc(corps, fP, a2, b2);
            tot.par[1]++; if (!h.length) tot.par[0]++; else notes.push("paragraphe: " + h.slice(0, 3).join(" | "));
          }
        }
      }
      if (cibles.tache) {
        const n1t = apresModif(corps, "tache");
        if (n1t) {
          const fT = fusionner(corps, n0, n1t, analyseurBlocs as never);
          const [a2, b2] = cibles.tache;
          const h = horsBloc(corps, fT, a2, b2);
          tot.tache[1]++; if (!h.length) tot.tache[0]++; else notes.push("tâche: " + h.slice(0, 3).join(" | "));
        }
      }
      if (hFin.length) notes.push("fin: " + hFin.slice(0, 3).join(" | "));
      if (!id || !mr || notes.length || p.texte !== "intact") {
        const pe = Object.entries(p).filter(([, v]) => v !== "intact").map(([k, v]) => `${k}=${v}`).join(", ");
        console.log(`${id ? "=" : mr ? "≈" : "✗"} ${nom}/${rel}${pe ? "  [" + pe + "]" : ""}`);
        if (detail || !mr) for (const l of horsBloc(corps, n0, -1, -1).slice(0, 8)) console.log("      " + l);
        for (const x of notes) console.log("      ! " + x);
      }
    } catch (e) {
      tot.erreurs++;
      console.log(`ERREUR ${nom}/${rel} : ${(e as Error).stack?.slice(0, 400)}`);
    }
  }
  console.log(`${nom} : ${tot.pages} pages ; identiques ${tot.identiques} ; même rendu ${tot.memeRendu} ; texte altéré ${tot.texteAltere} ; lignes réécrites ${tot.lignes} ; ` +
    `fusion fin ${tot.fin[0]}/${tot.fin[1]}, paragraphe ${tot.par[0]}/${tot.par[1]}, tâche ${tot.tache[0]}/${tot.tache[1]} ; erreurs ${tot.erreurs}`);
}
