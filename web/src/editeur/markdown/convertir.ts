// Conversion entre l'arbre Markdown de Carnet (mdast + grammaire fermée) et le document ProseMirror de Tiptap.
// Tout ce qui n'a pas de bloc dédié reste du texte brut, réécrit à l'identique (aucune perte, rien d'interprété).
import type { Mark, Node as PMNode, Schema } from "@tiptap/pm/model";
import { tranche, texteDe, type MNode } from "./mdast.ts";

// ------------------------------------------------------------------------------------------------
// Markdown -> document
// ------------------------------------------------------------------------------------------------

export function versDoc(arbre: MNode, src: string, schema: Schema): PMNode {
  const c = new Convertisseur(src, schema);
  const blocs = c.blocs(arbre.children ?? [], true);
  return schema.nodes.doc.create(null, blocs.length ? blocs : [schema.nodes.paragraph.create()]);
}

/** Fragment (collage de Markdown). */
export function versBlocs(arbre: MNode, src: string, schema: Schema): PMNode[] {
  return new Convertisseur(src, schema).blocs(arbre.children ?? [], true);
}

class Convertisseur {
  private src: string;
  private s: Schema;
  constructor(src: string, s: Schema) { this.src = src; this.s = s; }

  /** Nombre de lignes vides entre deux blocs voisins dans la source (null si inconnu). */
  ecart(prec: MNode | undefined, n: MNode): number | null {
    const f = prec?.position?.end.offset;
    const d = n.position?.start.offset;
    if (f == null || d == null || d < f) return null;
    const entre = this.src.slice(f, d);
    if (!entre.includes("\n")) return null;
    // lignes vides (éventuellement préfixées par « > » dans une citation)
    return entre.split("\n").slice(1, -1).filter((l) => /^[ \t>]*$/.test(l)).length;
  }

  blocs(enfants: MNode[], racine = false): PMNode[] {
    const res: PMNode[] = [];
    let prec: MNode | undefined;
    for (const n of enfants) {
      const b = this.bloc(n);
      if (b) {
        const e = racine && prec ? this.ecart(prec, n) : null;
        // Lignes vides en plus entre deux blocs (laissées par la personne ou un agent) : autant de lignes vides à l'écran,
        // réécrites à l'identique (voir blocsMd)
        if (e != null && e >= 2) for (let k = 1; k < Math.min(e, 5); k++) res.push(this.s.nodes.paragraph.create({ ecart: 1 }));
        const ecart = e != null && e >= 2 ? 1 : e;
        if (ecart != null && b.type.spec.attrs && "ecart" in b.type.spec.attrs) res.push(b.type.create({ ...b.attrs, ecart }, b.content, b.marks));
        else res.push(b);
      }
      prec = n;
    }
    return res;
  }

  private brut(n: MNode): PMNode | null {
    const t = tranche(this.src, n) ?? (typeof n.value === "string" ? n.value : texteDe(n));
    if (!t) return null;
    return this.s.nodes.blocBrut.create({ origine: n.type }, this.s.text(t));
  }

