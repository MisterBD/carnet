// Carnet · bases (lot 2 V3) : lecture du bloc ```base (YAML), lecture typée du frontmatter des entrées,
// réécriture CHIRURGICALE du bloc (filtres, tri) qui conserve à l'octet tout le reste, ou refuse.
import YAML from "yaml";
import { decouper } from "../../shared/page.ts";
import {
  analyserExpression, compilerFiltre, ErreurExpression, lireDeclaration, lireReference, TYPES_PROPRIETE, validerSaisie,
} from "../../shared/bases.ts";
import type {
  DeclarationPropriete, EntreeBase, ErreurBase, Filtre, ProprieteLue, Sens, Tri, ValeurBrute, ValeurSaisie,
} from "../../shared/bases.ts";
import { ErreurHttp } from "./http.ts";

export const MAX_SOURCE_BASE = 64 * 1024;

// ================================================================================================
// Blocs ```base dans une page
// ================================================================================================

export interface BlocBase {
  /** Rang du bloc parmi les blocs ```base de la page (0, 1…). */
  index: number;
  /** Texte YAML entre les délimiteurs (sans le saut de ligne final). */
  source: string;
  /** Lignes (0-based) du délimiteur ouvrant et du délimiteur fermant (-1 si non fermé). */
  ligneDebut: number;
  ligneFin: number;
}

