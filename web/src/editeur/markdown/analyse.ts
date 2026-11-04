// Analyse du Markdown de Carnet : CommonMark + GFM (micromark / mdast), puis une GRAMMAIRE FERMÉE pour nos blocs.
//
// Aucun HTML libre n'est interprété. Seules ces formes exactes sont reconnues (attributs en liste blanche,
// valeurs énumérées) ; tout le reste reste du texte brut, affiché tel quel et réécrit à l'identique :
//   - encadrés           > [!NOTE] titre  (NOTE, TIP, IMPORTANT, WARNING, CAUTION, pli +/-)
//   - repliables         <details>[open] + <summary>…</summary> + contenu + </details>
//   - sommaire           <!-- sommaire -->
//   - couleurs           <span color="red">…</span>, <span color="red_bg">…</span> (9 noms)
//   - souligné           <u>…</u>        - surlignage  ==…==  (ou <mark>…</mark>)
//   - liens de page      [[Page]], [[Page|alias]], [[Page#titre]]
//   - artefacts          paragraphe = un seul lien vers artefacts/…/*.html (avec ou sans image d'aperçu)
//   - images en bloc     paragraphe = une seule image (légende = texte alternatif)
import { fromMarkdown } from "mdast-util-from-markdown";
import { gfm } from "micromark-extension-gfm";
import { gfmFromMarkdown } from "mdast-util-gfm";
import { decalerPositions, oublierPositions, parcourirParents, texteDe, type MNode } from "./mdast.ts";

export const COULEURS = ["gray", "brown", "orange", "yellow", "green", "blue", "purple", "pink", "red"] as const;
export type Couleur = (typeof COULEURS)[number];
export const GENRES_ENCADRE = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;

const RE_ARTEFACT = /(^|\/)artefacts\/[^?#]+\.html?$/i;
const RE_TETE_ENCADRE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]([+-]?)(?:[ \t]+(.*))?$/i;
const RE_DETAILS_COMPACT = /^<details( open)?>[ \t]*\n[ \t]*<summary>([^<\n]*)<\/summary>[ \t]*\n([\s\S]*?)\n[ \t]*<\/details>[ \t]*$/;
const RE_DETAILS_OUVERTURE = /^<details( open)?>[ \t]*(?:\n[ \t]*<summary>([^<\n]*)<\/summary>[ \t]*)?$/;
const RE_SUMMARY = /^<summary>([^<\n]*)<\/summary>[ \t]*$/;
const RE_FERMETURE_DETAILS = /^<\/details>[ \t]*$/;
const RE_SOMMAIRE = /^<!--[ \t]*sommaire[ \t]*-->$/i;
const RE_SPAN = new RegExp(`^<span color="(${COULEURS.join("|")})(_bg)?">$`);
const RE_WIKI = /\[\[([^[\]\n]+?)\]\]/g;

const ENTITES: Record<string, string> = { "&lt;": "<", "&gt;": ">", "&amp;": "&", "&quot;": '"', "&#39;": "'" };
export function decoderEntites(s: string): string {
  return s.replace(/&(lt|gt|amp|quot|#39);/g, (m) => ENTITES[m] ?? m);
}

/** CommonMark + GFM, sans notre grammaire. */
export function analyserBrut(md: string): MNode {
  return fromMarkdown(md, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] }) as unknown as MNode;
}

/** Arbre complet de Carnet : CommonMark + GFM + grammaire fermée. Les positions renvoient à `md`. */
export function analyser(md: string): MNode {
  const arbre = analyserBrut(md);
  transformerBlocs(arbre, md);
  transformerEnLigne(arbre);
  return arbre;
}

// ------------------------------------------------------------------------------------------------
// Blocs
// ------------------------------------------------------------------------------------------------

