// Carnet · bases (lot 2 V3) : sous-ensemble documenté d'Obsidian Bases, partagé serveur + interface, sans dépendance.
//
// - Expressions de filtre : GRAMMAIRE FERMÉE (analyseur maison, aucun eval, aucune Function, aucune expression
//   régulière fournie par l'utilisateur). Tout ce qui n'est pas listé dans cette grammaire est une ERREUR visible.
// - Évaluation sur des « entrées » (une page = une entrée) avec une logique à trois valeurs : vrai, faux, ou
//   « indéterminé » quand une propriété est illisible (clé en double, en-tête YAML invalide…). Une page indéterminée
//   n'est jamais rangée au hasard : elle est listée à part (« pages non classées »).
// - Contrat de valeurs (absente ≠ null ≠ vide ; 0 et false sont des valeurs ; casse ; dates et fuseau Europe/Paris ;
//   listes) : voir la section « Évaluation » plus bas. Les commentaires ci-dessous y renvoient.

export const FUSEAU_DEFAUT = "Europe/Paris";

// ================================================================================================
// Valeurs
// ================================================================================================

/** Valeur brute d'une propriété telle que lue dans le frontmatter (YAML 1.2, schéma core). */
export type ValeurBrute = null | string | number | boolean | Array<string | number | boolean | null>;

/** Une propriété lue : valeur exploitable, ou anomalie (clé en double, alias, objet imbriqué…) jamais devinée. */
export type ProprieteLue =
  | { etat: "valeur"; valeur: ValeurBrute; brut?: string }
  | { etat: "anomalie"; raison: string; brut?: string };

/** Une page vue par une base. */
export interface EntreeBase {
  chemin: string;
  titre: string;
  icone: string | null;
  etag: string;
  taille: number;
  /** Dates du fichier (ms depuis l'époque). ctime = changement d'inode (Linux n'a pas de date de création fiable). */
  mtime: number;
  ctime: number;
  /** Étiquettes sans « # » (frontmatter `tags` + étiquettes du corps hors code), casse d'origine. */
  etiquettes: string[];
  /** Propriétés du frontmatter, dans l'ordre du fichier. */
  proprietes: Map<string, ProprieteLue>;
  /** Message si l'en-tête YAML est illisible (alors toute propriété est « indéterminée »). */
  yamlInvalide: string | null;
  /** Raison pour laquelle Carnet refusera de modifier cet en-tête (ancre, alias, clé en double…), sinon null. */
  nonModifiable?: string | null;
}

/** Date d'une base : instant (ms) + précision (jour = minuit dans le fuseau, sinon instant exact). */
export class DateBase {
  ms: number;
  jour: boolean;
  constructor(ms: number, jour: boolean) {
    this.ms = ms;
    this.jour = jour;
  }
}

/** Valeur pendant l'évaluation. `undefined` = propriété absente. */
export type Valeur = undefined | null | string | number | boolean | DateBase | Valeur[];

/** Levée quand le résultat dépend d'une valeur illisible : le résultat n'est ni vrai ni faux. */
export class Indetermine {
  raison: string;
  constructor(raison: string) {
    this.raison = raison;
  }
}

// ------------------------------------------------------------------------------------------------ dates et fuseau

const RE_JOUR = /^(\d{4})-(\d{2})-(\d{2})$/;
const RE_INSTANT = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3})\d*)?)?(Z|[+-]\d{2}:?\d{2})?$/;

function jourValide(a: number, m: number, j: number): boolean {
  if (m < 1 || m > 12 || j < 1) return false;
  const d = new Date(Date.UTC(a, m - 1, j));
  return d.getUTCFullYear() === a && d.getUTCMonth() === m - 1 && d.getUTCDate() === j;
}

const cacheFormats = new Map<string, Intl.DateTimeFormat>();
function formatFuseau(fuseau: string): Intl.DateTimeFormat {
  let f = cacheFormats.get(fuseau);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuseau, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    cacheFormats.set(fuseau, f);
  }
  return f;
}

/** Composantes locales (dans le fuseau) d'un instant. */
export function composantesLocales(ms: number, fuseau = FUSEAU_DEFAUT): { a: number; m: number; j: number; h: number; mi: number; s: number } {
  const p: Record<string, number> = {};
  for (const x of formatFuseau(fuseau).formatToParts(new Date(ms))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return { a: p.year, m: p.month, j: p.day, h: p.hour === 24 ? 0 : p.hour, mi: p.minute, s: p.second };
}

/** Décalage (ms) du fuseau à un instant donné. */
function decalage(ms: number, fuseau: string): number {
  const c = composantesLocales(ms, fuseau);
  return Date.UTC(c.a, c.m - 1, c.j, c.h, c.mi, c.s) - Math.floor(ms / 1000) * 1000;
}

/**
 * Instant d'une heure locale du fuseau, heure d'été comprise (règle « compatible » de Temporal, lot 12) :
 * - heure qui existe deux fois (passage à l'heure d'hiver, 25/10/2026 02:30 à Paris) : la PREMIÈRE (heure d'été) ;
 * - heure qui n'existe pas (passage à l'heure d'été, 29/03/2026 02:30) : décalage d'avant (= 03:30 heure d'été).
 */
export function instantLocal(a: number, m: number, j: number, h = 0, mi = 0, s = 0, msec = 0, fuseau = FUSEAU_DEFAUT): number {
  const naif = Date.UTC(a, m - 1, j, h, mi, s, msec);
  const avant = decalage(naif - 86400000, fuseau);
  const apres = decalage(naif + 86400000, fuseau);
  const candidats = [naif - avant, naif - apres].filter((t) => decalage(t, fuseau) === naif - t);
  if (candidats.length) return Math.min(...candidats);
  return naif - avant;
}

/** Lit une date « AAAA-MM-JJ » (jour, minuit dans le fuseau) ou « AAAA-MM-JJTHH:mm[:ss][Z|±HH:MM] ». null sinon. */
export function lireDate(s: string, fuseau = FUSEAU_DEFAUT): DateBase | null {
  let m = RE_JOUR.exec(s);
  if (m) {
    const a = Number(m[1]), mo = Number(m[2]), j = Number(m[3]);
    if (!jourValide(a, mo, j)) return null;
    return new DateBase(instantLocal(a, mo, j, 0, 0, 0, 0, fuseau), true);
  }
  m = RE_INSTANT.exec(s);
  if (!m) return null;
  const a = Number(m[1]), mo = Number(m[2]), j = Number(m[3]), h = Number(m[4]), mi = Number(m[5]), se = Number(m[6] ?? 0);
  const msec = m[7] ? Number(m[7].padEnd(3, "0")) : 0;
  if (!jourValide(a, mo, j) || h > 23 || mi > 59 || se > 59) return null;
  if (m[8]) {
    let dec = 0;
    if (m[8] !== "Z") {
      const sg = m[8][0] === "-" ? -1 : 1;
      const chiffres = m[8].slice(1).replace(":", "");
      const dh = Number(chiffres.slice(0, 2)), dm = Number(chiffres.slice(2, 4));
      if (dh > 14 || dm > 59) return null;
      dec = sg * (dh * 60 + dm) * 60000;
    }
    return new DateBase(Date.UTC(a, mo - 1, j, h, mi, se, msec) - dec, false);
  }
  return new DateBase(instantLocal(a, mo, j, h, mi, se, msec, fuseau), false);
}

/** « AAAA-MM-JJ » d'un instant dans le fuseau. */
export function jourIso(ms: number, fuseau = FUSEAU_DEFAUT): string {
  const c = composantesLocales(ms, fuseau);
  const z = (n: number, l = 2) => String(n).padStart(l, "0");
  return `${z(c.a, 4)}-${z(c.m)}-${z(c.j)}`;
}

// ================================================================================================
// Expressions : analyse lexicale et syntaxique (grammaire fermée)
// ================================================================================================

export const MAX_EXPRESSION = 2000;
const MAX_JETONS = 400;
const MAX_PROFONDEUR = 24;

export class ErreurExpression extends Error {
  position: number;
  constructor(message: string, position: number) {
    super(message);
    this.position = position;
  }
}

type Jeton =
  | { t: "nombre"; v: number; pos: number }
  | { t: "chaine"; v: string; pos: number }
  | { t: "ident"; v: string; pos: number }
  | { t: "op"; v: string; pos: number }
  | { t: "fin"; pos: number };

// Lot 12 : « + » et « - » sont lus comme opérateurs, mais seule la forme « date ± "durée" » est acceptée (résolution).
const OPERATEURS = ["&&", "||", "==", "!=", "<=", ">=", "<", ">", "!", "(", ")", "[", "]", ".", ",", "+", "-"];
const NON_PRIS: Record<string, string> = {
  "*": "le calcul (*)", "/": "le calcul (/) et les expressions régulières",
  "%": "le calcul (%)", "?": "l'opérateur « ? : »", ":": "l'opérateur « ? : »", "{": "les objets { }", "}": "les objets { }",
  "=": "l'affectation (=) : pour comparer, écris ==", "&": "« & » seul : écris &&", "|": "« | » seul : écris ||", "`": "les gabarits `…`",
  "$": "« $ »", "@": "« @ »", "#": "« # »", ";": "« ; »", "\\": "« \\ »", "~": "« ~ »", "^": "« ^ »",
};
const RE_DEBUT_IDENT = /[\p{L}_]/u;
const RE_SUITE_IDENT = /[\p{L}\p{N}_]/u;

function lexer(src: string): Jeton[] {
  const jetons: Jeton[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
    const pos = i;
    if (c === '"' || c === "'") {
      let v = "";
      i++;
      let ferme = false;
      while (i < n) {
        const d = src[i];
        if (d === c) { ferme = true; i++; break; }
        if (d === "\\") {
          const e = src[i + 1];
          if (e === undefined) break;
          if (e === "n") v += "\n";
          else if (e === "t") v += "\t";
          else if (e === "\\" || e === '"' || e === "'") v += e;
          else throw new ErreurExpression(`Échappement « \\${e} » non pris en charge.`, i);
          i += 2;
          continue;
        }
        v += d;
        i++;
      }
      if (!ferme) throw new ErreurExpression("Texte entre guillemets non fermé.", pos);
      jetons.push({ t: "chaine", v, pos });
    } else if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i))!;
      i += m[0].length;
      if (i < n && RE_SUITE_IDENT.test(src[i])) throw new ErreurExpression(`Nombre mal formé : « ${src.slice(pos, i + 1)} ».`, pos);
      jetons.push({ t: "nombre", v: Number(m[0]), pos });
    } else if (c === "-" && /[0-9]/.test(src[i + 1] ?? "") && (jetons.length === 0 || jetons[jetons.length - 1].t === "op" && !")]".includes((jetons[jetons.length - 1] as { v: string }).v))) {
      // nombre négatif littéral (pas de soustraction)
      const m = /^-[0-9]+(?:\.[0-9]+)?/.exec(src.slice(i))!;
      i += m[0].length;
      jetons.push({ t: "nombre", v: Number(m[0]), pos });
    } else if (RE_DEBUT_IDENT.test(c)) {
      let j = i + 1;
      while (j < n && RE_SUITE_IDENT.test(src[j])) j++;
      jetons.push({ t: "ident", v: src.slice(i, j), pos });
      i = j;
    } else {
      const op = OPERATEURS.find((o) => src.startsWith(o, i));
      if (op) {
        jetons.push({ t: "op", v: op, pos });
        i += op.length;
      } else {
        const quoi = NON_PRIS[c];
        throw new ErreurExpression(quoi ? `Non pris en charge par Carnet : ${quoi}.` : `Caractère inattendu « ${c} ».`, pos);
      }
    }
    if (jetons.length > MAX_JETONS) throw new ErreurExpression("Expression trop longue.", pos);
  }
  jetons.push({ t: "fin", pos: n });
  return jetons;
}