  bloc(n: MNode): PMNode | null {
    const { nodes } = this.s;
    switch (n.type) {
      case "paragraph":
        return nodes.paragraph.create(null, this.enLigne(n.children ?? [], []));
      case "heading": {
        const t = tranche(this.src, n);
        const setext = t != null && !/^[ \t]*#/.test(t);
        return nodes.heading.create({ level: Math.min(6, Math.max(1, Number(n.depth) || 1)), setext }, this.enLigne(n.children ?? [], []));
      }
      case "thematicBreak":
        return nodes.horizontalRule.create({ brut: (tranche(this.src, n) ?? "---").trim() });
      case "blockquote": {
        const c = this.blocs(n.children ?? []);
        return nodes.blockquote.create(null, c.length ? c : [nodes.paragraph.create()]);
      }
      case "encadre": {
        const c = this.blocs(n.children ?? []);
        return nodes.encadre.create({ genre: n.genre, titre: n.titre ?? "", pli: n.pli ?? "" }, c.length ? c : [nodes.paragraph.create()]);
      }
      case "list":
        return this.liste(n);
      case "code": {
        const t = tranche(this.src, n) ?? "";
        const m = /^[ \t]*(`{3,}|~{3,})/.exec(t);
        const attrs = {
          language: (n.lang as string | null) ?? null,
          meta: (n.meta as string | null) ?? null,
          cloture: m ? m[1] : "```",
          indente: !m && t.length > 0,
        };
        return nodes.codeBlock.create(attrs, n.value ? this.s.text(n.value) : null);
      }
      case "table":
        return this.tableau(n);
      case "html": {
        if (!n.value) return null;
        return nodes.blocBrut.create({ origine: "html" }, this.s.text(n.value));
      }
      case "details": {
        const contenu = this.blocs(n.children ?? []);
        const resume = String(n.resume ?? "");
        return nodes.details.create({ ouvert: Boolean(n.ouvert), forme: n.forme ?? "aere", sansResume: Boolean(n.sansResume) }, [
          nodes.detailsSummary.create(null, resume ? this.s.text(resume) : null),
          nodes.detailsContent.create(null, contenu.length ? contenu : [nodes.paragraph.create()]),
        ]);
      }
      case "artefactCarnet":
        return nodes.artefact.create({ url: n.url, titre: n.titre ?? "", image: n.image ?? null, alt: n.alt ?? null });
      case "imageBloc":
        return nodes.imageBloc.create({ src: n.url ?? "", alt: n.alt ?? "", titre: n.title ?? null });
      case "sommaire":
        return nodes.sommaire.create();
      default:
        // définitions de liens, notes de bas de page, maths, etc. : texte brut, réécrit tel quel
        return this.brut(n);
    }
  }

  private liste(n: MNode): PMNode {
    const { nodes } = this.s;
    const items = (n.children ?? []).map((it, i, tous) => {
      const contenu = this.blocs(it.children ?? []);
      let sansParagraphe = false;
      if (!contenu.length || contenu[0].type !== nodes.paragraph) {
        contenu.unshift(nodes.paragraph.create());
        sansParagraphe = (it.children ?? []).length > 0;
      }
      const checked = typeof it.checked === "boolean" ? it.checked : null;
      const ecart = i > 0 ? this.ecart(tous[i - 1], it) : null;
      return nodes.listItem.create({ checked, aere: Boolean(it.spread), sansParagraphe, ecart }, contenu);
    });
    const premier = n.children?.[0];
    const t = premier ? tranche(this.src, premier) ?? "" : "";
    if (n.ordered) {
      const m = /^[ \t]*\d+([.)])/.exec(t);
      return nodes.orderedList.create({ start: n.start ?? 1, marqueur: m ? m[1] : ".", aere: Boolean(n.spread) }, items);
    }
    const m = /^[ \t]*([-*+])/.exec(t);
    return nodes.bulletList.create({ marqueur: m ? m[1] : "-", aere: Boolean(n.spread) }, items);
  }

  private tableau(n: MNode): PMNode {
    const { nodes } = this.s;
    const align = (n.align as Array<string | null> | undefined) ?? [];
    const lignes = (n.children ?? []).map((ligne, i) => {
      const cellules = (ligne.children ?? []).map((c, j) => {
        const type = i === 0 ? nodes.tableHeader : nodes.tableCell;
        return type.create({ align: align[j] ?? null }, nodes.paragraph.create(null, this.enLigne(c.children ?? [], [])));
      });
      return nodes.tableRow.create(null, cellules);
    });
    // ligne de séparation d'origine (gardée telle quelle tant que les colonnes ne changent pas)
    const t = tranche(this.src, n) ?? "";
    const sep = t.split("\n")[1]?.trim() ?? null;
    return nodes.table.create({ separateur: sep, colonnes: align.length }, lignes);
  }

  enLigne(enfants: MNode[], marques: readonly Mark[]): PMNode[] {
    const { nodes, marks } = this.s;
    const res: PMNode[] = [];
    const avec = (m: Mark) => m.addToSet(marques);
    for (const n of enfants) {
      switch (n.type) {
        case "text": {
          const morceaux = (n.value ?? "").split("\n");
          morceaux.forEach((t, i) => {
            if (i > 0) res.push(nodes.hardBreak.create({ forme: "doux" }, null, marques));
            if (t) res.push(this.s.text(t, marques));
          });
          break;
        }
        case "strong": {
          const c = this.src[n.position?.start.offset ?? -1];
          res.push(...this.enLigne(n.children ?? [], avec(marks.bold.create({ marqueur: c === "_" ? "_" : "*" }))));
          break;
        }
        case "emphasis": {
          const c = this.src[n.position?.start.offset ?? -1];
          res.push(...this.enLigne(n.children ?? [], avec(marks.italic.create({ marqueur: c === "*" ? "*" : "_" }))));
          break;
        }
        case "delete": {
          const d = n.position?.start.offset ?? -1;
          const double = this.src.slice(d, d + 2) === "~~" || d < 0;
          res.push(...this.enLigne(n.children ?? [], avec(marks.strike.create({ marqueur: double ? "~~" : "~" }))));
          break;
        }
        case "inlineCode":
          if (n.value) res.push(this.s.text(n.value, avec(marks.code.create())));
          else this.brutEnLigne(n, marques, res);
          break;
        case "link": {
          if (!n.children?.length) { this.brutEnLigne(n, marques, res); break; }
          const t = tranche(this.src, n) ?? "";
          const forme = t.startsWith("<") ? "chevrons" : t === n.url || (!t.startsWith("[") && t.length > 0) ? "nu" : "normal";
          res.push(...this.enLigne(n.children, avec(marks.link.create({ href: n.url ?? "", title: n.title ?? null, forme }))));
          break;
        }
        case "image":
          res.push(nodes.imageEnLigne.create({ src: n.url ?? "", alt: n.alt ?? "", titre: n.title ?? null }, null, marques));
          break;
        case "break": {
          const t = tranche(this.src, n) ?? "";
          res.push(nodes.hardBreak.create({ forme: t.startsWith("\\") ? "antislash" : "espaces" }, null, marques));
          break;
        }
        case "wikiLink":
          res.push(nodes.wikilien.create({ valeur: n.value ?? "" }, null, marques));
          break;
        case "couleur": {
          const type = n.fond ? marks.couleurFond : marks.couleurTexte;
          res.push(...this.enLigne(n.children ?? [], avec(type.create({ c: n.couleur }))));
          break;
        }
        case "souligne":
          res.push(...this.enLigne(n.children ?? [], avec(marks.underline.create())));
          break;
        case "surligne":
          res.push(...this.enLigne(n.children ?? [], avec(marks.highlight.create({ forme: n.forme === "mark" ? "mark" : "egal" }))));
          break;
        case "html":
          if (n.value) res.push(this.s.text(n.value, avec(marks.brut.create())));
          break;
        default:
          // références de lien, notes, etc. : texte brut tel qu'écrit
          this.brutEnLigne(n, marques, res);
      }
    }
    return res;
  }

  private brutEnLigne(n: MNode, marques: readonly Mark[], res: PMNode[]): void {
    const t = tranche(this.src, n) ?? texteDe(n);
    if (t) res.push(this.s.text(t, this.s.marks.brut.create().addToSet(marques)));
  }
}