function transformerBlocs(arbre: MNode, src: string): void {
  // Les repliables d'abord (ils regroupent plusieurs nœuds frères), du plus extérieur au plus intérieur.
  grouperDetails(arbre, src);
  parcourirParents(arbre, (parent) => {
    const enfants = parent.children!;
    for (let i = 0; i < enfants.length; i++) {
      const n = enfants[i];
      if (n.type === "blockquote") {
        const e = versEncadre(n, src);
        if (e) enfants[i] = e;
      } else if (n.type === "paragraph" && n.children?.length === 1) {
        const c = n.children[0];
        if (c.type === "link" && c.url && RE_ARTEFACT.test(c.url.split("#")[0])) {
          const img = c.children?.length === 1 && c.children[0].type === "image" ? c.children[0] : null;
          enfants[i] = {
            type: "artefactCarnet", url: c.url, titre: img ? (img.alt ?? "") : texteDe(c),
            image: img ? img.url : null, alt: img ? (img.alt ?? "") : null, position: n.position,
          };
        } else if (c.type === "image") {
          enfants[i] = { type: "imageBloc", url: c.url ?? "", alt: c.alt ?? "", title: c.title ?? null, position: n.position };
        }
      } else if (n.type === "listItem" && n.checked == null && n.children?.length === 1) {
        // tâche vide « - [ ] » : GFM n'y voit pas de case (il faut du texte après) ; Carnet, si
        const p = n.children[0];
        const t = p.type === "paragraph" && p.children?.length === 1 ? p.children[0] : null;
        const m = t?.type === "text" ? /^\[([ xX])\]$/.exec(t.value ?? "") : null;
        if (m) { n.checked = m[1] !== " "; p.children = []; }
      } else if (n.type === "html" && RE_SOMMAIRE.test((n.value ?? "").trim())) {
        enfants[i] = { type: "sommaire", position: n.position };
      }
    }
  });
}

function grouperDetails(parent: MNode, src: string): void {
  const enfants = parent.children;
  if (!enfants) return;
  for (let i = 0; i < enfants.length; i++) {
    const n = enfants[i];
    if (n.type === "html") {
      const v = n.value ?? "";
      const c = RE_DETAILS_COMPACT.exec(v);
      if (c) {
        // Forme compacte (sans ligne vide) : un seul bloc HTML. Le contenu est analysé comme du Markdown.
        const contenu = c[3];
        const sous = analyserBrut(contenu);
        const debut = n.position?.start.offset;
        const k = debut == null ? -1 : src.indexOf(contenu, debut);
        if (k >= 0 && k + contenu.length <= (n.position?.end.offset ?? -1)) decalerPositions(sous, k);
        else oublierPositions(sous);
        transformerBlocs(sous, src);
        enfants[i] = {
          type: "details", ouvert: Boolean(c[1]), forme: "compact", resume: decoderEntites(c[2]),
          children: sous.children ?? [], position: n.position,
        };
        continue;
      }
      const o = RE_DETAILS_OUVERTURE.exec(v);
      if (o) {
        let resume = o[2];
        let j = i + 1;
        let resumeSepare = false;
        if (resume === undefined && enfants[j]?.type === "html") {
          const s = RE_SUMMARY.exec((enfants[j].value ?? "").trim());
          if (s) { resume = s[1]; j++; resumeSepare = true; }
        }
        // fermeture au même niveau, en tenant compte des repliables imbriqués
        let prof = 0;
        let k = -1;
        for (let x = j; x < enfants.length; x++) {
          const h = enfants[x];
          if (h.type !== "html") continue;
          const hv = (h.value ?? "").trim();
          if (RE_DETAILS_OUVERTURE.test(hv)) prof++;
          else if (RE_FERMETURE_DETAILS.test(hv)) {
            if (prof === 0) { k = x; break; }
            prof--;
          }
        }
        if (k === -1) continue; // mal apparié : on ne convertit rien (reste du HTML brut, intact)
        const contenu = enfants.slice(j, k);
        const det: MNode = {
          type: "details", ouvert: Boolean(o[1]), forme: resumeSepare ? "separe" : "aere", resume: decoderEntites(resume ?? ""),
          sansResume: resume === undefined,
          children: contenu,
          position: { start: { ...n.position!.start }, end: { ...enfants[k].position!.end } },
        };
        enfants.splice(i, k - i + 1, det);
        grouperDetails(det, src);
        continue;
      }
    }
    if (n.children && n.type !== "details") grouperDetails(n, src);
  }
}