/** Champs de fichier pris en charge (`file.<champ>`). */
export const CHAMPS_FICHIER = ["name", "basename", "path", "folder", "ext", "size", "mtime", "ctime", "tags"] as const;
export type ChampFichier = (typeof CHAMPS_FICHIER)[number];
const CHAMPS_FICHIER_NON_PRIS = ["links", "backlinks", "embeds", "properties", "file", "hasLink", "asLink"];

// Lot 12 : .date() (partie date d'une date avec heure) et .format("motif") (motifs fermés, voir RE_JETON_MOTIF)
const METHODES = ["contains", "containsAll", "containsAny", "startsWith", "endsWith", "isEmpty", "lower", "date", "format"] as const;
type Methode = (typeof METHODES)[number];
const ARITE_METHODES: Record<Methode, [number, number]> = {
  contains: [1, 1], containsAll: [1, 20], containsAny: [1, 20], startsWith: [1, 1], endsWith: [1, 1], isEmpty: [0, 0], lower: [0, 0],
  date: [0, 0], format: [1, 1],
};
const FONCTIONS_FICHIER = { inFolder: [1, 1], hasTag: [1, 20], hasProperty: [1, 1] } as const;
type FonctionFichier = keyof typeof FONCTIONS_FICHIER;
const FONCTIONS_GLOBALES = { date: [1, 1], today: [0, 0], now: [0, 0] } as const;
type FonctionGlobale = keyof typeof FONCTIONS_GLOBALES;

export type Comparateur = "==" | "!=" | "<" | ">" | "<=" | ">=";

export type Noeud =
  | { k: "lit"; v: null | string | number | boolean; pos: number }
  | { k: "note"; nom: string; pos: number }
  | { k: "fichier"; champ: ChampFichier; pos: number }
  | { k: "fnFichier"; fn: FonctionFichier; args: Noeud[]; pos: number }
  | { k: "fnGlobale"; fn: FonctionGlobale; args: Noeud[]; pos: number }
  | { k: "methode"; fn: Methode; cible: Noeud; args: Noeud[]; pos: number }
  | { k: "non"; e: Noeud; pos: number }
  | { k: "et" | "ou"; g: Noeud; d: Noeud; pos: number }
  | { k: "cmp"; op: Comparateur; g: Noeud; d: Noeud; pos: number }
  /** Lot 12 : date ± durée (`today() + "7d"`, `now() - "2w"`, `date("2026-10-01") + "1M"`, `relance + "3d"`). */
  | { k: "decale"; base: Noeud; signe: 1 | -1; duree: Duree; source: string; pos: number };

/** Forme intermédiaire avant résolution des noms (une chaîne d'accès « a.b(…)["c"] »). */
type Brut =
  | { k: "lit"; v: null | string | number | boolean; pos: number }
  | { k: "ident"; nom: string; pos: number }
  | { k: "membre"; cible: Brut; nom: string; pos: number }
  | { k: "index"; cible: Brut; index: Brut; pos: number }
  | { k: "appel"; cible: Brut; args: Brut[]; pos: number }
  | { k: "non"; e: Brut; pos: number }
  | { k: "et" | "ou"; g: Brut; d: Brut; pos: number }
  | { k: "cmp"; op: Comparateur; g: Brut; d: Brut; pos: number }
  | { k: "arith"; op: "+" | "-"; g: Brut; d: Brut; pos: number };

class Analyseur {
  j: Jeton[];
  i = 0;
  prof = 0;
  constructor(j: Jeton[]) {
    this.j = j;
  }
  get cour(): Jeton { return this.j[this.i]; }
  estOp(v: string): boolean { const c = this.cour; return c.t === "op" && c.v === v; }
  attendre(v: string): void {
    if (!this.estOp(v)) throw new ErreurExpression(`« ${v} » attendu ici.`, this.cour.pos);
    this.i++;
  }
  entrer(pos: number): void {
    if (++this.prof > MAX_PROFONDEUR) throw new ErreurExpression("Expression trop imbriquée.", pos);
  }
  ou(): Brut {
    this.entrer(this.cour.pos);
    let g = this.et();
    while (this.estOp("||")) { const pos = this.cour.pos; this.i++; g = { k: "ou", g, d: this.et(), pos }; }
    this.prof--;
    return g;
  }
  et(): Brut {
    let g = this.non();
    while (this.estOp("&&")) { const pos = this.cour.pos; this.i++; g = { k: "et", g, d: this.non(), pos }; }
    return g;
  }
  non(): Brut {
    if (this.estOp("!")) {
      const pos = this.cour.pos;
      this.i++;
      this.entrer(pos);
      const e = this.non();
      this.prof--;
      return { k: "non", e, pos };
    }
    return this.comparaison();
  }
  comparaison(): Brut {
    const g = this.additif();
    const c = this.cour;
    if (c.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(c.v)) {
      this.i++;
      const d = this.additif();
      const c2 = this.cour;
      if (c2.t === "op" && ["==", "!=", "<", ">", "<=", ">="].includes(c2.v)) {
        throw new ErreurExpression("Comparaisons enchaînées non prises en charge : sépare-les par && .", c2.pos);
      }
      return { k: "cmp", op: c.v as Comparateur, g, d, pos: c.pos };
    }
    return g;
  }
  /** Lot 12 : « a + b - c » (associatif à gauche). Seul « date ± "durée" » survit à la résolution. */
  additif(): Brut {
    let g = this.postfixe();
    while (this.estOp("+") || this.estOp("-")) {
      const c = this.cour as { v: string; pos: number };
      this.i++;
      g = { k: "arith", op: c.v as "+" | "-", g, d: this.postfixe(), pos: c.pos };
    }
    return g;
  }
  postfixe(): Brut {
    let e = this.primaire();
    for (;;) {
      if (this.estOp(".")) {
        const pos = this.cour.pos;
        this.i++;
        const c = this.cour;
        if (c.t !== "ident") throw new ErreurExpression("Nom attendu après « . ».", c.pos);
        this.i++;
        e = { k: "membre", cible: e, nom: c.v, pos };
      } else if (this.estOp("(")) {
        const pos = this.cour.pos;
        this.i++;
        const args: Brut[] = [];
        if (!this.estOp(")")) {
          for (;;) {
            args.push(this.ou());
            if (this.estOp(",")) { this.i++; continue; }
            break;
          }
        }
        this.attendre(")");
        e = { k: "appel", cible: e, args, pos };
      } else if (this.estOp("[")) {
        const pos = this.cour.pos;
        this.i++;
        const index = this.ou();
        this.attendre("]");
        e = { k: "index", cible: e, index, pos };
      } else break;
    }
    return e;
  }
  primaire(): Brut {
    const c = this.cour;
    if (c.t === "nombre") { this.i++; return { k: "lit", v: c.v, pos: c.pos }; }
    if (c.t === "chaine") { this.i++; return { k: "lit", v: c.v, pos: c.pos }; }
    if (c.t === "ident") {
      this.i++;
      if (c.v === "true") return { k: "lit", v: true, pos: c.pos };
      if (c.v === "false") return { k: "lit", v: false, pos: c.pos };
      if (c.v === "null") return { k: "lit", v: null, pos: c.pos };
      return { k: "ident", nom: c.v, pos: c.pos };
    }
    if (this.estOp("(")) {
      this.i++;
      const e = this.ou();
      this.attendre(")");
      return e;
    }
    if (this.estOp("[")) throw new ErreurExpression("Les listes littérales [ … ] ne sont pas prises en charge.", c.pos);
    if (c.t === "fin") throw new ErreurExpression("Expression incomplète.", c.pos);
    throw new ErreurExpression(`« ${c.t === "op" ? c.v : "?"} » inattendu ici.`, c.pos);
  }
}