const RE_OUVRE = /^ {0,3}(`{3,}|~{3,})[ \t]*base[ \t]*$/;
const RE_OUVRE_AUTRE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_FERME = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Blocs ```base au premier niveau (pas dans une liste ni une citation), hors des autres blocs de code. */
export function trouverBlocsBase(contenu: string): BlocBase[] {
  const lignes = contenu.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
  const blocs: BlocBase[] = [];
  let i = 0;
  while (i < lignes.length) {
    const l = lignes[i];
    const autre = RE_OUVRE_AUTRE.exec(l);
    if (!autre || (autre[1][0] === "`" && autre[2].includes("`"))) { i++; continue; }
    const c = autre[1][0];
    const n = autre[1].length;
    let j = i + 1;
    while (j < lignes.length) {
      const f = RE_FERME.exec(lignes[j]);
      if (f && f[1][0] === c && f[1].length >= n) break;
      j++;
    }
    if (RE_OUVRE.test(l)) {
      blocs.push({ index: blocs.length, source: lignes.slice(i + 1, j).join("\n"), ligneDebut: i, ligneFin: j < lignes.length ? j : -1 });
    }
    i = j + 1;
  }
  return blocs;
}

// ================================================================================================
// Définition d'une base (lecture du YAML + validation du sous-ensemble)
// ================================================================================================

export interface VueDef {
  index: number;
  nom: string;
  type: string;
  /** Seule la vue « table » est prise en charge. */
  prise: boolean;
  filtre: Filtre | null;
  filtreBrut: unknown;
  ordre: string[] | null;
  tris: Tri[];
  limite: number | null;
}

export interface DefinitionBase {
  filtre: Filtre | null;
  filtreBrut: unknown;
  /** `properties.<id>.displayName` */
  libelles: Map<string, string>;
  vues: VueDef[];
  dossier: string | null;
  declarations: Map<string, DeclarationPropriete>;
  /** Valeurs initiales des nouvelles entrées (`carnet.nouvelle`), validées. */
  nouvelle: Record<string, ValeurSaisie>;
  /** Échéances : fiches datées de la base montrées dans Aujourd'hui (`carnet.aujourdhui`), sinon null. */
  aujourdhui: DeclarationAujourdhui | null;
  avertissements: string[];
}

/**
 * Échéances (11/10/2026) : la base déclare quelle propriété est l'échéance et quel état veut dire « fait ». Sans cette
 * déclaration, rien ne remonte dans Aujourd'hui (aucune devinette). Forme :
 *   carnet:
 *     aujourdhui:
 *       echeance: echeance          # clé du frontmatter (propriété date)
 *       fait: { propriete: statut, valeur: Fait }   # « fait » = cette valeur (texte, ou true pour une case)
 *       priorite: priorite          # facultatif : affichée à côté de la fiche
 */
export interface DeclarationAujourdhui {
  echeance: string;
  fait: { propriete: string; valeur: string | boolean };
  priorite: string | null;
}

const RE_CLE_FM = /^[^\s:#][^:#\n]{0,63}$/;

/** Lit `carnet.aujourdhui` ; une forme invalide est un AVERTISSEMENT (la base reste affichée, rien ne remonte). */
export function lireDeclarationAujourdhui(v: unknown, declarations: Map<string, DeclarationPropriete>, avert: string[]): DeclarationAujourdhui | null {
  if (v === undefined || v === null) return null;
  const refus = (m: string) => { avert.push(`carnet.aujourdhui : ${m} Rien n'est montré dans Aujourd'hui.`); return null; };
  if (!estObjet(v)) return refus("attend « echeance » et « fait ».");
  const cle = (x: unknown) => (typeof x === "string" ? x.trim().replace(/^note\./, "") : "");
  const echeance = cle(v.echeance);
  if (!echeance || !RE_CLE_FM.test(echeance)) return refus("« echeance » attend le nom d'une propriété date.");
  const de = declarations.get(echeance);
  if (de && de.type !== "date") return refus(`« ${echeance} » n'est pas une propriété date (type ${de.type}).`);
  if (!estObjet(v.fait)) return refus("« fait » attend { propriete, valeur }.");
  const pf = cle(v.fait.propriete);
  if (!pf || !RE_CLE_FM.test(pf)) return refus("« fait.propriete » attend le nom d'une propriété.");
  if (pf === echeance) return refus("« fait.propriete » et « echeance » doivent être deux propriétés différentes.");
  const val = v.fait.valeur;
  const df = declarations.get(pf);
  let valeur: string | boolean;
  if (typeof val === "boolean") {
    if (df && df.type !== "case") return refus(`« ${pf} » n'est pas une case à cocher : « valeur » attend une de ses options.`);
    valeur = val;
  } else if (typeof val === "string" && val.trim()) {
    valeur = val.trim();
    if (df && df.type === "case") return refus(`« ${pf} » est une case à cocher : « valeur » attend true.`);
    if (df && (df.type === "statut" || df.type === "selection") && df.options && !df.options.includes(valeur)) {
      return refus(`« ${valeur} » n'est pas une option de « ${pf} » (${df.options.join(", ")}).`);
    }
  } else return refus("« fait.valeur » attend la valeur qui veut dire « fait » (texte, ou true pour une case).");
  let priorite: string | null = null;
  if (v.priorite !== undefined && v.priorite !== null) {
    priorite = cle(v.priorite);
    if (!priorite || !RE_CLE_FM.test(priorite)) { avert.push("carnet.aujourdhui.priorite : nom de propriété attendu, ignoré."); priorite = null; }
  }
  for (const k of Object.keys(v)) if (!["echeance", "fait", "priorite"].includes(k)) avert.push(`carnet.aujourdhui.${k} : clé inconnue, conservée.`);
  return { echeance, fait: { propriete: pf, valeur }, priorite };
}

const CLES_RACINE = new Set(["filters", "formulas", "properties", "summaries", "views", "carnet"]);
const CLES_VUE_IGNOREES: Record<string, string> = {
  groupBy: "le regroupement (groupBy) est ignoré : les lignes ne sont pas regroupées",
  groupOrder: "l'ordre des groupes (groupOrder) est ignoré",
  summaries: "les résumés (summaries) ne sont pas calculés",
};

function estObjet(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

/** Analyse le YAML d'un bloc ```base. Erreurs (liste) si le bloc sort du sous-ensemble pris en charge. */
export function lireDefinition(source: string): { def: DefinitionBase | null; erreurs: ErreurBase[] } {
  const erreurs: ErreurBase[] = [];
  const avertissements: string[] = [];
  if (source.length > MAX_SOURCE_BASE) return { def: null, erreurs: [{ ou: "bloc", message: "Bloc trop volumineux (64 Kio au plus)." }] };
  const doc = YAML.parseDocument(source, { uniqueKeys: true, prettyErrors: false, version: "1.2" });
  if (doc.errors.length) {
    return { def: null, erreurs: doc.errors.slice(0, 5).map((e) => ({ ou: "YAML", message: `YAML invalide : ${e.message.split("\n")[0]}` })) };
  }
  let js: unknown;
  try {
    js = doc.toJS({ maxAliasCount: 10 });
  } catch (e) {
    return { def: null, erreurs: [{ ou: "YAML", message: `YAML illisible : ${(e as Error).message}` }] };
  }
  if (js === null || js === undefined) js = {};
  if (!estObjet(js)) return { def: null, erreurs: [{ ou: "bloc", message: "Le bloc doit contenir des clés (filters, views…)." }] };
  for (const k of Object.keys(js)) if (!CLES_RACINE.has(k)) avertissements.push(`Clé « ${k} » inconnue de Carnet : conservée telle quelle.`);
  if (js.formulas !== undefined && js.formulas !== null) avertissements.push("Les formules (formulas) ne sont pas prises en charge : conservées, non calculées.");
  if (js.summaries !== undefined && js.summaries !== null) avertissements.push("Les résumés (summaries) ne sont pas calculés : conservés.");

  const filtreBrut = js.filters;
  const filtre = filtreBrut === undefined || filtreBrut === null ? null : compilerFiltre(filtreBrut, "filters", erreurs);

  const libelles = new Map<string, string>();
  if (js.properties !== undefined && js.properties !== null) {
    if (!estObjet(js.properties)) erreurs.push({ ou: "properties", message: "« properties » attend des propriétés et leur displayName." });
    else for (const [id, conf] of Object.entries(js.properties)) {
      if (estObjet(conf) && typeof conf.displayName === "string" && conf.displayName.trim()) libelles.set(id, conf.displayName.trim());
    }
  }

  const vues: VueDef[] = [];
  const vuesBrutes = js.views;
  if (vuesBrutes === undefined || vuesBrutes === null) {
    vues.push({ index: 0, nom: "Tableau", type: "table", prise: true, filtre: null, filtreBrut: undefined, ordre: null, tris: [], limite: null });
  } else if (!Array.isArray(vuesBrutes) || vuesBrutes.length === 0) {
    erreurs.push({ ou: "views", message: "« views » attend une liste de vues." });
  } else {
    vuesBrutes.slice(0, 20).forEach((v, i) => {
      const ou = `views[${i}]`;
      if (!estObjet(v)) { erreurs.push({ ou, message: "Une vue est un ensemble de clés (type, name…)." }); return; }
      const type = typeof v.type === "string" ? v.type : "";
      const nom = typeof v.name === "string" && v.name.trim() ? v.name.trim() : `Vue ${i + 1}`;
      const prise = type === "table";
      let fv: Filtre | null = null;
      const errVue: ErreurBase[] = [];
      if (v.filters !== undefined && v.filters !== null) fv = compilerFiltre(v.filters, `${ou}.filters`, errVue);
      let ordre: string[] | null = null;
      if (v.order !== undefined && v.order !== null) {
        if (!Array.isArray(v.order) || !v.order.every((x) => typeof x === "string")) errVue.push({ ou: `${ou}.order`, message: "« order » attend une liste de propriétés." });
        else ordre = (v.order as string[]).slice(0, 60);
      }
      const tris: Tri[] = [];
      if (v.sort !== undefined && v.sort !== null) {
        if (!Array.isArray(v.sort)) errVue.push({ ou: `${ou}.sort`, message: "« sort » attend une liste de { property, direction }." });
        else v.sort.slice(0, 10).forEach((t, k) => {
          const o = `${ou}.sort[${k}]`;
          if (!estObjet(t) || typeof t.property !== "string") { errVue.push({ ou: o, message: "Tri attendu : { property: …, direction: ASC ou DESC }." }); return; }
          const d = t.direction === undefined ? "ASC" : String(t.direction).toUpperCase();
          if (d !== "ASC" && d !== "DESC") { errVue.push({ ou: `${o}.direction`, message: "direction : ASC ou DESC." }); return; }
          const r = lireReference(t.property);
          if (r.nature === "formule") { errVue.push({ ou: o, message: "Tri sur une formule non pris en charge." }); return; }
          if (r.nature === "inconnue") { errVue.push({ ou: o, message: r.message }); return; }
          tris.push({ propriete: t.property, sens: d as Sens });
        });
      }
      let limite: number | null = null;
      if (v.limit !== undefined && v.limit !== null) {
        if (typeof v.limit !== "number" || !Number.isInteger(v.limit) || v.limit < 1 || v.limit > 100000) errVue.push({ ou: `${ou}.limit`, message: "« limit » attend un entier positif." });
        else limite = v.limit;
      }
      if (prise) {
        for (const [k, msg] of Object.entries(CLES_VUE_IGNOREES)) if (v[k] !== undefined && v[k] !== null) avertissements.push(`${nom} : ${msg}.`);
        erreurs.push(...errVue);
      }
      vues.push({ index: i, nom, type: type || "?", prise, filtre: fv, filtreBrut: v.filters, ordre, tris, limite });
    });
  }

  let dossier: string | null = null;
  const declarations = new Map<string, DeclarationPropriete>();
  const nouvelle: Record<string, ValeurSaisie> = {};
  let aujourdhui: DeclarationAujourdhui | null = null;
  const c = js.carnet;
  if (c !== undefined && c !== null) {
    if (!estObjet(c)) erreurs.push({ ou: "carnet", message: "« carnet » attend des clés (dossier, proprietes, nouvelle)." });
    else {
      if (c.dossier !== undefined && c.dossier !== null) {
        if (typeof c.dossier !== "string" || !c.dossier.trim()) erreurs.push({ ou: "carnet.dossier", message: "« dossier » attend un chemin de dossier." });
        else dossier = c.dossier.trim().replace(/^\/+|\/+$/g, "");
      }
      if (c.proprietes !== undefined && c.proprietes !== null) {
        if (!estObjet(c.proprietes)) erreurs.push({ ou: "carnet.proprietes", message: `« proprietes » attend, pour chaque propriété, un type (${TYPES_PROPRIETE.join(", ")}).` });
        else for (const [cle, decl] of Object.entries(c.proprietes)) {
          const d = lireDeclaration(decl, `carnet.proprietes.${cle}`, erreurs);
          if (d) declarations.set(cle.startsWith("note.") ? cle.slice(5) : cle, d);
        }
      }
      if (c.nouvelle !== undefined && c.nouvelle !== null) {
        if (!estObjet(c.nouvelle)) erreurs.push({ ou: "carnet.nouvelle", message: "« nouvelle » attend les valeurs initiales des nouvelles entrées." });
        else for (const [cle, val] of Object.entries(c.nouvelle)) {
          const r = validerSaisie(declarations.get(cle) ?? null, val);
          if (!r.ok) erreurs.push({ ou: `carnet.nouvelle.${cle}`, message: r.message });
          else nouvelle[cle] = r.valeur;
        }
      }
      aujourdhui = lireDeclarationAujourdhui(c.aujourdhui, declarations, avertissements);
      for (const k of Object.keys(c)) if (!["dossier", "proprietes", "nouvelle", "aujourdhui"].includes(k)) avertissements.push(`carnet.${k} : clé inconnue, conservée.`);
    }
  }
  if (erreurs.length) return { def: null, erreurs };
  return { def: { filtre, filtreBrut, libelles, vues, dossier, declarations, nouvelle, aujourdhui, avertissements }, erreurs };
}

// ================================================================================================
// Frontmatter des entrées : YAML 1.2 strict, anomalies visibles (jamais une valeur au hasard)
// ================================================================================================

export interface LectureFrontmatter {
  proprietes: Map<string, ProprieteLue>;
  yamlInvalide: string | null;
}

function lireScalaire(n: YAML.Scalar): { ok: true; v: string | number | boolean | null } | { ok: false; raison: string } {
  if (n.tag) return { ok: false, raison: `étiquette YAML (${n.tag.replace("tag:yaml.org,2002:", "!!")})` };
  if (n.anchor) return { ok: false, raison: `ancre YAML (&${n.anchor})` };
  const v = n.value;
  if (v === null || typeof v === "string" || typeof v === "boolean") return { ok: true, v };
  if (typeof v === "number") return Number.isFinite(v) ? { ok: true, v } : { ok: false, raison: "nombre non fini" };
  return { ok: false, raison: "valeur non prise en charge" };
}

/** Lit les propriétés d'un frontmatter (YAML sans délimiteurs). */
export function lireFrontmatterBase(yaml: string): LectureFrontmatter {
  const proprietes = new Map<string, ProprieteLue>();
  if (!yaml.trim()) return { proprietes, yamlInvalide: null };
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(yaml, { uniqueKeys: false, prettyErrors: false, version: "1.2" });
  } catch (e) {
    return { proprietes, yamlInvalide: (e as Error).message.split("\n")[0] };
  }
  if (doc.errors.length) return { proprietes, yamlInvalide: doc.errors[0].message.split("\n")[0] };
  const racine = doc.contents;
  if (racine === null) return { proprietes, yamlInvalide: null };
  if (!YAML.isMap(racine)) return { proprietes, yamlInvalide: "l'en-tête n'est pas une liste de propriétés" };
  const vues = new Map<string, number>();
  for (const paire of racine.items) {
    const k = paire.key;
    const cle = YAML.isScalar(k) ? String(k.value) : String(k);
    vues.set(cle, (vues.get(cle) ?? 0) + 1);
  }
  for (const paire of racine.items) {
    const k = paire.key;
    const cle = YAML.isScalar(k) ? String(k.value) : String(k);
    const v = paire.value as YAML.Node | null;
    const brut = v && v.range ? yaml.slice(v.range[0], v.range[1]) : "";
    let lue: ProprieteLue;
    if ((vues.get(cle) ?? 0) > 1) lue = { etat: "anomalie", raison: "clé en double dans l'en-tête", brut };
    else if (!YAML.isScalar(k) || typeof k.value !== "string" && typeof k.value !== "number") lue = { etat: "anomalie", raison: "nom de propriété complexe", brut };
    else if (cle === "<<") lue = { etat: "anomalie", raison: "clé de fusion YAML (<<)", brut };
    else if (v === null || v === undefined) lue = { etat: "valeur", valeur: null, brut };
    else if (YAML.isAlias(v)) lue = { etat: "anomalie", raison: "alias YAML (*…)", brut };
    else if (YAML.isMap(v)) lue = { etat: "anomalie", raison: "objet imbriqué", brut };
    else if (YAML.isSeq(v)) {
      if (v.anchor || v.tag) lue = { etat: "anomalie", raison: v.anchor ? `ancre YAML (&${v.anchor})` : "étiquette YAML", brut };
      else {
        const liste: Array<string | number | boolean | null> = [];
        let raison: string | null = null;
        for (const it of v.items) {
          if (!YAML.isScalar(it)) { raison = YAML.isAlias(it) ? "alias YAML dans une liste" : "liste imbriquée ou objet dans une liste"; break; }
          const s = lireScalaire(it);
          if (!s.ok) { raison = `${s.raison} dans une liste`; break; }
          liste.push(s.v);
        }
        lue = raison ? { etat: "anomalie", raison, brut } : { etat: "valeur", valeur: liste, brut };
      }
    } else if (YAML.isScalar(v)) {
      const s = lireScalaire(v);
      lue = s.ok ? { etat: "valeur", valeur: s.v, brut } : { etat: "anomalie", raison: s.raison, brut };
    } else lue = { etat: "anomalie", raison: "valeur non prise en charge", brut };
    // clé en double : la première anomalie suffit (même message)
    if (!proprietes.has(cle)) proprietes.set(cle, lue);
  }
  return { proprietes, yamlInvalide: null };
}

const RE_ETIQUETTE = /(?:^|[\s(,;])#([\p{L}\p{N}_/-]+)/gu;
const RE_OUVERTURE_CODE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** Étiquettes du corps (#etiquette), hors blocs de code et code en ligne ; pas les titres (« # Titre »). */
export function etiquettesDuCorps(corps: string): string[] {
  const res = new Set<string>();
  let ouvert: { c: string; n: number } | null = null;
  for (const brute of corps.split("\n")) {
    const l = brute.endsWith("\r") ? brute.slice(0, -1) : brute;
    if (ouvert) {
      const f = RE_FERME.exec(l);
      if (f && f[1][0] === ouvert.c && f[1].length >= ouvert.n) ouvert = null;
      continue;
    }
    const m = RE_OUVERTURE_CODE.exec(l);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) { ouvert = { c: m[1][0], n: m[1].length }; continue; }
    if (!l.includes("#")) continue;
    const sansCode = l.replace(/`+[^`]*`+/g, " ");
    for (const x of sansCode.matchAll(RE_ETIQUETTE)) {
      const t = x[1].replace(/\/+$/, "");
      if (t && !/^\d+$/.test(t) && res.size < 200) res.add(t);
    }
  }
  return [...res];
}

/** Étiquettes du frontmatter `tags` (liste ou texte séparé par des virgules/espaces), sans « # ». */
export function etiquettesFrontmatter(p: ProprieteLue | undefined): string[] {
  if (!p || p.etat !== "valeur" || p.valeur === null) return [];
  const brut = Array.isArray(p.valeur) ? p.valeur.filter((x) => x !== null).map(String) : String(p.valeur).split(/[,\s]+/);
  return brut.map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
}

/** Construit l'entrée d'une page (contenu complet). */
export function entreeDePage(p: { chemin: string; titre: string; icone: string | null; etag: string; taille: number; mtime: number; ctime: number; contenu: string }): EntreeBase {
  const d = decouper(p.contenu);
  const fm = lireFrontmatterBase(d.yaml);
  const etiquettes = new Set([...etiquettesFrontmatter(fm.proprietes.get("tags")), ...etiquettesDuCorps(d.corps)]);
  return {
    chemin: p.chemin, titre: p.titre, icone: p.icone, etag: p.etag, taille: p.taille, mtime: p.mtime, ctime: p.ctime,
    etiquettes: [...etiquettes], proprietes: fm.proprietes, yamlInvalide: fm.yamlInvalide,
  };
}

// ================================================================================================
// Réécriture chirurgicale du bloc (filtres, tri)
// ================================================================================================

export class RefusReecriture extends ErreurHttp {
  constructor(message: string, erreurs?: ErreurBase[]) {
    super(422, message, "reecriture_refusee", { raison: "reecriture_refusee", ...(erreurs ? { erreurs } : {}) });
  }
}

type Chemin = Array<string | number>;

function analyser(source: string): YAML.Document.Parsed {
  const doc = YAML.parseDocument(source, { uniqueKeys: true, prettyErrors: false, version: "1.2" });
  if (doc.errors.length) throw new RefusReecriture(`YAML invalide : ${doc.errors[0].message.split("\n")[0]}`);
  return doc;
}

/** Commentaires (« # … ») du YAML, au sens de l'analyseur lexical (pas ceux des blocs littéraux). */
function commentaires(source: string): string[] {
  const res: string[] = [];
  for (const t of new YAML.Lexer().lex(source)) if (t.startsWith("#")) res.push(t.trimEnd());
  return res;
}

function debutLigne(s: string, pos: number): number {
  return s.lastIndexOf("\n", pos - 1) + 1;
}

function finLigne(s: string, pos: number): number {
  if (pos > 0 && s[pos - 1] === "\n") return pos;
  const i = s.indexOf("\n", pos);
  return i === -1 ? s.length : i + 1;
}

const OPTIONS_ECRITURE: YAML.ToStringOptions = { indent: 2, lineWidth: 0, minContentWidth: 0, indentSeq: true, defaultStringType: "PLAIN", defaultKeyType: "PLAIN", singleQuote: true };

function indenter(texte: string, col: number): string {
  const pad = " ".repeat(col);
  return texte.split("\n").map((l, i, t) => (i === t.length - 1 && l === "" ? l : pad + l)).join("\n");
}

function cloner<T>(v: T): T {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

function poserDans(racine: unknown, chemin: Chemin, valeur: unknown): unknown {
  if (!chemin.length) return valeur;
  const copie = cloner(racine) as Record<string | number, unknown>;
  let o = copie as Record<string | number, unknown>;
  for (let i = 0; i < chemin.length - 1; i++) o = o[chemin[i]] as Record<string | number, unknown>;
  const k = chemin[chemin.length - 1];
  if (valeur === undefined) {
    if (Array.isArray(o) && typeof k === "number") o.splice(k, 1);
    else delete o[k];
  } else o[k] = valeur;
  return copie;
}

/** Contrôle final : YAML valide, contenu = celui attendu, aucun commentaire perdu. Sinon refus. */
function verifier(avant: string, apres: string, attendu: unknown): void {
  const d = YAML.parseDocument(apres, { uniqueKeys: true, prettyErrors: false, version: "1.2" });
  if (d.errors.length) throw new RefusReecriture("La réécriture donnerait un YAML invalide : modification refusée.");
  if (JSON.stringify(d.toJS() ?? {}) !== JSON.stringify(attendu ?? {})) {
    throw new RefusReecriture("Carnet ne sait pas réécrire ce bloc sans risque d'en changer le sens : modifie le YAML à la main.");
  }
  const reste = [...commentaires(apres)];
  for (const c of commentaires(avant)) {
    const i = reste.indexOf(c);
    if (i === -1) throw new RefusReecriture("Cette modification ferait perdre un commentaire du bloc : modifie le YAML à la main.");
    reste.splice(i, 1);
  }
}

function terminer(original: string, nouveau: string): string {
  // même fin de bloc qu'avant (le texte d'un bloc de code n'a pas toujours de saut de ligne final)
  if (!original.endsWith("\n") && nouveau.endsWith("\n")) return nouveau.slice(0, -1);
  return nouveau;
}

/** Pose (valeur ≠ undefined) ou retire (undefined) la clé `cle` d'une table en style bloc, sans toucher au reste. */
export function poserCle(source: string, cheminTable: Chemin, cle: string, valeur: unknown): string {
  const doc = analyser(source);
  const js0 = doc.toJS() ?? {};
  const table = cheminTable.length ? doc.getIn(cheminTable, true) : doc.contents;
  let s = source;
  if (table === null || table === undefined) {
    if (cheminTable.length) throw new RefusReecriture("Emplacement introuvable dans le bloc.");
    // bloc vide : on écrit la clé
    if (valeur === undefined) return source;
    s = (source.trim() ? source + (source.endsWith("\n") ? "" : "\n") : "") + YAML.stringify({ [cle]: valeur }, OPTIONS_ECRITURE);
    verifier(source, s, poserDans(js0, [cle], valeur));
    return terminer(source, s);
  }
  if (!YAML.isMap(table) || table.flow) throw new RefusReecriture("Cette partie du bloc est écrite sur une ligne ({ … }) : modifie le YAML à la main.");
  const attendu = poserDans(js0, [...cheminTable, cle], valeur);
  const paire = table.items.find((p) => YAML.isScalar(p.key) && p.key.value === cle);
  const premier = table.items[0];
  const col = premier && YAML.isScalar(premier.key) && premier.key.range ? premier.key.range[0] - debutLigne(source, premier.key.range[0]) : (cheminTable.length ? 2 : 0);
  const texte = valeur === undefined ? "" : indenter(YAML.stringify({ [cle]: valeur }, OPTIONS_ECRITURE), col);
  if (paire) {
    const k = paire.key as YAML.Scalar;
    if (!k.range) throw new RefusReecriture("Position introuvable dans le bloc.");
    const v = paire.value as YAML.Node | null;
    // début : la ligne de la clé, sauf si la clé suit « - » (premier élément d'une liste) : on garde « - »
    const dl = debutLigne(source, k.range[0]);
    const avantCle = source.slice(dl, k.range[0]);
    const debut = /^\s*$/.test(avantCle) ? dl : k.range[0];
    const finBrute = Math.max(k.range[2], v && v.range ? v.range[2] : k.range[2]);
    const fin = finLigne(source, finBrute);
    let rempl = texte;
    if (debut !== dl) {
      // la clé est sur la ligne d'un « - » : premier élément d'une table dans une liste
      if (valeur === undefined) throw new RefusReecriture("Carnet ne sait pas retirer la première clé d'un élément de liste : modifie le YAML à la main.");
      rempl = texte.slice(col);
    }
    if (fin === source.length && !source.endsWith("\n") && rempl.endsWith("\n")) rempl = rempl.slice(0, -1);
    s = source.slice(0, debut) + rempl + source.slice(fin);
  } else {
    if (valeur === undefined) return source;
    const der = table.items[table.items.length - 1];
    let pos: number;
    if (der) {
      const v = der.value as YAML.Node | null;
      const k = der.key as YAML.Node;
      pos = finLigne(source, Math.max(k.range?.[2] ?? 0, v && v.range ? v.range[2] : 0));
    } else pos = source.length;
    const prefixe = pos === source.length && source.length > 0 && !source.endsWith("\n") ? "\n" : "";
    s = source.slice(0, pos) + prefixe + texte + source.slice(pos);
  }
  verifier(source, s, attendu);
  return terminer(source, s);
}

/** Ajoute un élément à la fin d'une liste en style bloc (« - … »), sans toucher aux autres. */
export function ajouterALaListe(source: string, cheminListe: Chemin, valeur: unknown): string {
  const doc = analyser(source);
  const js0 = doc.toJS() ?? {};
  const liste = doc.getIn(cheminListe, true);
  if (!YAML.isSeq(liste) || liste.flow || liste.items.length === 0) throw new RefusReecriture("Liste introuvable ou écrite sur une ligne ([ … ]) : modifie le YAML à la main.");
  const premier = liste.items[0] as YAML.Node;
  const der = liste.items[liste.items.length - 1] as YAML.Node;
  if (!premier.range || !der.range) throw new RefusReecriture("Position introuvable dans le bloc.");
  let tiret = premier.range[0] - 1;
  while (tiret >= 0 && (source[tiret] === " " || source[tiret] === "\t")) tiret--;
  if (source[tiret] !== "-") throw new RefusReecriture("Forme de liste inattendue : modifie le YAML à la main.");
  const col = tiret - debutLigne(source, tiret);
  const pos = finLigne(source, der.range[2]);
  const prefixe = pos === source.length && !source.endsWith("\n") ? "\n" : "";
  const s = source.slice(0, pos) + prefixe + indenter(YAML.stringify([valeur], OPTIONS_ECRITURE), col) + source.slice(pos);
  const attendu = cloner(js0) as Record<string | number, unknown>;
  let o: unknown = attendu;
  for (const k of cheminListe) o = (o as Record<string | number, unknown>)[k];
  (o as unknown[]).push(valeur);
  verifier(source, s, attendu);
  return terminer(source, s);
}

/** Retire l'élément `index` d'une liste en style bloc (il doit en rester au moins un). */
export function retirerDeLaListe(source: string, cheminListe: Chemin, index: number): string {
  const doc = analyser(source);
  const js0 = doc.toJS() ?? {};
  const liste = doc.getIn(cheminListe, true);
  if (!YAML.isSeq(liste) || liste.flow) throw new RefusReecriture("Liste introuvable ou écrite sur une ligne ([ … ]) : modifie le YAML à la main.");
  const el = liste.items[index] as YAML.Node | undefined;
  if (!el || !el.range) throw new RefusReecriture("Ce filtre n'existe plus dans le bloc : recharge.");
  let tiret = el.range[0] - 1;
  while (tiret >= 0 && (source[tiret] === " " || source[tiret] === "\t")) tiret--;
  if (source[tiret] !== "-") throw new RefusReecriture("Forme de liste inattendue : modifie le YAML à la main.");
  const debut = debutLigne(source, tiret);
  if (!/^\s*$/.test(source.slice(debut, tiret))) throw new RefusReecriture("Forme de liste inattendue : modifie le YAML à la main.");
  const fin = finLigne(source, el.range[2]);
  const s = source.slice(0, debut) + source.slice(fin);
  verifier(source, s, poserDans(js0, [...cheminListe, index], undefined));
  return terminer(source, s);
}

export interface ChangementVue {
  /** Nouveau tri (remplace l'ancien) ; [] ou null = aucun tri. */
  tri?: Tri[] | null;
  /** Expression à ajouter aux filtres de la vue (liste « and »). */
  ajouterFiltre?: string;
  /** Rang du filtre à retirer dans la liste « and » de la vue. */
  retirerFiltre?: number;
}

/** Applique un changement de vue au bloc : renvoie le nouveau YAML, ou lève RefusReecriture (422). */
export function reecrireVue(source: string, vue: number, ch: ChangementVue): string {
  let s = source;
  let doc = analyser(s);
  if (!Number.isInteger(vue) || vue < 0 || vue > 19) throw new RefusReecriture("Vue invalide.");
  if (!doc.has("views")) {
    if (vue !== 0) throw new RefusReecriture("Vue introuvable.");
    s = poserCle(s, [], "views", [{ type: "table", name: "Tableau" }]);
    doc = analyser(s);
  }
  const vues = doc.get("views", true);
  if (!YAML.isSeq(vues) || !YAML.isMap(vues.items[vue])) throw new RefusReecriture("Vue introuvable dans le bloc.");
  if (ch.tri !== undefined) {
    const t = ch.tri && ch.tri.length ? ch.tri.map((x) => ({ property: x.propriete, direction: x.sens })) : undefined;
    for (const x of ch.tri ?? []) {
      if (typeof x.propriete !== "string" || !x.propriete || (x.sens !== "ASC" && x.sens !== "DESC")) throw new RefusReecriture("Tri invalide.");
      const r = lireReference(x.propriete);
      if (r.nature !== "note" && r.nature !== "fichier") throw new RefusReecriture("Tri sur cette colonne non pris en charge.");
    }
    s = poserCle(s, ["views", vue], "sort", t);
    doc = analyser(s);
  }
  if (ch.ajouterFiltre !== undefined) {
    try { analyserExpression(ch.ajouterFiltre); } catch (e) {
      // lot 12 : position comprise (l'interface montre l'endroit fautif)
      if (e instanceof ErreurExpression) {
        throw new RefusReecriture(`Filtre refusé : ${e.message} (position ${e.position + 1})`, [
          { ou: `views[${vue}].filters`, message: e.message, expression: ch.ajouterFiltre, position: e.position },
        ]);
      }
      throw e;
    }
    const f = jsDe(doc.getIn(["views", vue, "filters"]));
    if (f === undefined || f === null) s = poserCle(s, ["views", vue], "filters", { and: [ch.ajouterFiltre] });
    else if (typeof f === "string") s = poserCle(s, ["views", vue], "filters", { and: [f, ch.ajouterFiltre] });
    else if (estListeEt(f)) {
      const liste = doc.getIn(["views", vue, "filters", "and"], true);
      s = YAML.isSeq(liste) && !liste.flow && liste.items.length
        ? ajouterALaListe(s, ["views", vue, "filters", "and"], ch.ajouterFiltre)
        : poserCle(s, ["views", vue, "filters"], "and", [...(f.and as string[]), ch.ajouterFiltre]);
    } else throw new RefusReecriture("Les filtres de cette vue sont avancés (or, not…) : modifie le YAML à la main.");
    doc = analyser(s);
  }
  if (ch.retirerFiltre !== undefined) {
    const i = ch.retirerFiltre;
    const f = jsDe(doc.getIn(["views", vue, "filters"]));
    if (typeof f === "string" && i === 0) s = poserCle(s, ["views", vue], "filters", undefined);
    else if (estListeEt(f) && Number.isInteger(i) && i >= 0 && i < (f.and as unknown[]).length) {
      s = (f.and as unknown[]).length === 1
        ? poserCle(s, ["views", vue], "filters", undefined)
        : retirerDeLaListe(s, ["views", vue, "filters", "and"], i);
    } else throw new RefusReecriture("Ce filtre n'existe plus ou n'est pas modifiable ici : recharge.");
  }
  return s;
}

function jsDe(n: unknown): unknown {
  return YAML.isNode(n) ? n.toJS(new YAML.Document()) : n;
}

function estListeEt(f: unknown): f is { and: unknown[] } {
  return estObjet(f) && Object.keys(f).length === 1 && Array.isArray(f.and) && f.and.every((x) => typeof x === "string");
}

/** L'interface pourra-t-elle réécrire les filtres et le tri de cette vue ? (contrôle préalable, le vrai juge est la réécriture) */
export function reecriturePossible(source: string, vue: number): { possible: true } | { possible: false; raison: string } {
  let doc: YAML.Document.Parsed;
  try { doc = analyser(source); } catch (e) { return { possible: false, raison: (e as Error).message }; }
  const vues = doc.get("views", true);
  if (vues === undefined) return vue === 0 && (doc.contents === null || (YAML.isMap(doc.contents) && !doc.contents.flow)) ? { possible: true } : { possible: false, raison: "Vue introuvable." };
  if (!YAML.isSeq(vues) || vues.flow) return { possible: false, raison: "Les vues sont écrites sur une ligne : modifie le YAML à la main." };
  const v = vues.items[vue];
  if (!YAML.isMap(v) || v.flow) return { possible: false, raison: "Cette vue est écrite sur une ligne : modifie le YAML à la main." };
  return { possible: true };
}

// ================================================================================================
// K14-01 : gérer les vues depuis l'interface (nouvelle, dupliquer, renommer, supprimer, enregistrer comme nouvelle vue)
// Mêmes règles que filtres et tri : positions exactes de l'analyseur, seul le morceau visé change, puis contrôle
// (YAML valide, contenu relu = contenu attendu, aucun commentaire perdu hors de la vue supprimée) ; sinon refus (422).
// ================================================================================================

/** Filtres et tri d'une vue, tels qu'écrits (clé absente = propriété absente de l'objet). */
export interface EtatVue { filters?: unknown; sort?: unknown }

export const MAX_VUES = 20;
export const MAX_NOM_VUE = 80;

/** État (filtres, tri) de la vue `vue`, ou null si le bloc ne se lit pas. */
export function etatVue(source: string, vue: number): EtatVue | null {
  let doc: YAML.Document.Parsed;
  try { doc = analyser(source); } catch { return null; }
  const v = doc.getIn(["views", vue], true);
  if (!YAML.isMap(v)) return doc.has("views") ? null : {};
  const res: EtatVue = {};
  for (const k of ["filters", "sort"] as const) if (v.has(k)) res[k] = cloner(jsDe(v.get(k, true)));
  return res;
}

/** Nom affiché de chaque vue (même règle que la lecture : nom écrit, sinon « Vue n »). */
function nomsDesVues(doc: YAML.Document.Parsed): string[] {
  const vues = jsDe(doc.get("views", true));
  if (!Array.isArray(vues)) return ["Tableau"];
  return vues.map((v, i) => (estObjet(v) && typeof v.name === "string" && v.name.trim() ? v.name.trim() : `Vue ${i + 1}`));
}

/** Comparaison des noms de vues : casse, accents et espaces ignorés (la ligne « À relancer » d'Aujourd'hui fait de même). */
function plierNom(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Nom de vue saisi : propre, non vide, pas trop long, sans doublon (sauf la vue `sauf`). Sinon refus lisible. */
export function validerNomVue(brut: unknown, existants: string[], sauf = -1): string {
  if (typeof brut !== "string") throw new RefusReecriture("Nom de vue invalide.");
  const nom = brut.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " ").replace(/\s+/g, " ").trim();
  if (!nom) throw new RefusReecriture("Nom vide : donne un nom à la vue.");
  if (nom.length > MAX_NOM_VUE) throw new RefusReecriture(`Nom trop long : ${MAX_NOM_VUE} caractères au plus.`);
  const i = existants.findIndex((x, j) => j !== sauf && plierNom(x) === plierNom(nom));
  if (i !== -1) throw new RefusReecriture(`Une vue s'appelle déjà « ${existants[i]} » : choisis un autre nom.`);
  return nom;
}

/** Remplace la valeur scalaire à `chemin` (sur sa ligne, commentaire de fin de ligne gardé), ou pose la clé si absente. */
function poserScalaire(source: string, cheminTable: Chemin, cle: string, valeur: string): string {
  const doc = analyser(source);
  const n = doc.getIn([...cheminTable, cle], true);
  if (n === undefined) return poserCle(source, cheminTable, cle, valeur);
  if (!YAML.isScalar(n) || !n.range) throw new RefusReecriture("Ce nom de vue est écrit d'une façon que Carnet ne sait pas modifier : modifie le YAML à la main.");
  const texte = YAML.stringify(valeur, OPTIONS_ECRITURE).replace(/\n$/, "");
  if (texte.includes("\n")) throw new RefusReecriture("Nom de vue invalide.");
  const s = source.slice(0, n.range[0]) + texte + source.slice(n.range[1]);
  verifier(source, s, poserDans(doc.toJS() ?? {}, [...cheminTable, cle], valeur));
  return s;
}

/** Copie JS d'une vue sous un autre nom (`name` à sa place, ou juste après `type`). */
function copieNommee(v: unknown, nom: string): Record<string, unknown> {
  const o = estObjet(v) ? (cloner(v) as Record<string, unknown>) : {};
  if ("name" in o) { o.name = nom; return o; }
  const res: Record<string, unknown> = {};
  let pose = false;
  for (const [k, x] of Object.entries(o)) {
    res[k] = x;
    if (k === "type") { res.name = nom; pose = true; }
  }
  return pose ? res : { name: nom, ...res };
}

/** Remet filtres et tri d'une vue comme dans `orig` (retire d'abord ce qui a été ajouté à la fin, à l'octet). */
export function retablirVue(source: string, vue: number, orig: EtatVue): string {
  let s = source;
  for (const k of ["filters", "sort"] as const) {
    const doc = analyser(s);
    const v = doc.getIn(["views", vue], true);
    if (!YAML.isMap(v)) throw new RefusReecriture("Vue introuvable dans le bloc.");
    const cur = v.has(k) ? jsDe(v.get(k, true)) : undefined;
    const o = k in orig ? orig[k] : undefined;
    if (JSON.stringify(cur) === JSON.stringify(o)) continue;
    if (k === "filters" && o !== undefined && estListeEt(cur) && estListeEt(o) && o.and.length > 0 && o.and.length < cur.and.length
      && o.and.every((x, i) => x === cur.and[i])) {
      for (let i = cur.and.length - 1; i >= o.and.length; i--) s = retirerDeLaListe(s, ["views", vue, "filters", "and"], i);
    } else {
      s = poserCle(s, ["views", vue], k, o);
    }
  }
  return s;
}

export interface ChangementVues {
  /** Copie de la vue (filtres, tri, colonnes, autres clés) ajoutée à la fin sous ce nom ; `retablir` : la vue copiée
   *  reprend ensuite ces filtres et ce tri (« Enregistrer comme nouvelle vue » après avoir filtré). */
  nouvelleVue?: {
    nom: string; retablir?: EtatVue;
    /** Raccourci « Créer la vue À relancer » : filtres (liste « and ») et tri de la copie, à la place de ceux de la vue. */
    filtres?: string[]; tri?: Tri[];
  };
  /** Copie nommée « <nom> (copie) », « <nom> (copie 2) »… */
  dupliquerVue?: boolean;
  renommerVue?: string;
  supprimerVue?: boolean;
}

export interface ResultatVues {
  source: string;
  /** Vue à afficher ensuite. */
  vue: number;
  /** Nom de la vue créée ou renommée. */
  nom?: string;
  /** « Enregistrer comme nouvelle vue » : la vue de départ a-t-elle été remise comme avant ? */
  retablie?: boolean;
  raisonNonRetablie?: string;
}

export function estChangementDeVues(ch: object): ch is ChangementVues {
  return ["nouvelleVue", "dupliquerVue", "renommerVue", "supprimerVue"].some((k) => (ch as Record<string, unknown>)[k] !== undefined);
}

/** Applique UN changement de la liste des vues ; renvoie le nouveau YAML et la vue à montrer, ou lève RefusReecriture. */
export function changerVues(source: string, vue: number, ch: ChangementVues): ResultatVues {
  if (!Number.isInteger(vue) || vue < 0 || vue >= MAX_VUES) throw new RefusReecriture("Vue invalide.");
  let s = source;
  let doc = analyser(s);
  if (!doc.has("views")) {
    if (vue !== 0) throw new RefusReecriture("Vue introuvable.");
    if (ch.supprimerVue) throw new RefusReecriture("Impossible de supprimer la dernière vue : une base garde au moins une vue.");
    s = poserCle(s, [], "views", [{ type: "table", name: "Tableau" }]);
    doc = analyser(s);
  }
  const vues = doc.get("views", true);
  if (!YAML.isSeq(vues) || vues.flow) throw new RefusReecriture("Les vues sont écrites sur une ligne ([ … ]) : modifie le YAML à la main.");
  const el = vues.items[vue];
  if (!YAML.isMap(el)) throw new RefusReecriture("Vue introuvable dans le bloc : recharge.");
  const noms = nomsDesVues(doc);

  if (ch.renommerVue !== undefined) {
    const nom = validerNomVue(ch.renommerVue, noms, vue);
    if (el.flow) throw new RefusReecriture("Cette vue est écrite sur une ligne ({ … }) : modifie le YAML à la main.");
    if (el.get("name") === nom) return { source, vue, nom };
    return { source: terminer(source, poserScalaire(s, ["views", vue], "name", nom)), vue, nom };
  }

  if (ch.supprimerVue) {
    if (vues.items.length <= 1) throw new RefusReecriture("Impossible de supprimer la dernière vue : une base garde au moins une vue.");
    if (!el.range) throw new RefusReecriture("Position introuvable dans le bloc.");
    let tiret = el.range[0] - 1;
    while (tiret >= 0 && (s[tiret] === " " || s[tiret] === "\t")) tiret--;
    if (s[tiret] !== "-") throw new RefusReecriture("Forme de liste inattendue : modifie le YAML à la main.");
    const debut = debutLigne(s, tiret);
    if (!/^\s*$/.test(s.slice(debut, tiret))) throw new RefusReecriture("Forme de liste inattendue : modifie le YAML à la main.");
    const fin = finLigne(s, el.range[2]);
    const apres = s.slice(0, debut) + s.slice(fin);
    // contrôle : YAML valide, sens attendu ; seuls les commentaires écrits DANS la vue supprimée disparaissent
    const d = YAML.parseDocument(apres, { uniqueKeys: true, prettyErrors: false, version: "1.2" });
    if (d.errors.length) throw new RefusReecriture("La suppression donnerait un YAML invalide : modification refusée.");
    if (JSON.stringify(d.toJS() ?? {}) !== JSON.stringify(poserDans(doc.toJS() ?? {}, ["views", vue], undefined))) {
      throw new RefusReecriture("Carnet ne sait pas supprimer cette vue sans risque : modifie le YAML à la main.");
    }
    const restants = [...commentaires(apres)];
    const attendus = [...commentaires(s.slice(0, debut)), ...commentaires(s.slice(fin))];
    if (restants.length !== attendus.length || restants.some((c, i) => c !== attendus[i])) {
      throw new RefusReecriture("Cette suppression ferait perdre un commentaire du bloc : modifie le YAML à la main.");
    }
    return { source: terminer(source, apres), vue: Math.max(0, vue - 1) };
  }

  if (vues.items.length >= MAX_VUES) throw new RefusReecriture(`Une base a au plus ${MAX_VUES} vues : supprimes-en une d'abord.`);
  let nom: string;
  if (ch.dupliquerVue) {
    const base = noms[vue].replace(/ \(copie(?: \d+)?\)$/, "");
    nom = `${base} (copie)`;
    for (let n = 2; noms.some((x) => plierNom(x) === plierNom(nom)); n++) nom = `${base} (copie ${n})`;
    nom = validerNomVue(nom.slice(0, MAX_NOM_VUE), noms);
  } else if (ch.nouvelleVue) {
    nom = validerNomVue(ch.nouvelleVue.nom, noms);
  } else throw new RefusReecriture("Aucun changement demandé.");
  const copie = copieNommee(jsDe(el), nom);
  const nv = ch.nouvelleVue;
  if (nv?.filtres !== undefined) {
    if (!Array.isArray(nv.filtres) || nv.filtres.length > 20 || nv.filtres.some((x) => typeof x !== "string" || !x.trim() || x.length > 2000)) throw new RefusReecriture("Filtres invalides.");
    for (const x of nv.filtres) {
      try { analyserExpression(x); } catch (e) {
        if (e instanceof ErreurExpression) throw new RefusReecriture(`Filtre refusé : ${e.message} (position ${e.position + 1})`);
        throw e;
      }
    }
    if (nv.filtres.length) copie.filters = { and: [...nv.filtres] };
    else delete copie.filters;
  }
  if (nv?.tri !== undefined) {
    if (!Array.isArray(nv.tri) || nv.tri.length > 10) throw new RefusReecriture("Tri invalide.");
    for (const x of nv.tri) {
      if (typeof x?.propriete !== "string" || !x.propriete || (x.sens !== "ASC" && x.sens !== "DESC")) throw new RefusReecriture("Tri invalide.");
      const r = lireReference(x.propriete);
      if (r.nature !== "note" && r.nature !== "fichier") throw new RefusReecriture("Tri sur cette colonne non pris en charge.");
    }
    if (nv.tri.length) copie.sort = nv.tri.map((x) => ({ property: x.propriete, direction: x.sens }));
    else delete copie.sort;
  }
  s = ajouterALaListe(s, ["views"], copie);
  const nouvelle = vues.items.length;
  const res: ResultatVues = { source: s, vue: nouvelle, nom };
  if (ch.nouvelleVue?.retablir) {
    try {
      res.source = retablirVue(s, vue, ch.nouvelleVue.retablir);
      res.retablie = true;
    } catch (e) {
      if (!(e instanceof RefusReecriture)) throw e;
      res.retablie = false;
      res.raisonNonRetablie = e.message;
    }
  }
  res.source = terminer(source, res.source);
  return res;
}

export type { ValeurBrute };

// ================================================================================================
// Échéances (11/10/2026) : poser ou retirer `carnet.aujourdhui` depuis l'interface (« Afficher dans Aujourd'hui »).
// Même méthode que les vues : seul ce morceau change, contrôle final (YAML valide, sens attendu, commentaires gardés).
// ================================================================================================

/** Pose (decl) ou retire (null) `carnet.aujourdhui` ; retirer la dernière clé de `carnet` retire `carnet` (retour à l'octet). */
export function poserAujourdhui(source: string, decl: DeclarationAujourdhui | null): string {
  const doc = analyser(source);
  const js0 = (doc.toJS() ?? {}) as Record<string, unknown>;
  const carnet = js0.carnet;
  if (carnet !== undefined && carnet !== null && !estObjet(carnet)) throw new RefusReecriture("« carnet » n'est pas une liste de clés : modifie le YAML à la main.");
  if (decl === null) {
    if (!estObjet(carnet) || carnet.aujourdhui === undefined) return source;
    return Object.keys(carnet).length === 1 ? poserCle(source, [], "carnet", undefined) : poserCle(source, ["carnet"], "aujourdhui", undefined);
  }
  const valeur: Record<string, unknown> = { echeance: decl.echeance, fait: { propriete: decl.fait.propriete, valeur: decl.fait.valeur } };
  if (decl.priorite) valeur.priorite = decl.priorite;
  if (!estObjet(carnet)) return poserCle(source, [], "carnet", { aujourdhui: valeur });
  return poserCle(source, ["carnet"], "aujourdhui", valeur);
}