/** Citation dont la première ligne est « [!TYPE] titre » : un encadré. Le titre est gardé tel qu'écrit (source). */
function versEncadre(bq: MNode, src: string): MNode | null {
  const p = bq.children?.[0];
  if (!p || p.type !== "paragraph" || !p.children?.length) return null;
  const t = p.children[0];
  if (t.type !== "text" || !t.value) return null;
  const nl = t.value.indexOf("\n");
  const premiere = nl === -1 ? t.value : t.value.slice(0, nl);
  const m = RE_TETE_ENCADRE.exec(premiere.trimEnd());
  // le titre peut contenir de la mise en forme : on lit alors la ligne dans la source
  let titre = (m?.[3] ?? "").trim();
  let reste: MNode[];
  if (m && nl !== -1) {
    const suite = t.value.slice(nl + 1);
    reste = suite ? [{ ...t, value: suite, position: undefined }, ...p.children.slice(1)] : p.children.slice(1);
  } else if (m && p.children.length === 1) {
    reste = [];
  } else if (m && p.children[1].type === "break") {
    reste = p.children.slice(2);
  } else {
    // première ligne qui déborde sur d'autres nœuds en ligne (« [!TIP] **Bon** à savoir »)
    const d = t.position?.start.offset;
    if (d == null) return null;
    const finLigne = src.indexOf("\n", d);
    const ligne = src.slice(d, finLigne === -1 ? undefined : finLigne);
    const m2 = RE_TETE_ENCADRE.exec(ligne.trimEnd());
    if (!m2) return null;
    // les nœuds de la première ligne s'arrêtent au premier retour à la ligne (texte ou saut forcé)
    let k = 1;
    let coupe: MNode[] | null = null;
    for (; k < p.children.length; k++) {
      const c = p.children[k];
      if (c.type === "break") { coupe = p.children.slice(k + 1); break; }
      if (c.type === "text" && c.value?.includes("\n")) {
        const v = c.value.slice(c.value.indexOf("\n") + 1);
        coupe = v ? [{ ...c, value: v, position: undefined }, ...p.children.slice(k + 1)] : p.children.slice(k + 1);
        break;
      }
      if (texteDe(c).includes("\n")) return null; // une marque à cheval sur deux lignes : on laisse la citation
    }
    reste = coupe ?? [];
    titre = (m2[3] ?? "").trim();
    return {
      type: "encadre", genre: m2[1].toUpperCase(), pli: m2[2] ?? "", titre,
      children: [...(reste.length ? [{ ...p, children: reste }] : []), ...bq.children!.slice(1)],
      position: bq.position,
    };
  }
  if (!m) return null;
  return {
    type: "encadre", genre: m[1].toUpperCase(), pli: m[2] ?? "", titre,
    children: [...(reste.length ? [{ ...p, children: reste }] : []), ...bq.children!.slice(1)],
    position: bq.position,
  };
}

// ------------------------------------------------------------------------------------------------
// En ligne
// ------------------------------------------------------------------------------------------------

const SANS_TRANSFO = new Set(["inlineCode", "code", "html", "image", "imageReference", "wikiLink", "sommaire", "artefactCarnet", "imageBloc", "definition"]);

function transformerEnLigne(arbre: MNode): void {
  const visiter = (n: MNode) => {
    if (!n.children || SANS_TRANSFO.has(n.type)) return;
    if (n.children.some((c) => c.type === "html")) n.children = balisesFermees(n.children);
    if (n.children.some((c) => c.type === "text" && c.value?.includes("=="))) n.children = surlignages(n.children);
    if (n.type !== "link" && n.type !== "linkReference" && n.children.some((c) => c.type === "text" && c.value?.includes("[["))) {
      n.children = wikiliens(n.children);
    }
    for (const c of n.children) visiter(c);
  };
  visiter(arbre);
}

type Balise = { nom: "span" | "u" | "mark"; couleur?: string; fond?: boolean };

function ouverture(n: MNode): Balise | null {
  if (n.type !== "html") return null;
  const v = n.value ?? "";
  const s = RE_SPAN.exec(v);
  if (s) return { nom: "span", couleur: s[1], fond: Boolean(s[2]) };
  if (v === "<u>") return { nom: "u" };
  if (v === "<mark>") return { nom: "mark" };
  return null;
}

/** <span color>, <u>, <mark> appariés au même niveau. Une balise sans sa paire reste du HTML brut. */
function balisesFermees(enfants: MNode[]): MNode[] {
  const res: MNode[] = [];
  let i = 0;
  while (i < enfants.length) {
    const b = ouverture(enfants[i]);
    if (!b) { res.push(enfants[i]); i++; continue; }
    let prof = 0;
    let k = -1;
    for (let x = i + 1; x < enfants.length; x++) {
      const c = enfants[x];
      if (c.type !== "html") continue;
      const o = ouverture(c);
      if (o && o.nom === b.nom) prof++;
      else if (c.value === `</${b.nom}>`) {
        if (prof === 0) { k = x; break; }
        prof--;
      }
    }
    if (k === -1) { res.push(enfants[i]); i++; continue; }
    const dedans = balisesFermees(enfants.slice(i + 1, k));
    const debut = enfants[i].position?.start;
    const fin = enfants[k].position?.end;
    const position = debut && fin ? { start: { ...debut }, end: { ...fin } } : undefined;
    if (b.nom === "span") res.push({ type: "couleur", couleur: b.couleur, fond: b.fond, children: dedans, position });
    else if (b.nom === "u") res.push({ type: "souligne", children: dedans, position });
    else res.push({ type: "surligne", forme: "mark", children: dedans, position });
    i = k + 1;
  }
  return res;
}