/** Résout les noms : propriétés de note, champs et fonctions de fichier, méthodes et fonctions autorisées. */
function resoudre(b: Brut): Noeud {
  switch (b.k) {
    case "lit": return b;
    case "non": return { k: "non", e: resoudre(b.e), pos: b.pos };
    case "et": case "ou": return { k: b.k, g: resoudre(b.g), d: resoudre(b.d), pos: b.pos };
    case "cmp": return { k: "cmp", op: b.op, g: resoudre(b.g), d: resoudre(b.d), pos: b.pos };
    case "arith": return resoudreDecalage(b);
    case "ident": {
      if (b.nom === "file") throw new ErreurExpression("« file » seul n'est pas une valeur : utilise file.name, file.inFolder(\"…\")…", b.pos);
      if (b.nom === "note") throw new ErreurExpression("« note » seul n'est pas une valeur : utilise note.nom ou note[\"nom\"].", b.pos);
      if (b.nom === "this") throw new ErreurExpression("« this » n'est pas pris en charge par Carnet.", b.pos);
      if (b.nom === "formula") throw new ErreurExpression("Les formules ne sont pas prises en charge par Carnet.", b.pos);
      return { k: "note", nom: b.nom, pos: b.pos };
    }
    case "membre": {
      const c = b.cible;
      const r = racineDe(b);
      if (r.k === "ident" && (r.nom === "this" || r.nom === "formula") && r !== c) return resoudre(r);
      if (c.k === "ident" && c.nom === "note") return { k: "note", nom: b.nom, pos: b.pos };
      if (c.k === "ident" && c.nom === "file") {
        if ((CHAMPS_FICHIER as readonly string[]).includes(b.nom)) return { k: "fichier", champ: b.nom as ChampFichier, pos: b.pos };
        if (b.nom in FONCTIONS_FICHIER) throw new ErreurExpression(`file.${b.nom} s'appelle avec des parenthèses : file.${b.nom}(…).`, b.pos);
        if (CHAMPS_FICHIER_NON_PRIS.includes(b.nom)) throw new ErreurExpression(`file.${b.nom} n'est pas pris en charge par Carnet.`, b.pos);
        throw new ErreurExpression(`Champ de fichier inconnu : file.${b.nom}.`, b.pos);
      }
      if (c.k === "ident" && (c.nom === "this" || c.nom === "formula")) return resoudre(c);
      throw new ErreurExpression(`Accès « .${b.nom} » non pris en charge (seules des méthodes comme .contains(…) le sont).`, b.pos);
    }
    case "index": {
      const c = b.cible;
      if (c.k === "ident" && c.nom === "note" && b.index.k === "lit" && typeof b.index.v === "string") return { k: "note", nom: b.index.v, pos: b.pos };
      if (c.k === "ident" && c.nom === "note") throw new ErreurExpression("note[…] attend un nom entre guillemets.", b.pos);
      throw new ErreurExpression("L'accès par crochets [ … ] n'est pris en charge que pour note[\"nom\"].", b.pos);
    }
    case "appel": {
      const c = b.cible;
      if (c.k === "ident") {
        if (c.nom in FONCTIONS_GLOBALES) {
          const fn = c.nom as FonctionGlobale;
          const [min, max] = FONCTIONS_GLOBALES[fn];
          verifierArite(fn, b.args.length, min, max, b.pos);
          const args = b.args.map(resoudre);
          if (fn === "date" && args[0].k === "lit") {
            if (typeof args[0].v !== "string" || !lireDate(args[0].v)) {
              throw new ErreurExpression(`date(…) attend « AAAA-MM-JJ » ou « AAAA-MM-JJ HH:mm:ss » valide.`, args[0].pos);
            }
          }
          return { k: "fnGlobale", fn, args, pos: b.pos };
        }
        throw new ErreurExpression(`Fonction non prise en charge par Carnet : ${c.nom}(…).`, c.pos);
      }
      if (c.k === "membre") {
        const t = c.cible;
        if (t.k === "ident" && t.nom === "file") {
          if (c.nom in FONCTIONS_FICHIER) {
            const fn = c.nom as FonctionFichier;
            const [min, max] = FONCTIONS_FICHIER[fn];
            verifierArite(`file.${fn}`, b.args.length, min, max, b.pos);
            return { k: "fnFichier", fn, args: b.args.map(resoudre), pos: b.pos };
          }
          throw new ErreurExpression(`Fonction de fichier non prise en charge par Carnet : file.${c.nom}(…).`, c.pos);
        }
        if ((METHODES as readonly string[]).includes(c.nom)) {
          const fn = c.nom as Methode;
          const [min, max] = ARITE_METHODES[fn];
          verifierArite(`.${fn}`, b.args.length, min, max, b.pos);
          const args = b.args.map(resoudre);
          if (fn === "format") {
            const a = args[0];
            if (a.k !== "lit" || typeof a.v !== "string") throw new ErreurExpression(".format(…) attend un motif entre guillemets, ex. .format(\"GGGG-WW\").", a.pos);
            const m = verifierMotif(a.v);
            if (m !== null) throw new ErreurExpression(m, a.pos + 1 + Math.max(0, a.v.indexOf(motifFautif(a.v))));
          }
          return { k: "methode", fn, cible: resoudre(t), args, pos: b.pos };
        }
        throw new ErreurExpression(`Méthode non prise en charge par Carnet : .${c.nom}(…).`, c.pos);
      }
      throw new ErreurExpression("Appel non pris en charge.", b.pos);
    }
  }
}

// ------------------------------------------------------------------------------------------------ lot 12 : durées

/** Unités d'Obsidian Bases (doc « Bases syntax », § Date arithmetic) : forme courte (casse comprise : M = mois, m = minute) ou longue. */
export type UniteDuree = "y" | "M" | "w" | "d" | "h" | "m" | "s";
export interface Duree { n: number; unite: UniteDuree }
const UNITES_LONGUES: Record<string, UniteDuree> = {
  year: "y", years: "y", month: "M", months: "M", week: "w", weeks: "w", day: "d", days: "d",
  hour: "h", hours: "h", minute: "m", minutes: "m", second: "s", seconds: "s",
};
const MAX_DUREE: Record<UniteDuree, number> = { y: 1000, M: 12000, w: 52000, d: 366000, h: 8784000, m: 527040000, s: 999999999 };
export const LIBELLES_UNITES = "y (années), M (mois), w (semaines), d (jours), h (heures), m (minutes), s (secondes)";

/**
 * Lit une durée Obsidian : un entier positif puis une unité, avec ou sans espace (« 7d », « 7 d », « 2 weeks », « 1M »).
 * Une seule unité par durée (« 1M4h » est refusé : écris + "1M" + "4h", comme la doc d'Obsidian). null si invalide.
 */
export function lireDuree(s: string): Duree | null {
  const r = analyserDuree(s);
  return "duree" in r ? r.duree : null;
}

/**
 * Lot 12 : trois refus distincts. « mal_formee » (pas « entier + unité » : "abc", "-7d", "1.5d",
 * "1M4h", "d"), « unite_inconnue » ("7x", "7 jours", "7D"), « trop_grande » (au-delà de 1 000 ans). `decalage` =
 * position, dans la chaîne, de l'endroit fautif (l'unité inconnue ; 0 sinon).
 */
export function analyserDuree(s: string): { duree: Duree } | { genre: "mal_formee" | "unite_inconnue" | "trop_grande"; message: string; decalage: number } {
  const m = /^(\s*)([0-9]{1,9})(\s*)([A-Za-z]+)\s*$/.exec(s);
  if (!m) {
    return {
      genre: "mal_formee", decalage: 0,
      message: `Durée mal formée "${s}" : attendu un nombre entier positif suivi d'UNE unité, ex. "7d", "2w", "1M", "3 days" (pour combiner : + "1M" + "4h").`,
    };
  }
  const n = Number(m[2]);
  const u = m[4];
  const unite: UniteDuree | undefined = u.length === 1 ? (["y", "M", "w", "d", "h", "m", "s"].includes(u) ? u as UniteDuree : undefined) : UNITES_LONGUES[u.toLowerCase()];
  if (!unite) {
    return {
      genre: "unite_inconnue", decalage: m[1].length + m[2].length + m[3].length,
      message: `Unité de durée inconnue « ${u} » dans "${s}" : unités ${LIBELLES_UNITES}, ou leurs noms anglais (days, weeks, months…).`,
    };
  }
  if (n > MAX_DUREE[unite]) return { genre: "trop_grande", decalage: 0, message: `Durée trop grande "${s}" : 1 000 ans au plus.` };
  return { duree: { n, unite } };
}