// ------------------------------------------------------------------------------------------------
// Document -> Markdown (arbre)
// ------------------------------------------------------------------------------------------------

/** Rang des marques, de la plus extérieure à la plus intérieure (code et brut sont des feuilles). */
const RANG: Record<string, number> = {
  link: 0, couleurFond: 1, couleurTexte: 2, underline: 3, highlight: 4, bold: 5, italic: 6, strike: 7,
};
const FEUILLES = new Set(["code", "brut"]);

export function versMdast(doc: PMNode): MNode {
  return { type: "root", children: blocsMd(doc, true) };
}

function blocsMd(parent: PMNode, racine = false): MNode[] {
  const res: MNode[] = [];
  let vides = 0;
  parent.forEach((n) => {
    // paragraphes vides au premier niveau : des lignes vides en plus avant le bloc suivant (rien en fin de page)
    if (racine && n.type.name === "paragraph" && n.content.size === 0) { if (res.length) vides++; return; }
    const m = blocMd(n);
    if (!m) return;
    if (racine && vides) m.data = { ...(m.data ?? {}), ecart: 1 + vides };
    else if (racine && n.attrs.ecart != null) m.data = { ...(m.data ?? {}), ecart: n.attrs.ecart };
    vides = 0;
    res.push(m);
  });
  return res;
}

