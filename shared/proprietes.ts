// Carnet · propriétés d'une page (frontmatter YAML) : lecture, et modification d'UNE propriété sans rien altérer d'autre.
// Voir docs/architecture.md (section « Écritures »).
//
// Dialecte : YAML 1.2, schéma core du paquet `yaml` (comme l'index du serveur). Aucune dépendance ici : l'analyseur est
// INJECTÉ (`installerAnalyseurYaml`) par le serveur (server/src/analyseur-yaml.ts, chargé par server/src/ecriture.ts),
// car `shared/` est aussi importé par l'interface, qui n'embarque pas le paquet `yaml`. Sans analyseur installé,
// lireProprietes et poserPropriete lèvent une erreur explicite (jamais de repli silencieux).
//
// Méthode de modification (garantie « seule la propriété ciblée change, à l'octet ») :
//   1. l'analyseur donne les positions exactes (décalages) de chaque paire de premier niveau ;
//   2. on remplace UNIQUEMENT la plage de la valeur ciblée (ou on retire les lignes de la paire, ou on ajoute une ligne
//      avant le délimiteur de fin) : tout le reste du texte est recopié tel quel, par construction ;
//   3. on RÉANALYSE le résultat : YAML valide, mêmes clés dans le même ordre, mêmes valeurs pour toutes les autres clés,
//      valeur ciblée = valeur demandée. Sinon : refus 422 (ErreurFormat), rien n'est écrit.
// `yaml.parseDocument(...).toString()` n'est jamais utilisé pour écrire : il normalise guillemets, retraits et listes.
//
// Sémantique des valeurs (documentée pour les lots 1-3) :
//   - propriété absente (clé non présente) ≠ `null` (`cle: null` ou `cle:` sans valeur) ≠ chaîne vide (`cle: ""`) ;
//   - `0` et `false` sont des valeurs comme les autres (jamais « absentes ») ;
//   - poserPropriete(c, k, undefined) RETIRE la clé ; poserPropriete(c, k, null) écrit `k: null`.
import { decouper } from "./page.ts";

export type ValeurPropriete = string | number | boolean | null | string[];

/** Type déclaré d'une propriété (déclaré par une base, lot 2) : guide l'écriture et la validation. */
export type TypePropriete = "texte" | "nombre" | "case" | "date" | "liste" | "selection";

/** Erreur de format (YAML refusé, valeur invalide, marqueur de tâche ambigu…) : le serveur la traduit en 422. */
export class ErreurFormat extends Error {
  statut = 422;
  raison: string;
  constructor(message: string, raison: string) {
    super(message);
    this.raison = raison;
  }
}

// ---------------------------------------------------------------------------------------------
// Analyseur injecté
// ---------------------------------------------------------------------------------------------

/** Valeur d'une paire : décalages dans le texte YAML analysé (fin = fin de la valeur, commentaire exclu). */
export interface ValeurYaml {
  debut: number;
  fin: number;
  genre: "scalaire" | "liste" | "table" | "alias";
  /** Collection écrite en style « flux » (`[a, b]`, `{a: 1}`). */
  flux: boolean;
}

export interface PaireYaml {
  /** Clé telle que lue (valeur JS : chaîne en général). */
  cle: unknown;
  debutCle: number;
  finCle: number;
  valeur: ValeurYaml | null;
}

export interface AnalyseYaml {
  /** Erreurs de syntaxe (vide si le YAML est valide). */
  erreurs: string[];
  /** « vide » : aucun contenu (ou seulement des commentaires) ; « autre » : la racine n'est pas une table. */
  racine: "vide" | "table" | "autre";
  /** Paires de premier niveau, dans l'ordre du texte. */
  paires: PaireYaml[];
  /** Valeurs JS de premier niveau (vide si erreurs). */
  valeurs: Record<string, unknown>;
  /** Clés de premier niveau présentes plusieurs fois. */
  doublons: string[];
  /** Syntaxes refusées à l'écriture, trouvées n'importe où : ancre, alias, étiquette, clé de fusion, clé complexe. */
  interdits: string[];
}

export type AnalyseurYaml = (source: string) => AnalyseYaml;

let analyseur: AnalyseurYaml | null = null;

/** Installe l'analyseur YAML (fait par server/src/analyseur-yaml.ts ; l'interface peut en installer un aussi). */
export function installerAnalyseurYaml(a: AnalyseurYaml): void {
  analyseur = a;
}

export function analyseurYamlInstalle(): boolean {
  return analyseur !== null;
}