function resoudreDecalage(b: Extract<Brut, { k: "arith" }>): Noeud {
  const base = resoudre(b.g);
  const ok = base.k === "decale" || base.k === "note" || (base.k === "fnGlobale") || (base.k === "fichier" && (base.champ === "mtime" || base.champ === "ctime"))
    || (base.k === "methode" && base.fn === "date");
  if (!ok) {
    throw new ErreurExpression(`Non pris en charge par Carnet : le calcul (${b.op}). Seule une durée peut s'ajouter à une date ou s'en retrancher (ex. today() ${b.op} "7d").`, b.pos);
  }
  const d = b.d;
  if (d.k !== "lit" || typeof d.v !== "string") {
    throw new ErreurExpression(`Non pris en charge par Carnet : le calcul (${b.op}) entre deux valeurs. Après « ${b.op} », écris une durée entre guillemets (ex. "7d", "2w", "1M").`, d.pos);
  }
  const r = analyserDuree(d.v);
  if (!("duree" in r)) throw new ErreurExpression(r.message, d.pos + (r.decalage ? 1 + r.decalage : 0));
  const duree = r.duree;
  return { k: "decale", base, signe: b.op === "+" ? 1 : -1, duree, source: d.v, pos: b.pos };
}

/** Motifs de .format() pris en charge : jetons Moment.js YYYY, GGGG, MM, DD, WW, HH, mm et séparateurs - / . : espace, [W]. */
const RE_JETON_MOTIF = /^(YYYY|GGGG|MM|DD|WW|HH|mm|\[W\]|[-/.: ])/;
function motifFautif(motif: string): string {
  let i = 0;
  while (i < motif.length) {
    const m = RE_JETON_MOTIF.exec(motif.slice(i));
    if (!m) return motif.slice(i);
    i += m[0].length;
  }
  return "";
}
function verifierMotif(motif: string): string | null {
  if (!motif || motif.length > 40) return "Motif de .format(…) vide ou trop long.";
  const f = motifFautif(motif);
  return f ? `Motif de .format(…) non pris en charge à partir de « ${f} » : jetons acceptés YYYY, GGGG, MM, DD, WW, HH, mm (et - / . : espace [W]).` : null;
}

/** Semaine ISO 8601 (année de la semaine, numéro) d'un jour civil. */
function semaineIso(a: number, m: number, j: number): { a: number; s: number } {
  const t = new Date(Date.UTC(a, m - 1, j));
  const js = (t.getUTCDay() + 6) % 7; // lundi = 0
  t.setUTCDate(t.getUTCDate() - js + 3); // jeudi de la semaine
  const an = t.getUTCFullYear();
  return { a: an, s: 1 + Math.floor((t.getTime() - Date.UTC(an, 0, 1)) / 86400000 / 7) };
}

/** Formate une date (dans le fuseau) selon un motif déjà vérifié. */
export function formaterDate(d: DateBase, motif: string, fuseau: string): string {
  const c = composantesLocales(d.ms, fuseau);
  const z = (n: number, l = 2) => String(n).padStart(l, "0");
  let out = "";
  let i = 0;
  while (i < motif.length) {
    const m = RE_JETON_MOTIF.exec(motif.slice(i))!;
    const t = m[0];
    i += t.length;
    switch (t) {
      case "YYYY": out += z(c.a, 4); break;
      case "GGGG": out += z(semaineIso(c.a, c.m, c.j).a, 4); break;
      case "MM": out += z(c.m); break;
      case "DD": out += z(c.j); break;
      case "WW": out += z(semaineIso(c.a, c.m, c.j).s); break;
      case "HH": out += z(c.h); break;
      case "mm": out += z(c.mi); break;
      case "[W]": out += "W"; break;
      default: out += t;
    }
  }
  return out;
}

function joursDansMois(a: number, m: number): number {
  return new Date(Date.UTC(a, m, 0)).getUTCDate();
}

/**
 * Ajoute (signe 1) ou retranche (-1) une durée à une date, dans le fuseau :
 * - y, M, w, d : calcul CALENDAIRE (l'heure locale est gardée : today() + "1d" = minuit du lendemain, même un jour de
 *   changement d'heure, qui dure 23 ou 25 h). Mois et années : jour ramené au dernier jour du mois s'il n'existe pas
 *   (31/01 + 1M = 28/02 ou 29/02 ; 29/02 + 1y = 28/02), comme Moment.js.
 * - h, m, s : durée EXACTE (now() + "24h" = 24 h plus tard, même un jour de changement d'heure).
 * Une date « jour » (minuit) le reste avec y, M, w, d ; avec h, m, s elle devient un instant.
 */
export function decalerDate(d: DateBase, duree: Duree, signe: 1 | -1, fuseau: string): DateBase {
  const n = duree.n * signe;
  if (duree.unite === "h" || duree.unite === "m" || duree.unite === "s") {
    const ms = duree.unite === "h" ? 3600000 : duree.unite === "m" ? 60000 : 1000;
    return new DateBase(d.ms + n * ms, false);
  }
  const c = composantesLocales(d.ms, fuseau);
  const reste = ((d.ms % 1000) + 1000) % 1000;
  let a = c.a, m = c.m, j = c.j;
  if (duree.unite === "y" || duree.unite === "M") {
    const mois = (a * 12 + (m - 1)) + (duree.unite === "y" ? n * 12 : n);
    a = Math.floor(mois / 12);
    m = mois - a * 12 + 1;
    j = Math.min(j, joursDansMois(a, m));
  } else {
    const t = new Date(Date.UTC(a, m - 1, j + (duree.unite === "w" ? 7 * n : n)));
    a = t.getUTCFullYear(); m = t.getUTCMonth() + 1; j = t.getUTCDate();
  }
  return new DateBase(instantLocal(a, m, j, c.h, c.mi, c.s, reste, fuseau), d.jour);
}

function racineDe(b: Brut): Brut {
  let x = b;
  while (x.k === "membre" || x.k === "index" || x.k === "appel") x = x.cible;
  return x;
}

function verifierArite(nom: string, n: number, min: number, max: number, pos: number): void {
  if (n < min || n > max) {
    const attendu = min === max ? `${min}` : `${min} à ${max}`;
    throw new ErreurExpression(`${nom} attend ${attendu} argument${max > 1 ? "s" : ""}, ${n} reçu${n > 1 ? "s" : ""}.`, pos);
  }
}

/** Analyse une expression (filtre). Lève ErreurExpression (message en français + position) si elle sort du sous-ensemble. */
export function analyserExpression(src: string): Noeud {
  if (typeof src !== "string") throw new ErreurExpression("Expression attendue (texte).", 0);
  if (src.length > MAX_EXPRESSION) throw new ErreurExpression("Expression trop longue.", MAX_EXPRESSION);
  if (!src.trim()) throw new ErreurExpression("Expression vide.", 0);
  const a = new Analyseur(lexer(src));
  const b = a.ou();
  if (a.cour.t !== "fin") throw new ErreurExpression(`Suite inattendue à partir de la position ${a.cour.pos + 1}.`, a.cour.pos);
  return resoudre(b);
}

/** Propriétés de note citées par une expression (pour l'interface et les colonnes). */
export function proprietesCitees(n: Noeud, acc = new Set<string>()): Set<string> {
  switch (n.k) {
    case "note": acc.add(n.nom); break;
    case "fnFichier": case "fnGlobale": n.args.forEach((a) => proprietesCitees(a, acc)); break;
    case "methode": proprietesCitees(n.cible, acc); n.args.forEach((a) => proprietesCitees(a, acc)); break;
    case "non": proprietesCitees(n.e, acc); break;
    case "et": case "ou": case "cmp": proprietesCitees(n.g, acc); proprietesCitees(n.d, acc); break;
    case "decale": proprietesCitees(n.base, acc); break;
  }
  return acc;
}

// ================================================================================================
// Évaluation (contrat de valeurs)
// ================================================================================================

export interface ContexteEvaluation {
  maintenant: number;
  fuseau: string;
  /**
   * Lot 12 : appelé quand une comparaison de DATES rencontre une propriété vide (absente, null, "") ou qui n'est pas
   * une date (« bientôt ») : la comparaison est fausse (contrat du lot 2), mais l'appelant peut le DIRE.
   */
  signaler?: (cle: string, nature: "vide" | "pas-une-date", valeur: string) => void;
}

/** La comparaison porte-t-elle sur des dates (today(), now(), date(…), durée, .date(), .format()) ? */
function estDeDate(n: Noeud): boolean {
  switch (n.k) {
    case "fnGlobale": case "decale": return true;
    case "methode": return n.fn === "date" || n.fn === "format" || estDeDate(n.cible);
    default: return false;
  }
}

/** Propriété de note au cœur d'un côté de comparaison (« relance », « relance.date() », « relance + "1d" »). */
function proprieteDe(n: Noeud): string | null {
  if (n.k === "note") return n.nom;
  if (n.k === "methode" && (n.fn === "date" || n.fn === "format")) return proprieteDe(n.cible);
  if (n.k === "decale") return proprieteDe(n.base);
  return null;
}