export function blocMd(n: PMNode): MNode | null {
  switch (n.type.name) {
    case "paragraph":
      return { type: "paragraph", children: enLigneMd(n) };
    case "heading":
      return { type: "heading", depth: n.attrs.level, children: enLigneMd(n), data: { setext: n.attrs.setext } };
    case "horizontalRule":
      return { type: "thematicBreak", data: { brut: n.attrs.brut } };
    case "blockquote":
      return { type: "blockquote", children: blocsMd(n) };
    case "encadre":
      return { type: "encadre", genre: n.attrs.genre, titre: n.attrs.titre, pli: n.attrs.pli, children: blocsMd(n).filter((b) => !(b.type === "paragraph" && !b.children?.length) || n.childCount > 1) };
    case "bulletList":
    case "orderedList": {
      const ordered = n.type.name === "orderedList";
      const items: MNode[] = [];
      n.forEach((it) => {
        let enfants = blocsMd(it);
        if (it.attrs.sansParagraphe && enfants[0]?.type === "paragraph" && !enfants[0].children?.length) enfants = enfants.slice(1);
        items.push({ type: "listItem", spread: Boolean(it.attrs.aere), checked: it.attrs.checked ?? null, children: enfants, data: { ecart: it.attrs.ecart } });
      });
      return {
        type: "list", ordered, start: ordered ? n.attrs.start ?? 1 : null, spread: Boolean(n.attrs.aere),
        children: items, data: { marqueur: n.attrs.marqueur },
      };
    }
    case "codeBlock":
      return {
        type: "code", lang: n.attrs.language || null, meta: n.attrs.meta || null, value: n.textContent,
        data: { cloture: n.attrs.cloture, indente: n.attrs.indente },
      };
    case "table": {
      const lignes: MNode[] = [];
      let align: Array<string | null> = [];
      n.forEach((ligne, _o, i) => {
        const cellules: MNode[] = [];
        ligne.forEach((c) => {
          if (i === 0) align.push(c.attrs.align ?? null);
          const p = c.firstChild;
          cellules.push({ type: "tableCell", children: p ? enLigneMd(p) : [] });
        });
        lignes.push({ type: "tableRow", children: cellules });
      });
      if (!align.length) align = [];
      return { type: "table", align, children: lignes, data: { separateur: n.attrs.separateur, colonnes: n.attrs.colonnes } };
    }
    case "details": {
      const resume = n.firstChild?.textContent ?? "";
      const contenu = n.child(1);
      return {
        type: "details", ouvert: n.attrs.ouvert, forme: n.attrs.forme, resume, sansResume: n.attrs.sansResume && !resume,
        children: contenu ? blocsMd(contenu) : [],
      };
    }
    case "artefact":
      return { type: "artefactCarnet", url: n.attrs.url, titre: n.attrs.titre, image: n.attrs.image, alt: n.attrs.alt };
    case "imageBloc":
      return { type: "paragraph", children: [{ type: "image", url: n.attrs.src, alt: n.attrs.alt ?? "", title: n.attrs.titre || null }] };
    case "blocBrut":
      return n.textContent ? { type: "html", value: n.textContent } : null;
    case "sommaire":
      return { type: "html", value: "<!-- sommaire -->" };
    default:
      return null;
  }
}

function nouveauConteneur(m: Mark): MNode {
  switch (m.type.name) {
    case "link": return { type: "link", url: m.attrs.href ?? "", title: m.attrs.title || null, children: [], data: { forme: m.attrs.forme } };
    case "couleurFond": return { type: "couleur", couleur: m.attrs.c, fond: true, children: [] };
    case "couleurTexte": return { type: "couleur", couleur: m.attrs.c, fond: false, children: [] };
    case "underline": return { type: "souligne", children: [] };
    case "highlight": return { type: "surligne", forme: m.attrs.forme, children: [] };
    case "bold": return { type: "strong", children: [], data: { marqueur: m.attrs.marqueur } };
    case "italic": return { type: "emphasis", children: [], data: { marqueur: m.attrs.marqueur } };
    case "strike": return { type: "delete", children: [], data: { marqueur: m.attrs.marqueur } };
    default: return { type: "emphasis", children: [] };
  }
}

const ATTENTION = new Set(["strong", "emphasis", "delete", "surligne"]);