function analyser(source: string): AnalyseYaml {
  if (!analyseur) {
    throw new Error("shared/proprietes.ts : analyseur YAML non installé (importer server/src/analyseur-yaml.ts ou server/src/ecriture.ts)");
  }
  return analyseur(source);
}

// ---------------------------------------------------------------------------------------------
// Lecture
// ---------------------------------------------------------------------------------------------

export interface LectureProprietes {
  valeurs: Record<string, unknown>;
  /** false si le YAML est invalide (syntaxe, racine qui n'est pas une table, clés en double). */
  yamlValide: boolean;
  /** Raisons lisibles : invalidité, ou syntaxes qui rendront toute modification impossible (ancre, étiquette…). */
  problemes: string[];
  /** true si poserPropriete acceptera de modifier cette page (YAML valide et sans syntaxe refusée). */
  modifiable: boolean;
}

export function lireProprietes(contenu: string): LectureProprietes {
  const d = decouper(contenu);
  if (!d.frontmatter) return { valeurs: {}, yamlValide: true, problemes: [], modifiable: true };
  const a = analyser(d.yaml);
  const problemes = problemesDe(a);
  const yamlValide = !a.erreurs.length && a.racine !== "autre" && !a.doublons.length;
  return { valeurs: a.erreurs.length || a.racine === "autre" ? {} : a.valeurs, yamlValide, problemes, modifiable: problemes.length === 0 };
}

function problemesDe(a: AnalyseYaml): string[] {
  const p: string[] = [];
  if (a.erreurs.length) p.push(`YAML invalide : ${a.erreurs[0].split("\n")[0].slice(0, 200)}`);
  if (a.racine === "autre") p.push("l'en-tête YAML n'est pas une liste de propriétés (table)");
  for (const k of a.doublons) p.push(`propriété en double : ${k.slice(0, 64)}`);
  for (const i of a.interdits) p.push(`syntaxe YAML non prise en charge : ${i}`);
  return p;
}

// ---------------------------------------------------------------------------------------------
// Écriture
// ---------------------------------------------------------------------------------------------

/** Clés acceptées : lettres (accents compris), chiffres, « _ », « - », espaces et points intérieurs ; 64 caractères au plus. */
const RE_CLE = /^[\p{L}_][\p{L}\p{N}_ .-]{0,63}$/u;
const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_DATE_HEURE = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d)(?:\.\d{1,9})?)?(Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

/** Date du calendrier valide (AAAA-MM-JJ) ? */
export function dateValide(s: string): boolean {
  const m = RE_DATE.exec(s);
  if (!m) return false;
  const a = Number(m[1]), mo = Number(m[2]), j = Number(m[3]);
  if (mo < 1 || mo > 12 || j < 1) return false;
  const jours = [31, (a % 4 === 0 && a % 100 !== 0) || a % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return j <= jours[mo - 1];
}

/** Date (AAAA-MM-JJ) ou date-heure ISO AVEC fuseau (Z ou ±HH:MM), valide. */
export function dateOuDateHeureValide(s: string): boolean {
  if (dateValide(s)) return true;
  const m = RE_DATE_HEURE.exec(s);
  return m !== null && dateValide(`${m[1]}-${m[2]}-${m[3]}`);
}

function verifierValeur(cle: string, valeur: ValeurPropriete | undefined, type: TypePropriete | undefined): void {
  if (valeur === undefined || valeur === null) return;
  const invalide = (msg: string) => new ErreurFormat(`Valeur refusée pour « ${cle.slice(0, 64)} » : ${msg}.`, "valeur_invalide");
  if (Array.isArray(valeur)) {
    if (valeur.length > 500) throw invalide("liste trop longue (500 éléments au plus)");
    for (const x of valeur) if (typeof x !== "string") throw invalide("une liste ne contient que du texte");
    if (type && type !== "liste") throw invalide(`une liste n'est pas du type « ${type} »`);
    return;
  }
  if (typeof valeur === "number") {
    if (!Number.isFinite(valeur)) throw invalide("nombre non fini");
    if (type && type !== "nombre") throw invalide(`un nombre n'est pas du type « ${type} »`);
    return;
  }
  if (typeof valeur === "boolean") {
    if (type && type !== "case") throw invalide(`une case à cocher n'est pas du type « ${type} »`);
    return;
  }
  if (typeof valeur !== "string") throw invalide("type non pris en charge (texte, nombre, case, null ou liste de textes)");
  if (valeur.length > 10_000) throw invalide("texte trop long (10 000 caractères au plus)");
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\ufffe\uffff]/.test(valeur)) throw invalide("caractère de contrôle");
  if (type === "date" && !dateOuDateHeureValide(valeur)) throw invalide("date invalide (AAAA-MM-JJ, ou date-heure ISO avec fuseau)");
  if (type === "nombre" || type === "case" || type === "liste") throw invalide(`du texte n'est pas du type « ${type} »`);
}