function signalerDates(n: Extract<Noeud, { k: "cmp" }>, e: EntreeBase, ctx: ContexteEvaluation): void {
  if (!ctx.signaler || !(estDeDate(n.g) || estDeDate(n.d))) return;
  for (const cote of [n.g, n.d]) {
    const cle = proprieteDe(cote);
    if (cle === null) continue;
    let v: Valeur;
    try { v = valeurNote(e, cle); } catch { continue; } // illisible : déjà « non classée »
    if (v === undefined || v === null || v === "") ctx.signaler(cle, "vide", "");
    else if (!enDate(v, ctx.fuseau)) ctx.signaler(cle, "pas-une-date", Array.isArray(v) ? v.join(", ") : String(v));
  }
}

function valeurDeBrute(v: ValeurBrute): Valeur {
  if (Array.isArray(v)) return v.map((x) => x as Valeur);
  return v;
}

/** Valeur d'une propriété de note : undefined si absente ; Indetermine si illisible. */
export function valeurNote(e: EntreeBase, nom: string): Valeur {
  if (e.yamlInvalide) throw new Indetermine(`en-tête YAML illisible (${e.yamlInvalide})`);
  const p = e.proprietes.get(nom);
  if (!p) return undefined;
  if (p.etat === "anomalie") throw new Indetermine(`propriété « ${nom} » : ${p.raison}`);
  return valeurDeBrute(p.valeur);
}

export function dossierDeChemin(chemin: string): string {
  const i = chemin.lastIndexOf("/");
  return i === -1 ? "" : chemin.slice(0, i);
}

export function valeurFichier(e: EntreeBase, champ: ChampFichier): Valeur {
  const nom = e.chemin.slice(e.chemin.lastIndexOf("/") + 1);
  switch (champ) {
    case "name": return nom;
    case "basename": return nom.replace(/\.md$/i, "");
    case "path": return e.chemin;
    case "folder": return dossierDeChemin(e.chemin);
    case "ext": { const i = nom.lastIndexOf("."); return i === -1 ? "" : nom.slice(i + 1); }
    case "size": return e.taille;
    case "mtime": return new DateBase(e.mtime, false);
    case "ctime": return new DateBase(e.ctime, false);
    case "tags": return [...e.etiquettes];
  }
}

function enDate(v: Valeur, fuseau: string): DateBase | null {
  if (v instanceof DateBase) return v;
  if (typeof v === "string") return lireDate(v, fuseau);
  return null;
}

/** Égalité stricte (pas de conversion entre types), sauf date ↔ texte de date. Absente et null valent null. */
export function egal(a: Valeur, b: Valeur, fuseau: string): boolean {
  const na = a === undefined || a === null;
  const nb = b === undefined || b === null;
  if (na || nb) return na && nb;
  if (a instanceof DateBase || b instanceof DateBase) {
    const da = enDate(a, fuseau), db = enDate(b, fuseau);
    return da !== null && db !== null && da.ms === db.ms;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((x, i) => egal(x, b[i], fuseau));
  }
  return typeof a === typeof b && a === b;
}

/** Ordre pour < > <= >= : nombres, dates (texte de date compris), textes (points de code), booléens. Sinon null (faux). */
function ordre(a: Valeur, b: Valeur, fuseau: string): number | null {
  if (a === undefined || a === null || b === undefined || b === null) return null;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (a instanceof DateBase || b instanceof DateBase) {
    const da = enDate(a, fuseau), db = enDate(b, fuseau);
    return da && db ? da.ms - db.ms : null;
  }
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return null;
}

/** Vérité d'une valeur (règles de JavaScript, comme Obsidian) : absente, null, "", 0, false = faux ; liste = vrai. */
export function vrai(v: Valeur): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v !== "";
  if (typeof v === "number") return v !== 0 && !Number.isNaN(v);
  if (typeof v === "boolean") return v;
  return true;
}

function texteDe(v: Valeur): string | null {
  return typeof v === "string" ? v : null;
}