/** ==surlignage== (Obsidian) : ouvrant suivi d'un caractère visible, fermant précédé d'un caractère visible. */
function surlignages(enfants: MNode[]): MNode[] {
  // jetons : (index d'enfant, position dans son texte)
  type Pos = { e: number; k: number };
  const ouvrants: Pos[] = [];
  const paires: Array<[Pos, Pos]> = [];
  for (let e = 0; e < enfants.length; e++) {
    const c = enfants[e];
    if (c.type !== "text" || !c.value) continue;
    const v = c.value;
    let k = v.indexOf("==");
    while (k !== -1) {
      if (v[k + 2] === "=" || (k > 0 && v[k - 1] === "=")) { k = v.indexOf("==", k + 3); continue; }
      const avant = k > 0 ? v[k - 1] : (e > 0 ? "x" : " ");
      const apres = k + 2 < v.length ? v[k + 2] : (e + 1 < enfants.length ? "x" : " ");
      const peutFermer = ouvrants.length > 0 && !/\s/.test(avant);
      const peutOuvrir = !/\s/.test(apres);
      if (peutFermer) {
        const o = ouvrants.pop()!;
        paires.push([o, { e, k }]);
        ouvrants.length = 0; // pas d'imbrication
      } else if (peutOuvrir) {
        ouvrants.push({ e, k });
      }
      k = v.indexOf("==", k + 2);
    }
  }
  if (!paires.length) return enfants;
  // découpe de droite à gauche pour garder les index valides
  let res = enfants.slice();
  for (const [o, f] of paires.reverse()) {
    const avant = res.slice(0, o.e);
    const apres = res.slice(f.e + 1);
    const to = res[o.e];
    const tf = res[f.e];
    const milieu: MNode[] = [];
    const gaucheO = to.value!.slice(0, o.k);
    if (o.e === f.e) {
      const dedans = to.value!.slice(o.k + 2, f.k);
      const droiteF = to.value!.slice(f.k + 2);
      res = [...avant, ...(gaucheO ? [{ type: "text", value: gaucheO }] : []),
        { type: "surligne", forme: "egal", children: [{ type: "text", value: dedans }] },
        ...(droiteF ? [{ type: "text", value: droiteF }] : []), ...apres];
      continue;
    }
    const debutDedans = to.value!.slice(o.k + 2);
    if (debutDedans) milieu.push({ type: "text", value: debutDedans });
    milieu.push(...res.slice(o.e + 1, f.e));
    const finDedans = tf.value!.slice(0, f.k);
    if (finDedans) milieu.push({ type: "text", value: finDedans });
    const droiteF = tf.value!.slice(f.k + 2);
    res = [...avant, ...(gaucheO ? [{ type: "text", value: gaucheO }] : []),
      { type: "surligne", forme: "egal", children: milieu },
      ...(droiteF ? [{ type: "text", value: droiteF }] : []), ...apres];
  }
  return res;
}

function wikiliens(enfants: MNode[]): MNode[] {
  const res: MNode[] = [];
  for (const c of enfants) {
    if (c.type !== "text" || !c.value?.includes("[[")) { res.push(c); continue; }
    const v = c.value;
    let dernier = 0;
    RE_WIKI.lastIndex = 0;
    let m: RegExpExecArray | null;
    let trouve = false;
    while ((m = RE_WIKI.exec(v))) {
      trouve = true;
      if (m.index > dernier) res.push({ type: "text", value: v.slice(dernier, m.index) });
      res.push({ type: "wikiLink", value: m[1] });
      dernier = m.index + m[0].length;
    }
    if (!trouve) { res.push(c); continue; }
    if (dernier < v.length) res.push({ type: "text", value: v.slice(dernier) });
  }
  return res;
}

/** Blocs de premier niveau d'une page, avec leur position (pour la fusion bloc par bloc). */
export function blocsDePremierNiveau(md: string): MNode[] {
  return analyser(md).children ?? [];
}