/** Contenu en ligne -> nœuds mdast imbriqués (marques ouvertes et fermées au plus juste). */
export function enLigneMd(parent: PMNode): MNode[] {
  const racine: MNode = { type: "root", children: [] };
  const pile: Array<{ m: Mark; n: MNode }> = [];
  const courant = () => (pile.length ? pile[pile.length - 1].n : racine);
  const ajouterTexte = (dans: MNode, v: string) => {
    const enf = dans.children!;
    const d = enf[enf.length - 1];
    if (d && d.type === "text") d.value += v;
    else enf.push({ type: "text", value: v });
  };
  const fermerJusqua = (k: number) => {
    while (pile.length > k) {
      const { n } = pile.pop()!;
      // espaces de fin hors de la marque (« **gras **suite » ne serait pas du gras)
      if (ATTENTION.has(n.type)) {
        const d = n.children![n.children!.length - 1];
        if (d?.type === "text") {
          const m = /\s+$/.exec(d.value ?? "");
          if (m && m[0].length < (d.value ?? "").length) {
            d.value = d.value!.slice(0, -m[0].length);
            ajouterTexte(courant(), m[0]);
          }
        }
      }
    }
  };

  parent.forEach((enfant) => {
    const rang = (m: Mark) => (m.type.name === "link" && m.attrs.forme === "nu" ? 8 : RANG[m.type.name] ?? 9);
    const marques = enfant.marks.filter((m) => !FEUILLES.has(m.type.name)).sort((a, b) => rang(a) - rang(b));
    // préfixe commun avec la pile
    let k = 0;
    while (k < pile.length && k < marques.length && pile[k].m.eq(marques[k])) k++;
    fermerJusqua(k);
    let texte = enfant.isText ? enfant.text ?? "" : null;
    const feuille = enfant.marks.find((m) => FEUILLES.has(m.type.name));
    if (k < marques.length && texte != null && !feuille) {
      // espaces de début hors des marques qu'on ouvre
      const m = /^\s+/.exec(texte);
      if (m && m[0].length < texte.length && marques.slice(k).some((x) => ATTENTION.has(nouveauConteneur(x).type))) {
        ajouterTexte(courant(), m[0]);
        texte = texte.slice(m[0].length);
      }
    }
    for (; k < marques.length; k++) {
      const n = nouveauConteneur(marques[k]);
      courant().children!.push(n);
      pile.push({ m: marques[k], n });
    }
    const dans = courant();
    if (enfant.isText) {
      if (feuille?.type.name === "code") dans.children!.push({ type: "inlineCode", value: texte ?? "" });
      else if (feuille?.type.name === "brut") dans.children!.push({ type: "html", value: texte ?? "" });
      else ajouterTexte(dans, texte ?? "");
    } else if (enfant.type.name === "hardBreak") {
      if (enfant.attrs.forme === "doux") ajouterTexte(dans, "\n");
      else dans.children!.push({ type: "break", data: { forme: enfant.attrs.forme } });
    } else if (enfant.type.name === "wikilien") {
      dans.children!.push({ type: "wikiLink", value: enfant.attrs.valeur });
    } else if (enfant.type.name === "imageEnLigne") {
      dans.children!.push({ type: "image", url: enfant.attrs.src, alt: enfant.attrs.alt ?? "", title: enfant.attrs.titre || null });
    }
  });
  fermerJusqua(0);
  marquerSeuls(racine);
  return racine.children!;
}

/** Note les caractères « * », « _ », « ~ » présents une seule fois dans tout le paragraphe (sans gras, italique, barré) :
 *  la sérialisation n'a alors pas besoin de les échapper (« 10 * 3 », « ~/.cache », « sous-destination* Autres »). */
function marquerSeuls(racine: MNode): void {
  const textes: MNode[] = [];
  let attention = false;
  const visiter = (n: MNode) => {
    if (n.type === "text") textes.push(n);
    if (n.type === "strong" || n.type === "emphasis" || n.type === "delete") attention = true;
    for (const c of n.children ?? []) visiter(c);
  };
  visiter(racine);
  if (attention) return;
  for (const c of ["*", "_", "~"]) {
    let total = 0;
    let porteur: MNode | null = null;
    for (const t of textes) {
      const k = (t.value ?? "").split(c).length - 1;
      if (k) { total += k; porteur = t; }
    }
    if (total === 1 && porteur) porteur.data = { ...(porteur.data ?? {}), seuls: String(porteur.data?.seuls ?? "") + c };
  }
}