function plierEtiquette(t: string): string {
  return t.replace(/^#/, "").toLowerCase();
}

/** Évalue un nœud. Lève Indetermine si le résultat dépend d'une valeur illisible. */
export function evaluer(n: Noeud, e: EntreeBase, ctx: ContexteEvaluation): Valeur {
  switch (n.k) {
    case "lit": return n.v;
    case "note": return valeurNote(e, n.nom);
    case "fichier": return valeurFichier(e, n.champ);
    case "non": return !vrai(evaluer(n.e, e, ctx));
    case "et": case "ou": {
      // logique à trois valeurs : un côté qui décide suffit, même si l'autre est indéterminé
      let g: boolean | Indetermine;
      try { g = vrai(evaluer(n.g, e, ctx)); } catch (x) { if (x instanceof Indetermine) g = x; else throw x; }
      if (n.k === "et" && g === false) return false;
      if (n.k === "ou" && g === true) return true;
      let d: boolean | Indetermine;
      try { d = vrai(evaluer(n.d, e, ctx)); } catch (x) { if (x instanceof Indetermine) d = x; else throw x; }
      if (n.k === "et" && d === false) return false;
      if (n.k === "ou" && d === true) return true;
      if (g instanceof Indetermine) throw g;
      if (d instanceof Indetermine) throw d;
      return n.k === "et";
    }
    case "cmp": {
      const a = evaluer(n.g, e, ctx);
      const b = evaluer(n.d, e, ctx);
      signalerDates(n, e, ctx);
      switch (n.op) {
        case "==": return egal(a, b, ctx.fuseau);
        case "!=": return !egal(a, b, ctx.fuseau);
        default: {
          const o = ordre(a, b, ctx.fuseau);
          if (o === null) return false;
          return n.op === "<" ? o < 0 : n.op === ">" ? o > 0 : n.op === "<=" ? o <= 0 : o >= 0;
        }
      }
    }
    case "fnGlobale": {
      if (n.fn === "today") {
        const c = composantesLocales(ctx.maintenant, ctx.fuseau);
        return new DateBase(instantLocal(c.a, c.m, c.j, 0, 0, 0, 0, ctx.fuseau), true);
      }
      if (n.fn === "now") return new DateBase(ctx.maintenant, false);
      const s = evaluer(n.args[0], e, ctx);
      if (s instanceof DateBase) return s;
      return typeof s === "string" ? (lireDate(s, ctx.fuseau) ?? null) : null;
    }
    case "decale": {
      // lot 12 : une base qui n'est pas une date (absente, null, texte quelconque) donne null (comparaisons fausses)
      const b = enDate(evaluer(n.base, e, ctx), ctx.fuseau);
      return b ? decalerDate(b, n.duree, n.signe, ctx.fuseau) : null;
    }
    case "fnFichier": {
      const args = n.args.map((a) => evaluer(a, e, ctx));
      if (n.fn === "inFolder") {
        const d = texteDe(args[0]);
        if (d === null) return false;
        const cible = d.replace(/^\/+|\/+$/g, "");
        const dossier = dossierDeChemin(e.chemin);
        return cible === "" || dossier === cible || dossier.startsWith(cible + "/");
      }
      if (n.fn === "hasTag") {
        const miennes = e.etiquettes.map(plierEtiquette);
        return args.some((a) => {
          const t = texteDe(a);
          if (t === null || !t.replace(/^#/, "")) return false;
          const p = plierEtiquette(t);
          return miennes.some((m) => m === p || m.startsWith(p + "/"));
        });
      }
      // hasProperty : la clé existe (même vide, null ou illisible) ; un en-tête illisible est indéterminé
      const cle = texteDe(args[0]);
      if (cle === null) return false;
      if (e.yamlInvalide) throw new Indetermine(`en-tête YAML illisible (${e.yamlInvalide})`);
      return e.proprietes.has(cle);
    }
    case "methode": {
      const c = evaluer(n.cible, e, ctx);
      const args = n.args.map((a) => evaluer(a, e, ctx));
      switch (n.fn) {
        case "isEmpty":
          if (c === undefined || c === null) return true;
          if (typeof c === "string" || Array.isArray(c)) return c.length === 0;
          return false;
        case "lower":
          return typeof c === "string" ? c.toLowerCase() : c;
        case "date": {
          // lot 12 (Obsidian : « date object with the time removed ») : minuit du jour, dans le fuseau
          const d = enDate(c, ctx.fuseau);
          if (!d) return null;
          const k = composantesLocales(d.ms, ctx.fuseau);
          return new DateBase(instantLocal(k.a, k.m, k.j, 0, 0, 0, 0, ctx.fuseau), true);
        }
        case "format": {
          const d = enDate(c, ctx.fuseau);
          const motif = texteDe(args[0]);
          return d && motif !== null ? formaterDate(d, motif, ctx.fuseau) : null;
        }
        case "contains":
          if (typeof c === "string") { const t = texteDe(args[0]); return t !== null && c.includes(t); }
          if (Array.isArray(c)) return c.some((x) => egal(x, args[0], ctx.fuseau));
          return false;
        case "containsAll": case "containsAny": {
          const test = (a: Valeur): boolean => {
            if (typeof c === "string") { const t = texteDe(a); return t !== null && c.includes(t); }
            if (Array.isArray(c)) return c.some((x) => egal(x, a, ctx.fuseau));
            return false;
          };
          return n.fn === "containsAll" ? args.every(test) : args.some(test);
        }
        case "startsWith": case "endsWith": {
          const t = texteDe(args[0]);
          if (typeof c !== "string" || t === null) return false;
          return n.fn === "startsWith" ? c.startsWith(t) : c.endsWith(t);
        }
      }
    }
  }
  return undefined;
}

// ================================================================================================
// Filtres (arbre and / or / not d'Obsidian Bases)
// ================================================================================================

export type Filtre =
  | { k: "expr"; source: string; ast: Noeud; ou: string }
  | { k: "and" | "or" | "not"; enfants: Filtre[]; ou: string };

export interface ErreurBase {
  /** Emplacement dans le bloc (« views[0].filters.and[1] »). */
  ou: string;
  message: string;
  expression?: string;
  position?: number;
}

const MAX_FILTRES = 200;

/** Compile un filtre (valeur YAML déjà lue). Ajoute les erreurs ; renvoie null si invalide. */
export function compilerFiltre(v: unknown, ou: string, erreurs: ErreurBase[], prof = 0, compte = { n: 0 }): Filtre | null {
  if (prof > 16) { erreurs.push({ ou, message: "Filtres trop imbriqués." }); return null; }
  if (++compte.n > MAX_FILTRES) { erreurs.push({ ou, message: "Trop de filtres." }); return null; }
  if (typeof v === "string") {
    try {
      return { k: "expr", source: v, ast: analyserExpression(v), ou };
    } catch (x) {
      if (x instanceof ErreurExpression) { erreurs.push({ ou, message: x.message, expression: v, position: x.position }); return null; }
      throw x;
    }
  }
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const cles = Object.keys(v);
    if (cles.length === 1 && ["and", "or", "not"].includes(cles[0])) {
      const k = cles[0] as "and" | "or" | "not";
      const liste = (v as Record<string, unknown>)[k];
      if (!Array.isArray(liste)) { erreurs.push({ ou: `${ou}.${k}`, message: `« ${k} » attend une liste de filtres.` }); return null; }
      const enfants: Filtre[] = [];
      let ok = true;
      liste.forEach((x, i) => {
        const f = compilerFiltre(x, `${ou}.${k}[${i}]`, erreurs, prof + 1, compte);
        if (f) enfants.push(f);
        else ok = false;
      });
      return ok ? { k, enfants, ou } : null;
    }
  }
  const forme = v === null ? "null" : Array.isArray(v) ? "une liste" : typeof v === "object" ? `un objet (${Object.keys(v as object).join(", ") || "vide"})` : typeof v;
  erreurs.push({ ou, message: `Filtre non pris en charge : attendu une expression (texte) ou { and | or | not : [ … ] }, reçu ${forme}.` });
  return null;
}

/** Vrai / faux, ou Indetermine (levé). Groupes vides : aucune contrainte (vrai). `not` = aucun n'est vrai. */
export function evaluerFiltre(f: Filtre, e: EntreeBase, ctx: ContexteEvaluation): boolean {
  if (f.k === "expr") return vrai(evaluer(f.ast, e, ctx));
  let indet: Indetermine | null = null;
  const essai = (x: Filtre): boolean | null => {
    try { return evaluerFiltre(x, e, ctx); } catch (z) { if (z instanceof Indetermine) { indet ??= z; return null; } throw z; }
  };
  if (f.k === "and") {
    for (const x of f.enfants) if (essai(x) === false) return false;
    if (indet) throw indet;
    return true;
  }
  // or / not : un seul vrai suffit à décider
  for (const x of f.enfants) {
    if (essai(x) === true) return f.k === "or" ? true : false;
  }
  if (indet) throw indet;
  return f.k === "or" ? f.enfants.length === 0 : true;
}

// ================================================================================================
// Références de propriétés (colonnes, tris) : « statut », « note.statut », « file.name », « formula.x »
// ================================================================================================

export type Reference =
  | { nature: "note"; cle: string; id: string }
  | { nature: "fichier"; champ: ChampFichier; id: string }
  | { nature: "formule"; nom: string; id: string }
  | { nature: "inconnue"; id: string; message: string };

export function lireReference(id: string): Reference {
  if (id.startsWith("note.")) return { nature: "note", cle: id.slice(5), id };
  if (id.startsWith("formula.")) return { nature: "formule", nom: id.slice(8), id };
  if (id.startsWith("file.")) {
    const c = id.slice(5);
    if ((CHAMPS_FICHIER as readonly string[]).includes(c)) return { nature: "fichier", champ: c as ChampFichier, id };
    return { nature: "inconnue", id, message: `file.${c} n'est pas pris en charge par Carnet.` };
  }
  if (id.startsWith("this.")) return { nature: "inconnue", id, message: "« this » n'est pas pris en charge par Carnet." };
  return { nature: "note", cle: id, id };
}

/** Clé de frontmatter d'une référence de note (« note.statut » → « statut »), sinon null. */
export function cleDeReference(id: string): string | null {
  const r = lireReference(id);
  return r.nature === "note" ? r.cle : null;
}

// ================================================================================================
// Tri
// ================================================================================================

export type Sens = "ASC" | "DESC";
export interface Tri { propriete: string; sens: Sens }

export const collateurFr = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

/** Valeur de tri : rang de type + clé. Vide (absente, null, "", liste vide) et illisible : toujours à la fin. */
type CleTri = { vide: true; anomalie: boolean } | { vide: false; rang: number; n?: number; s?: string };

function cleDeTri(v: Valeur | Indetermine, fuseau: string): CleTri {
  if (v instanceof Indetermine) return { vide: true, anomalie: true };
  if (v === undefined || v === null || v === "" || (Array.isArray(v) && v.length === 0)) return { vide: true, anomalie: false };
  if (typeof v === "number") return { vide: false, rang: 0, n: v };
  if (v instanceof DateBase) return { vide: false, rang: 1, n: v.ms };
  if (typeof v === "string") {
    const d = lireDate(v, fuseau);
    if (d) return { vide: false, rang: 1, n: d.ms };
    return { vide: false, rang: 2, s: v };
  }
  if (typeof v === "boolean") return { vide: false, rang: 3, n: Number(v) };
  if (Array.isArray(v)) return { vide: false, rang: 2, s: v.map((x) => (x instanceof DateBase ? String(x.ms) : String(x))).join(", ") };
  return { vide: true, anomalie: false };
}

function comparerCles(a: CleTri, b: CleTri): number {
  if (a.vide || b.vide) {
    if (a.vide && b.vide) return Number(a.anomalie) - Number(b.anomalie);
    return a.vide ? 1 : -1;
  }
  if (a.rang !== b.rang) return a.rang - b.rang;
  if (a.s !== undefined && b.s !== undefined) {
    const c = collateurFr.compare(a.s, b.s);
    return c !== 0 ? c : a.s < b.s ? -1 : a.s > b.s ? 1 : 0;
  }
  return (a.n ?? 0) - (b.n ?? 0);
}

export function valeurDeReference(ref: Reference, e: EntreeBase): Valeur {
  if (ref.nature === "note") return valeurNote(e, ref.cle);
  if (ref.nature === "fichier") return valeurFichier(e, ref.champ);
  return undefined;
}

/** Trie (stable, déterministe) : tris demandés, vides à la fin quel que soit le sens, puis chemin. */
export function trier(entrees: EntreeBase[], tris: Tri[], fuseau: string): EntreeBase[] {
  const refs = tris.map((t) => ({ ref: lireReference(t.propriete), sens: t.sens }));
  const cles = new Map<EntreeBase, CleTri[]>();
  for (const e of entrees) {
    cles.set(e, refs.map(({ ref }) => {
      try { return cleDeTri(valeurDeReference(ref, e), fuseau); } catch (x) { if (x instanceof Indetermine) return cleDeTri(x, fuseau); throw x; }
    }));
  }
  return [...entrees].sort((a, b) => {
    const ca = cles.get(a)!, cb = cles.get(b)!;
    for (let i = 0; i < refs.length; i++) {
      const x = ca[i], y = cb[i];
      let c = comparerCles(x, y);
      if (c !== 0 && !x.vide && !y.vide && refs[i].sens === "DESC") c = -c;
      if (c !== 0) return c;
    }
    const c = collateurFr.compare(a.chemin, b.chemin);
    return c !== 0 ? c : a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0;
  });
}

// ================================================================================================
// Types de propriétés déclarés (extension `carnet.proprietes`) et validation des saisies
// ================================================================================================

/**
 * Propriétés de provenance (identifiants, origine d'un import, date de création, genre de page) : affichées, jamais
 * réécrites par l'interface (panneau « Propriétés », cellules d'une base, POST /api/propriete).
 */
export const CLES_PROVENANCE: ReadonlySet<string> = new Set(["id", "notion_id", "cree", "type"]);

export const TYPES_PROPRIETE = ["texte", "nombre", "case", "date", "statut", "selection", "liste"] as const;
export type TypePropriete = (typeof TYPES_PROPRIETE)[number];

/** Noms acceptés à la lecture (Obsidian, anglais) ; Carnet écrit toujours la forme française. */
export const ALIAS_TYPES: Record<string, TypePropriete> = {
  texte: "texte", text: "texte",
  nombre: "nombre", number: "nombre",
  case: "case", checkbox: "case", booleen: "case",
  date: "date", datetime: "date", "date-heure": "date",
  statut: "statut", status: "statut",
  selection: "selection", select: "selection", choix: "selection",
  liste: "liste", list: "liste", multitext: "liste", tags: "liste", etiquettes: "liste",
};

export const LIBELLES_TYPES: Record<TypePropriete, string> = {
  texte: "Texte", nombre: "Nombre", case: "Case à cocher", date: "Date", statut: "Statut", selection: "Sélection", liste: "Liste",
};

export interface DeclarationPropriete { type: TypePropriete; options: string[] | null }

/** Valeur qu'une saisie peut écrire (contrat de poserPropriete du socle). */
export type ValeurSaisie = string | number | boolean | null | string[];

export function estJourOuInstant(s: string): boolean {
  return lireDate(s) !== null;
}

/**
 * Valide une saisie selon le type déclaré. null = vider (la clé reste, valeur nulle), toujours permis.
 * Les messages sont affichés tels quels dans l'interface.
 */
export function validerSaisie(decl: DeclarationPropriete | null, v: unknown): { ok: true; valeur: ValeurSaisie } | { ok: false; message: string } {
  if (v === null) return { ok: true, valeur: null };
  if (!decl) {
    if (typeof v === "string" || typeof v === "boolean") return { ok: true, valeur: v };
    if (typeof v === "number") return Number.isFinite(v) ? { ok: true, valeur: v } : { ok: false, message: "Nombre invalide." };
    if (Array.isArray(v) && v.every((x) => typeof x === "string")) return { ok: true, valeur: v as string[] };
    return { ok: false, message: "Valeur non prise en charge (texte, nombre, case, liste de textes ou vide)." };
  }
  switch (decl.type) {
    case "texte":
      return typeof v === "string" ? { ok: true, valeur: v } : { ok: false, message: "Texte attendu." };
    case "nombre":
      if (typeof v !== "number" || !Number.isFinite(v)) return { ok: false, message: "Nombre attendu (ex. 12 ou 3,5)." };
      return { ok: true, valeur: v };
    case "case":
      return typeof v === "boolean" ? { ok: true, valeur: v } : { ok: false, message: "Case à cocher : oui ou non." };
    case "date":
      if (typeof v !== "string" || !estJourOuInstant(v)) return { ok: false, message: "Date invalide : attendu AAAA-MM-JJ (ex. 2026-10-12)." };
      return { ok: true, valeur: v };
    case "statut": case "selection":
      if (typeof v !== "string") return { ok: false, message: "Choisis une option de la liste." };
      if (decl.options && !decl.options.includes(v)) return { ok: false, message: `« ${v} » n'est pas une option de cette colonne (${decl.options.join(", ")}).` };
      return { ok: true, valeur: v };
    case "liste":
      if (!Array.isArray(v) || !v.every((x) => typeof x === "string")) return { ok: false, message: "Liste de textes attendue." };
      return { ok: true, valeur: v as string[] };
  }
}

/** Type déduit d'UNE valeur, pour l'affichage et le choix de l'éditeur (jamais pour déclarer). */
export function typeDeValeur(v: ValeurBrute | undefined): TypePropriete | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return "case";
  if (typeof v === "number") return "nombre";
  if (Array.isArray(v)) return "liste";
  if (RE_JOUR.test(v) && lireDate(v)) return "date";
  return "texte";
}

/** Lit la déclaration d'une propriété (`carnet.proprietes.<cle>`). Erreur explicite si le type est inconnu. */
export function lireDeclaration(v: unknown, ou: string, erreurs: ErreurBase[]): DeclarationPropriete | null {
  let typeBrut: unknown = v;
  let options: unknown = undefined;
  if (v && typeof v === "object" && !Array.isArray(v)) {
    typeBrut = (v as Record<string, unknown>).type;
    options = (v as Record<string, unknown>).options;
  }
  if (typeof typeBrut !== "string" || !(typeBrut.toLowerCase() in ALIAS_TYPES)) {
    erreurs.push({ ou, message: `Type de propriété inconnu : ${JSON.stringify(typeBrut) ?? "absent"} (types : ${TYPES_PROPRIETE.join(", ")}).` });
    return null;
  }
  const type = ALIAS_TYPES[typeBrut.toLowerCase()];
  let opts: string[] | null = null;
  if (options !== undefined && options !== null) {
    if (!Array.isArray(options) || !options.every((x) => typeof x === "string" || typeof x === "number")) {
      erreurs.push({ ou: `${ou}.options`, message: "« options » attend une liste de textes." });
      return null;
    }
    opts = options.map(String);
  }
  if ((type === "statut" || type === "selection") && !opts) {
    erreurs.push({ ou: `${ou}.options`, message: `Une propriété « ${type} » doit déclarer ses options.` });
    return null;
  }
  return { type, options: opts };
}

// ================================================================================================
// Filtres « simples » (ceux que l'interface sait afficher en pastille et écrire)
// ================================================================================================

export type OperateurSimple = "est" | "nest_pas" | "contient" | "ne_contient_pas" | "vide" | "non_vide" | "avant" | "apres" | "inf" | "sup" | "coche" | "non_coche"
  // lot 12 : dates relatives (valeur = nombre de jours N pour prochains_jours, au_plus_tard, plus_de_jours)
  | "avant_aujourdhui" | "jusqu_aujourdhui" | "aujourdhui" | "prochains_jours" | "au_plus_tard" | "plus_de_jours" | "cette_semaine";

/** Lot 12 : opérateurs relatifs à aujourd'hui (ils suivent l'horloge : la vue change seule le lendemain). */
export const OPERATEURS_RELATIFS: readonly OperateurSimple[] = ["avant_aujourdhui", "jusqu_aujourdhui", "aujourdhui", "prochains_jours", "au_plus_tard", "plus_de_jours", "cette_semaine"];
/** Opérateurs relatifs qui demandent un nombre de jours. */
export const OPERATEURS_JOURS: readonly OperateurSimple[] = ["prochains_jours", "au_plus_tard", "plus_de_jours"];

export interface FiltreSimple { propriete: string; operateur: OperateurSimple; valeur: string | number | null }

export const LIBELLES_OPERATEURS: Record<OperateurSimple, string> = {
  est: "est", nest_pas: "n'est pas", contient: "contient", ne_contient_pas: "ne contient pas", vide: "est vide", non_vide: "n'est pas vide",
  avant: "avant le", apres: "après le", inf: "inférieur à", sup: "supérieur à", coche: "est cochée", non_coche: "n'est pas cochée",
  avant_aujourdhui: "avant aujourd'hui", jusqu_aujourdhui: "aujourd'hui ou avant", aujourdhui: "aujourd'hui", prochains_jours: "dans les N prochains jours",
  au_plus_tard: "au plus tard dans N jours (retards compris)", plus_de_jours: "il y a plus de N jours", cette_semaine: "cette semaine",
};

/** Texte d'une pastille de filtre simple (« Prochaine relance : dans les 7 prochains jours »). */
export function decrireFiltreSimple(f: FiltreSimple, nom: string, valeur: (v: string | number) => string = (v) => `« ${v} »`): string {
  const n = typeof f.valeur === "number" ? f.valeur : Number(f.valeur);
  const jours = (k: number) => `${k} jour${k > 1 ? "s" : ""}`;
  switch (f.operateur) {
    case "avant_aujourdhui": return `${nom} : avant aujourd'hui`;
    case "jusqu_aujourdhui": return `${nom} : aujourd'hui ou avant`;
    case "aujourdhui": return `${nom} : aujourd'hui`;
    case "cette_semaine": return `${nom} : cette semaine`;
    case "prochains_jours": return n === 1 ? `${nom} : aujourd'hui ou demain` : `${nom} : dans les ${n} prochains jours`;
    case "au_plus_tard": return `${nom} : au plus tard dans ${jours(n)} (retards compris)`;
    case "plus_de_jours": return `${nom} : il y a plus de ${jours(n)}`;
  }
  const op = LIBELLES_OPERATEURS[f.operateur];
  return f.valeur === null ? `${nom} ${op}` : `${nom} ${op} ${valeur(f.valeur)}`;
}

function refTexte(cle: string): string {
  return /^[\p{L}_][\p{L}\p{N}_]*$/u.test(cle) && !["true", "false", "null", "file", "note", "this", "formula"].includes(cle)
    ? cle : `note[${JSON.stringify(cle)}]`;
}

function litTexte(v: string): string {
  return JSON.stringify(v);
}

/** Écrit l'expression d'un filtre simple (dans le sous-ensemble, relisible par analyserExpression). */
export function ecrireFiltreSimple(f: FiltreSimple): string {
  const r = refTexte(f.propriete);
  const v = f.valeur;
  const lit = typeof v === "number" ? String(v) : litTexte(String(v ?? ""));
  switch (f.operateur) {
    case "est": return `${r} == ${lit}`;
    case "nest_pas": return `${r} != ${lit}`;
    case "contient": return `${r}.contains(${lit})`;
    case "ne_contient_pas": return `!${r}.contains(${lit})`;
    case "vide": return `${r}.isEmpty()`;
    case "non_vide": return `!${r}.isEmpty()`;
    case "avant": return `${r} < date(${lit})`;
    case "apres": return `${r} > date(${lit})`;
    case "inf": return `${r} < ${lit}`;
    case "sup": return `${r} > ${lit}`;
    case "coche": return `${r} == true`;
    case "non_coche": return `${r} != true`;
    // lot 12 : expressions d'Obsidian Bases (relisibles par Obsidian)
    case "avant_aujourdhui": return `${r} < today()`;
    case "jusqu_aujourdhui": return `${r}.date() <= today()`;
    case "aujourdhui": return `${r}.date() == today()`;
    case "prochains_jours": return `${r}.date() >= today() && ${r}.date() <= today() + "${joursEntiers(v)}d"`;
    case "au_plus_tard": return `${r}.date() <= today() + "${joursEntiers(v)}d"`;
    case "plus_de_jours": return `${r} < today() - "${joursEntiers(v)}d"`;
    case "cette_semaine": return `${r}.format("GGGG-WW") == today().format("GGGG-WW")`;
  }
}

function joursEntiers(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 3650) throw new ErreurExpression("Nombre de jours attendu (entier de 0 à 3650).", 0);
  return n;
}