/** Texte sûr sans guillemets (YAML 1.2 core ET lecteurs YAML 1.1 : yes/no/on/off restent cités). */
function nuSur(s: string, flux: boolean, type: TypePropriete | undefined): boolean {
  if (s === "" || s !== s.trim() || /[\u0000-\u001f\u007f\u0085\u00a0\u2028\u2029\ufeff]/.test(s)) return false;
  if (/^[-?:,[\]{}#&*!|>'"%@`]/.test(s)) return false;
  if (/:\s|:$|\s#/.test(s)) return false;
  if (flux && /[,[\]{}]/.test(s)) return false;
  if (/^(true|false|yes|no|on|off|y|n|null|~)$/i.test(s)) return false;
  if (/^[-+.]?\d/.test(s) || /^\.(inf|nan)$/i.test(s)) {
    // dates : écrites sans guillemets (convention Obsidian), sauf si le type déclaré est « texte »
    return type !== "texte" && dateOuDateHeureValide(s);
  }
  return true;
}

function cite(s: string): string {
  return JSON.stringify(s);
}

function scalaire(s: string, flux: boolean, type: TypePropriete | undefined, forcerCite: boolean): string {
  return !forcerCite && nuSur(s, flux, type) ? s : cite(s);
}

/** Bloc littéral `|` pour un texte multiligne (null si non représentable proprement : on citera). */
function blocLitteral(s: string, retrait: string, nl: string): string | null {
  if (!s.includes("\n") || s.includes("\r")) return null;
  let fin = 0;
  while (fin < s.length && s[s.length - 1 - fin] === "\n") fin++;
  const corps = s.slice(0, s.length - fin);
  if (corps === "") return null;
  const lignes = corps.split("\n");
  if (/^[ \t]/.test(lignes[0])) return null;
  for (const l of lignes) if (l !== "" && l.trim() === "") return null;
  const indicateur = fin === 0 ? "|-" : fin === 1 ? "|" : "|+";
  const sortie = [indicateur, ...lignes.map((l) => (l === "" ? "" : retrait + l))];
  for (let k = 1; k < fin; k++) sortie.push("");
  return sortie.join(nl);
}

interface Rendu {
  /** Texte après « cle: » : en ligne (précédé d'une espace) ou bloc (commence par un saut de ligne). */
  enLigne: string | null;
  bloc: string | null;
}

function rendre(valeur: ValeurPropriete, o: { colonneCle: number; colonneListe: number | null; flux: boolean; type: TypePropriete | undefined; nl: string; forcerCite: boolean }): Rendu {
  if (valeur === null) return { enLigne: "null", bloc: null };
  if (typeof valeur === "boolean") return { enLigne: valeur ? "true" : "false", bloc: null };
  if (typeof valeur === "number") return { enLigne: String(valeur), bloc: null };
  if (Array.isArray(valeur)) {
    if (!valeur.length) return { enLigne: "[]", bloc: null };
    if (o.flux) return { enLigne: "[" + valeur.map((x) => scalaire(x, true, "texte", o.forcerCite)).join(", ") + "]", bloc: null };
    const col = o.colonneListe ?? o.colonneCle + 2;
    const r = " ".repeat(col);
    return { enLigne: null, bloc: valeur.map((x) => `${r}- ${scalaire(x, false, "texte", o.forcerCite || x.includes("\n"))}`).join(o.nl) };
  }
  if (valeur.includes("\n") && !o.forcerCite) {
    const b = blocLitteral(valeur, " ".repeat(o.colonneCle + 2), o.nl);
    if (b !== null) return { enLigne: b, bloc: null };
  }
  return { enLigne: scalaire(valeur, false, o.type, o.forcerCite), bloc: null };
}

function egal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== "object") {
    return typeof a === "number" && typeof b === "number" && Number.isNaN(a) && Number.isNaN(b);
  }
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a)) {
    const bb = b as unknown[];
    return a.length === bb.length && a.every((x, i) => egal(x, bb[i]));
  }
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  return ka.length === kb.length && ka.every((k) => Object.hasOwn(b as object, k) && egal((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

function debutDeLigne(s: string, i: number): number {
  return s.lastIndexOf("\n", i - 1) + 1;
}

/** Fin d'une valeur sans le(s) saut(s) de ligne final(aux) que l'analyseur inclut pour les blocs. */
function finUtile(s: string, debut: number, fin: number): number {
  let f = fin;
  while (f > debut && (s[f - 1] === "\n" || s[f - 1] === "\r")) f--;
  return f;
}

/**
 * Pose (ou retire, valeur `undefined`) la propriété `cle` dans le frontmatter de `contenu` et renvoie le nouveau contenu.
 * Seule la propriété ciblée change ; tout le reste (ordre, commentaires, autres clés, fins de ligne, corps) est conservé
 * à l'octet. Crée le frontmatter s'il n'existe pas. Lève ErreurFormat (422) si le YAML actuel est invalide ou utilise une
 * syntaxe refusée (clés en double, ancres/alias, `<<`, étiquettes `!`), si la clé ciblée porte un objet imbriqué, si la
 * valeur est invalide (nombre non fini, date invalide pour le type date…) ou si le résultat ne se relirait pas à l'identique.
 * `opts.type` : type déclaré (une chaîne `2026-10-12` ou `00123` de type « texte » est écrite entre guillemets).
 */
export function poserPropriete(contenu: string, cle: string, valeur: ValeurPropriete | undefined, opts: { type?: TypePropriete } = {}): string {
  if (typeof cle !== "string" || !RE_CLE.test(cle) || cle !== cle.trim() || cle === "<<") {
    throw new ErreurFormat(`Nom de propriété refusé : ${String(cle).slice(0, 64)}`, "cle_invalide");
  }
  verifierValeur(cle, valeur, opts.type);
  try {
    return poser(contenu, cle, valeur, opts.type, false);
  } catch (e) {
    // un texte écrit sans guillemets qui se relirait autrement : seconde chance, tout entre guillemets
    if (e instanceof ErreurFormat && e.raison === "relecture_differente") return poser(contenu, cle, valeur, opts.type, true);
    throw e;
  }
}

function poser(contenu: string, cle: string, valeur: ValeurPropriete | undefined, type: TypePropriete | undefined, forcerCite: boolean): string {
  const d = decouper(contenu);
  if (!d.frontmatter) {
    if (valeur === undefined) return contenu;
    const nl = contenu.includes("\r\n") ? "\r\n" : "\n";
    const r = rendre(valeur, { colonneCle: 0, colonneListe: null, flux: false, type, nl, forcerCite });
    const yaml = `${cle}:` + (r.bloc !== null ? nl + r.bloc : " " + r.enLigne);
    const bom = contenu.startsWith("\ufeff") ? "\ufeff" : "";
    const fm = `---${nl}${yaml}${nl}---${nl}`;
    const resultat = bom + fm + contenu.slice(bom.length);
    const d2 = decouper(resultat);
    if (d2.frontmatter !== bom + fm) throw new ErreurFormat("Création de l'en-tête impossible sans ambiguïté.", "relecture_differente");
    verifierResultat(null, d2.yaml, cle, valeur);
    return resultat;
  }
  const debutYaml = d.frontmatter.indexOf("\n") + 1;
  const finYaml = debutYaml + d.yaml.length;
  if (contenu.slice(debutYaml, finYaml) !== d.yaml) throw new Error("proprietes : découpage incohérent");
  const nl = d.frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const src = d.yaml;
  const a = analyser(src);
  if (a.erreurs.length) throw new ErreurFormat(`Modification refusée : l'en-tête YAML actuel est invalide (${a.erreurs[0].split("\n")[0].slice(0, 160)}).`, "yaml_invalide");
  if (a.racine === "autre") throw new ErreurFormat("Modification refusée : l'en-tête YAML n'est pas une table de propriétés.", "yaml_invalide");
  if (a.doublons.length) throw new ErreurFormat(`Modification refusée : propriété en double dans l'en-tête (${a.doublons[0].slice(0, 64)}).`, "cle_en_double");
  if (a.interdits.length) throw new ErreurFormat(`Modification refusée : syntaxe YAML non prise en charge (${a.interdits.join(", ")}).`, "syntaxe_refusee");

  const paire = a.paires.find((p) => p.cle === cle);
  let nouveau: string;
  if (!paire) {
    if (valeur === undefined) return contenu;
    const r = rendre(valeur, { colonneCle: 0, colonneListe: null, flux: false, type, nl, forcerCite });
    const ligne = `${cle}:` + (r.bloc !== null ? nl + r.bloc : " " + r.enLigne);
    if (src === "") {
      const suivant = contenu[debutYaml];
      nouveau = ligne + (suivant === "\n" || suivant === "\r" ? "" : nl);
    } else if (src.endsWith("\n")) {
      nouveau = src + ligne + nl;
    } else {
      nouveau = src + nl + ligne;
    }
  } else {
    const debutLigneCle = debutDeLigne(src, paire.debutCle);
    if (src.slice(debutLigneCle, paire.debutCle).trim() !== "") {
      throw new ErreurFormat("Modification refusée : disposition YAML non prise en charge (clé qui ne commence pas sa ligne).", "syntaxe_refusee");
    }
    const v = paire.valeur;
    if (v && (v.genre === "table" || v.genre === "alias")) {
      throw new ErreurFormat(`Modification refusée : « ${cle.slice(0, 64)} » contient un objet imbriqué (non modifiable par Carnet).`, "valeur_imbriquee");
    }
    // deux-points qui suit la clé
    let deuxPoints = paire.finCle;
    while (deuxPoints < src.length && (src[deuxPoints] === " " || src[deuxPoints] === "\t")) deuxPoints++;
    if (src[deuxPoints] !== ":") throw new ErreurFormat("Modification refusée : clé YAML de forme non prise en charge.", "syntaxe_refusee");
    const finValeur = v ? finUtile(src, v.debut, v.fin) : deuxPoints + 1;
    if (valeur === undefined) {
      // retirer les lignes de la paire (commentaire de fin de ligne compris) ; les lignes de commentaire voisines restent
      const finLigne = src.indexOf("\n", Math.max(finValeur, deuxPoints + 1));
      if (finLigne !== -1) nouveau = src.slice(0, debutLigneCle) + src.slice(finLigne + 1);
      else if (debutLigneCle > 0) {
        let debut = debutLigneCle - 1; // le saut de ligne qui précède
        if (debut > 0 && src[debut - 1] === "\r") debut--;
        nouveau = src.slice(0, debut);
      } else nouveau = "";
    } else {
      const colonneCle = paire.debutCle - debutLigneCle;
      const colonneListe = v && v.genre === "liste" && !v.flux ? v.debut - debutDeLigne(src, v.debut) : null;
      const flux = Boolean(v && v.genre === "liste" && v.flux);
      const r = rendre(valeur, { colonneCle, colonneListe, flux, type, nl, forcerCite });
      const memeLigne = v !== null && v.debut < finValeur && src.lastIndexOf("\n", v.debut) < deuxPoints;
      if (r.enLigne !== null && memeLigne && v) {
        // valeur en ligne remplacée par une valeur en ligne : l'espacement après « : » est conservé
        nouveau = src.slice(0, v.debut) + r.enLigne + src.slice(finValeur);
      } else {
        const texte = r.bloc !== null ? nl + r.bloc : " " + r.enLigne;
        nouveau = src.slice(0, deuxPoints + 1) + texte + src.slice(finValeur);
      }
    }
  }
  const resultat = contenu.slice(0, debutYaml) + nouveau + contenu.slice(finYaml);
  const d2 = decouper(resultat);
  if (d2.corps !== d.corps || d2.blocTitre !== d.blocTitre || !d2.frontmatter) {
    throw new ErreurFormat("Modification refusée : elle changerait le découpage de la page.", "relecture_differente");
  }
  verifierResultat(a, d2.yaml, cle, valeur);
  return resultat;
}

/** Réanalyse : YAML valide, autres clés identiques dans le même ordre, valeur ciblée = valeur demandée. */
function verifierResultat(avant: AnalyseYaml | null, yaml: string, cle: string, valeur: ValeurPropriete | undefined): void {
  const b = analyser(yaml);
  if (b.erreurs.length || b.racine === "autre" || b.doublons.length || b.interdits.length) {
    throw new ErreurFormat("Modification refusée : elle rendrait l'en-tête YAML invalide.", "yaml_invalide");
  }
  const autresAvant = (avant?.paires ?? []).map((p) => p.cle).filter((k) => k !== cle);
  const autresApres = b.paires.map((p) => p.cle).filter((k) => k !== cle);
  const differente = () => new ErreurFormat("Modification refusée : le résultat ne se relirait pas à l'identique.", "relecture_differente");
  if (autresAvant.length !== autresApres.length || autresAvant.some((k, i) => k !== autresApres[i])) throw differente();
  for (const k of autresAvant) {
    if (typeof k !== "string" && typeof k !== "number") continue;
    if (!egal(avant!.valeurs[String(k)], b.valeurs[String(k)])) throw differente();
  }
  const presente = b.paires.some((p) => p.cle === cle);
  if (valeur === undefined) {
    if (presente) throw differente();
    return;
  }
  if (!presente || !egal(b.valeurs[cle], valeur)) throw differente();
}