/** Reconnaît un filtre simple dans une expression (pour l'afficher en pastille), sinon null. */
export function lireFiltreSimple(src: string): FiltreSimple | null {
  let n: Noeud;
  try { n = analyserExpression(src); } catch { return null; }
  let neg = false;
  if (n.k === "non") { neg = true; n = n.e; }
  if (n.k === "methode" && n.cible.k === "note") {
    const p = n.cible.nom;
    if (n.fn === "isEmpty") return { propriete: p, operateur: neg ? "non_vide" : "vide", valeur: null };
    if (n.fn === "contains" && n.args[0].k === "lit" && typeof n.args[0].v === "string") return { propriete: p, operateur: neg ? "ne_contient_pas" : "contient", valeur: n.args[0].v };
    return null;
  }
  if (!neg) {
    const r = lireFiltreRelatif(n);
    if (r) return r;
  }
  if (neg || n.k !== "cmp" || n.g.k !== "note") return null;
  const p = n.g.nom;
  const d = n.d;
  if (d.k === "fnGlobale" && d.fn === "date" && d.args[0].k === "lit" && typeof d.args[0].v === "string") {
    if (n.op === "<") return { propriete: p, operateur: "avant", valeur: d.args[0].v };
    if (n.op === ">") return { propriete: p, operateur: "apres", valeur: d.args[0].v };
    return null;
  }
  if (d.k !== "lit") return null;
  if (d.v === true && n.op === "==") return { propriete: p, operateur: "coche", valeur: null };
  if (d.v === true && n.op === "!=") return { propriete: p, operateur: "non_coche", valeur: null };
  if (typeof d.v === "string" || typeof d.v === "number") {
    if (n.op === "==") return { propriete: p, operateur: "est", valeur: d.v };
    if (n.op === "!=") return { propriete: p, operateur: "nest_pas", valeur: d.v };
    if (typeof d.v === "number" && n.op === "<") return { propriete: p, operateur: "inf", valeur: d.v };
    if (typeof d.v === "number" && n.op === ">") return { propriete: p, operateur: "sup", valeur: d.v };
  }
  return null;
}

/** Lot 12 : reconnaît exactement les formes écrites par ecrireFiltreSimple pour les opérateurs relatifs. */
function lireFiltreRelatif(n: Noeud): FiltreSimple | null {
  const estAuj = (x: Noeud) => x.k === "fnGlobale" && x.fn === "today";
  const jours = (x: Noeud, signe: 1 | -1): number | null =>
    x.k === "decale" && x.signe === signe && x.duree.unite === "d" && estAuj(x.base) && x.source === `${x.duree.n}d` ? x.duree.n : null;
  /** « relance.date() » → « relance » */
  const jourDe = (x: Noeud): string | null => (x.k === "methode" && x.fn === "date" && x.cible.k === "note" ? x.cible.nom : null);
  if (n.k === "cmp" && n.g.k === "note") {
    const p = n.g.nom;
    if (n.op === "<" && estAuj(n.d)) return { propriete: p, operateur: "avant_aujourdhui", valeur: null };
    if (n.op === "<") { const k = jours(n.d, -1); if (k !== null) return { propriete: p, operateur: "plus_de_jours", valeur: k }; }
    return null;
  }
  if (n.k === "cmp" && n.op === "<=" && jourDe(n.g) !== null) {
    const p = jourDe(n.g)!;
    if (estAuj(n.d)) return { propriete: p, operateur: "jusqu_aujourdhui", valeur: null };
    const k = jours(n.d, 1);
    if (k !== null) return { propriete: p, operateur: "au_plus_tard", valeur: k };
    return null;
  }
  if (n.k === "cmp" && n.op === "==" && n.g.k === "methode" && n.g.cible.k === "note") {
    const p = n.g.cible.nom;
    if (n.g.fn === "date" && estAuj(n.d)) return { propriete: p, operateur: "aujourdhui", valeur: null };
    const motif = (x: Noeud) => (x.k === "methode" && x.fn === "format" && x.args[0].k === "lit" ? x.args[0].v : null);
    if (n.g.fn === "format" && motif(n.g) === "GGGG-WW" && n.d.k === "methode" && estAuj(n.d.cible) && motif(n.d) === "GGGG-WW") {
      return { propriete: p, operateur: "cette_semaine", valeur: null };
    }
    return null;
  }
  if (n.k === "et" && n.g.k === "cmp" && n.d.k === "cmp" && jourDe(n.g.g) !== null && jourDe(n.g.g) === jourDe(n.d.g)
    && n.g.op === ">=" && estAuj(n.g.d) && n.d.op === "<=") {
    const k = jours(n.d.d, 1);
    if (k !== null) return { propriete: jourDe(n.g.g)!, operateur: "prochains_jours", valeur: k };
  }
  return null;
}

// ================================================================================================
// Réponses de l'API (partagées avec l'interface)
// ================================================================================================

export interface ColonneBase {
  /** Référence telle qu'écrite dans `order` (« statut », « note.statut », « file.name »). */
  id: string;
  libelle: string;
  nature: "note" | "fichier" | "formule" | "inconnue";
  /** Clé du frontmatter (colonnes de note), sinon null. */
  cle: string | null;
  /** Type déclaré (`carnet.proprietes`), sinon null. */
  type: TypePropriete | null;
  options: string[] | null;
  /** Cellules modifiables depuis le tableau (propriétés de note seulement). */
  modifiable: boolean;
  /** Colonne non prise en charge (formule…) : message affiché à la place des valeurs. */
  probleme: string | null;
}

export interface CelluleBase {
  etat: "absente" | "nulle" | "valeur" | "anomalie";
  valeur?: ValeurBrute;
  /** Texte d'affichage déjà calculé (titres, dates de fichier). */
  texte?: string;
  raison?: string;
  /** Statut ou sélection dont la valeur n'est pas une option déclarée (affichée telle quelle). */
  horsListe?: boolean;
}

export interface LigneBase {
  chemin: string;
  titre: string;
  icone: string | null;
  etag: string;
  /** En-tête que Carnet ne modifie pas (ancre, alias, clé en double…) : cellules en lecture seule, raison affichée. */
  nonModifiable?: string;
  cellules: Record<string, CelluleBase>;
}

export interface FiltreAffiche { index: number; expression: string; simple: FiltreSimple | null }

export interface ResultatBase {
  vues: Array<{ nom: string; type: string; prise: boolean }>;
  vue: number;
  colonnes: ColonneBase[];
  lignes: LigneBase[];
  /** Nombre de pages retenues avant la limite. */
  total: number;
  limite: number | null;
  /** Pages dont le classement dépend d'une valeur illisible : jamais rangées au hasard, listées ici. */
  nonClassees: Array<{ chemin: string; titre: string; raison: string }>;
  avertissements: string[];
  /** Dossier des nouvelles entrées (`carnet.dossier`), sinon null. */
  dossier: string | null;
  tri: Tri[];
  /** Filtres de la vue sous forme de liste « et » modifiable par l'interface ; null si la forme est avancée. */
  filtres: FiltreAffiche[] | null;
  /** Description lisible des filtres globaux (non modifiables depuis l'interface). */
  filtresGlobaux: string[];
  /** L'interface peut-elle réécrire filtres et tri de cette vue ? (sinon : raison affichée) */
  reecriture: { possible: true } | { possible: false; raison: string };
  /**
   * Lot 12 : pages de la base écartées par une comparaison de dates parce que la propriété est vide ou n'est pas une
   * date (phrases prêtes à afficher, toujours visibles) : aucun échec ne devient « zéro ligne » sans le dire.
   */
  exclusions?: string[];
  /** Échéances (11/10/2026) : `carnet.aujourdhui` lue (null si absente ou invalide : voir les avertissements). */
  aujourdhui?: { echeance: string; fait: { propriete: string; valeur: string | boolean }; priorite: string | null } | null;
  /** Échéances : propriétés déclarées (`carnet.proprietes`), avec leur libellé, pour proposer échéance et « fait ». */
  declarees?: Array<{ cle: string; type: TypePropriete; options: string[] | null; libelle: string }>;
}

export interface ResultatErreurBase { erreur: string; raison: "base_invalide"; erreurs: ErreurBase[] }
