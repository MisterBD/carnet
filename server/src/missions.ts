// Carnet · lot 10 « Missions vivantes » : fiches `type: mission` lues dans l'index mémoire, en LECTURE SEULE.
//
// Trois niveaux de vérité, jamais confondus :
// - DÉCLARÉ : ce que l'agent écrit dans la fiche (état, responsable, dernier signal, prochain pas, blocage) ;
// - OBSERVÉ : ce que Carnet constate sur le disque (date de modification du fichier) ;
// - VÉRIFIÉ : seulement l'existence d'un livrable dans l'espace (page, dossier, fichier). Une URL externe n'est jamais
//   vérifiée (le serveur ne sort pas) ; un lien vers une zone masquée ne résout pas et n'en dit rien.
// Aucune écriture : la consultation ne touche à aucun fichier (ni l'espace, ni CARNET_ETAT).
import { Demandes } from "./demandes.ts";
import { estTechnique } from "../../shared/techniques.ts";
import type { Techniques } from "../../shared/techniques.ts";
import { dossierDe, feuille, plier, resoudre } from "../../shared/page.ts";
import type { Ctx } from "./api.ts";
import { texte } from "./espace.ts";
import type { Espace, Page } from "./espace.ts";
import { envoyerJson } from "./http.ts";
import { nettoyerLigne } from "./liens.ts";
import { marquerCode } from "./markdown.ts";

export type CodeEtat = "a_faire" | "en_cours" | "a_arbitrer" | "bloquee" | "terminee_declaree" | "abandonnee";
export type Section = "a_arbitrer" | "resultats" | "en_cours" | "autres";
export type GenreLien = "page" | "dossier" | "fichier" | "externe" | "introuvable" | "invalide";

/** États reconnus (comparaison sans casse ni accents, espaces réduits). Toute autre valeur reste telle quelle (« Autres »). */
const ETATS: Record<string, CodeEtat> = {
  "a faire": "a_faire",
  "en cours": "en_cours",
  "a arbitrer": "a_arbitrer",
  "bloquee": "bloquee",
  "terminee declaree": "terminee_declaree",
  "abandonnee": "abandonnee",
};

export interface Lien {
  /** Texte tel qu'écrit dans la fiche (tronqué). */
  brut: string;
  genre: GenreLien;
  /** Chemin dans l'espace (page .md, dossier, fichier), sinon null. */
  chemin: string | null;
  /** Titre de la page, nom du dossier ou du fichier ; pour un lien non résolu, la cible lisible. */
  titre: string | null;
  /** URL http(s) d'un lien externe (jamais vérifiée), sinon null. */
  url: string | null;
  /** Présent dans l'espace visible (page, dossier, fichier). Une URL externe n'est jamais « résolue ». */
  resolu: boolean;
}

export interface Anomalie {
  code: string;
  texte: string;
}

export interface Mission {
  chemin: string;
  titre: string;
  icone: string | null;
  /** Révision du fichier (change à chaque modification : l'interface repère la carte qui vient de bouger). */
  etag: string;
  id: string | null;
  /** Demande en une ligne : premier paragraphe de « ## Demande », sinon le champ `demande`. */
  demande: string | null;
  demande_par: string | null;
  /** Déclaration de l'agent, jamais une preuve d'auteur. */
  responsable_declare: string | null;
  etat: { brut: string | null; code: CodeEtat | null };
  section: Section;
  /** Dernier signal DÉCLARÉ (`dernier_signal`). date en ms (null si absent ou illisible). */
  signal: { brut: string | null; date: number | null; precision: "minute" | "jour" | null; fuseau: boolean };
  /** Date OBSERVÉE : dernière modification du fichier (ms). */
  observe: number;
  prochain_pas: string | null;
  blocage: string | null;
  livrables: Lien[];
  /** Premier livrable résolu (page, dossier ou fichier de l'espace) : ce que « Ouvrir le résultat » ouvre. */
  resultat: Lien | null;
  /** `statut` : effectif (lot 3) quand le serveur le connaît, sinon déclaré ; `statut_declare` : écrit dans le fichier. */
  decision: (Lien & { statut: string | null; statut_declare?: string | null }) | null;
  client: Lien | null;
  journal: { nb: number; dernier: string | null };
  /** Fiche rangée parmi les fichiers techniques des agents (règles du lot 3) : montrée quand même, signalée. */
  technique: boolean;
  anomalies: Anomalie[];
}

export interface Compteurs {
  total: number;
  a_arbitrer: number;
  resultats: number;
  en_cours: number;
  autres: number;
  bloquees: number;
  /** Missions qui portent au moins une anomalie. */
  anomalies: number;
}

export interface ReponseMissions {
  maintenant: number;
  fuseau: string;
  missions: Mission[];
  compteurs: Compteurs;
  /** Plus de MAX_MISSIONS fiches : les plus récentes seulement. */
  tronque: boolean;
}

export interface OptionsMissions {
  maintenant?: number;
  /** Fuseau des heures écrites sans décalage (« 2026-10-10 22:40 »). */
  fuseau?: string;
  /** Règle « fichier technique » du lot 3 (shared/techniques.ts) à brancher à l'intégration. */
  estTechnique?: (chemin: string) => boolean;
}

export const MAX_MISSIONS = 500;
const MAX_LIVRABLES = 20;
const MAX_TEXTE = 300;
/** Un signal plus de 5 min dans le futur : horloge de l'agent fausse ou faute de frappe. */
const AVANCE_TOLEREE = 5 * 60 * 1000;
export const FUSEAU_DEFAUT = "Europe/Paris";

// ---------------------------------------------------------------------------------------------
// Valeurs du frontmatter
// ---------------------------------------------------------------------------------------------

const RE_CONTROLES = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g;

function propre(s: string, max = MAX_TEXTE): string {
  let t = s.replace(RE_CONTROLES, "").replace(/\s+/g, " ").trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

/** Texte affichable d'une valeur scalaire (ou liste de scalaires), sinon null. Chaîne vide = null. */
function champTexte(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (Array.isArray(v)) {
    const t = v.map(texte).filter((x): x is string => x !== null && x.trim() !== "");
    return t.length ? propre(t.join(", ")) : null;
  }
  const t = texte(v);
  return t === null || t.trim() === "" ? null : propre(t);
}

/** Valeur brute montrée telle quelle (état inconnu, signal illisible) : jamais réinterprétée. */
function brut(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  const t = texte(v);
  if (t !== null) return propre(t, 120);
  try {
    return propre(JSON.stringify(v), 120);
  } catch {
    return "(valeur illisible)";
  }
}

export function lireEtat(v: unknown): { brut: string | null; code: CodeEtat | null } {
  const b = brut(v);
  if (b === null || b === "") return { brut: null, code: null };
  const cle = typeof v === "string" ? plier(v).replace(/\s+/g, " ").trim() : "";
  return { brut: b, code: ETATS[cle] ?? null };
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,]\d{1,9})?)?[ ]?(Z|z|[+-]\d{2}(?::?\d{2})?)?)?$/;
const formats = new Map<string, Intl.DateTimeFormat>();

/** Décalage (ms) du fuseau `fuseau` à l'instant `utc`. */
function decalage(utc: number, fuseau: string): number {
  let f = formats.get(fuseau);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuseau, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formats.set(fuseau, f);
  }
  const p: Record<string, number> = {};
  for (const x of f.formatToParts(new Date(utc))) if (x.type !== "literal") p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(utc / 1000) * 1000;
}

/** Heure locale « murale » (sans décalage) du fuseau → instant UTC. */
function depuisLocale(murale: number, fuseau: string): number {
  let t = murale - decalage(murale, fuseau);
  t = murale - decalage(t, fuseau);
  return t;
}

/**
 * `dernier_signal` : ISO 8601 strict (date seule, ou date + heure, avec ou sans décalage). Une heure sans décalage est
 * lue dans le fuseau de Carnet (Europe/Paris par défaut). Tout le reste (« hier soir », nombre, 31/02) est illisible.
 */
export function lireSignal(v: unknown, fuseau = FUSEAU_DEFAUT): Mission["signal"] {
  if (v === undefined || v === null || v === "") return { brut: null, date: null, precision: null, fuseau: false };
  if (v instanceof Date) {
    const ok = !Number.isNaN(v.getTime());
    return { brut: ok ? v.toISOString() : "(date illisible)", date: ok ? v.getTime() : null, precision: ok ? "minute" : null, fuseau: true };
  }
  const b = brut(v);
  if (typeof v !== "string") return { brut: b, date: null, precision: null, fuseau: false };
  const m = RE_DATE.exec(v.trim());
  if (!m) return { brut: b, date: null, precision: null, fuseau: false };
  const [an, mois, jour] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const h = m[4] !== undefined ? Number(m[4]) : 0;
  const mi = m[5] !== undefined ? Number(m[5]) : 0;
  const s = m[6] !== undefined ? Number(m[6]) : 0;
  if (mois < 1 || mois > 12 || jour < 1 || h > 23 || mi > 59 || s > 59) return { brut: b, date: null, precision: null, fuseau: false };
  const murale = Date.UTC(an, mois - 1, jour, h, mi, s);
  const d = new Date(murale);
  if (d.getUTCFullYear() !== an || d.getUTCMonth() !== mois - 1 || d.getUTCDate() !== jour) return { brut: b, date: null, precision: null, fuseau: false };
  const precision = m[4] !== undefined ? "minute" : "jour";
  const z = m[7];
  if (z === undefined) return { brut: b, date: depuisLocale(murale, fuseau), precision, fuseau: false };
  if (z === "Z" || z === "z") return { brut: b, date: murale, precision, fuseau: true };
  const signe = z[0] === "-" ? -1 : 1;
  const chiffres = z.slice(1).replace(":", "");
  const dh = Number(chiffres.slice(0, 2));
  const dm = chiffres.length > 2 ? Number(chiffres.slice(2, 4)) : 0;
  if (dh > 14 || dm > 59) return { brut: b, date: null, precision: null, fuseau: false };
  return { brut: b, date: murale - signe * (dh * 60 + dm) * 60_000, precision, fuseau: true };
}

// ---------------------------------------------------------------------------------------------
// Corps : « ## Demande » et « ## Journal »
// ---------------------------------------------------------------------------------------------

const RE_TITRE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
const RE_PUCE = /^[ \t]{0,3}(?:[-*+]|\d{1,9}[.)])[ \t]+/;

/** Lignes (hors code) de la section dont le titre vaut `nom` (sans casse ni accents), jusqu'au titre suivant de même niveau ou plus haut. */
function section(corps: string, nom: string): string[] | null {
  const lignes = corps.split("\n").map((l) => l.replace(/\r$/, ""));
  const code = marquerCode(lignes);
  let niveau = 0;
  let dedans = false;
  const res: string[] = [];
  for (let i = 0; i < lignes.length; i++) {
    const m = code[i] ? null : RE_TITRE.exec(lignes[i]);
    if (m) {
      if (dedans && m[1].length <= niveau) break;
      if (!dedans && plier(m[2]).trim() === nom) { dedans = true; niveau = m[1].length; continue; }
    }
    if (dedans && !code[i]) res.push(lignes[i]);
  }
  return dedans ? res : null;
}

function lireDemande(p: Page): string | null {
  const s = section(p.contenu.slice(p.debutCorps), "demande");
  if (s) {
    const premiere = s.find((l) => l.trim() !== "" && !/^\s*(---|\*\*\*|___)\s*$/.test(l));
    if (premiere) {
      const t = nettoyerLigne(premiere, 200);
      if (t) return propre(t, 200);
    }
  }
  return p.fm ? champTexte(p.fm.demande) : null;
}

function lireJournal(p: Page): Mission["journal"] {
  const s = section(p.contenu.slice(p.debutCorps), "journal");
  if (!s) return { nb: 0, dernier: null };
  const puces = s.filter((l) => RE_PUCE.test(l));
  const dernier = puces.length ? nettoyerLigne(puces[puces.length - 1], 200) : null;
  return { nb: puces.length, dernier: dernier ? propre(dernier, 200) : null };
}

// ---------------------------------------------------------------------------------------------
// Liens : livrables, décision, client
// ---------------------------------------------------------------------------------------------

interface Index {
  pages: Map<string, Page>;
  dossiers: Set<string>;
  fichiers: Set<string>;
  /** suffixe (« b/c », « c ») -> chemins de pages « a/b/c.md » (résolution par nom unique, comme les wikiliens). */
  parNom: Map<string, string[]>;
}

function construireIndex(espace: Espace): Index {
  const pages = new Map<string, Page>();
  for (const p of espace.pages.values()) pages.set(p.chemin, p);
  const parNom = new Map<string, string[]>();
  for (const p of espace.pagesVisibles()) {
    const segs = p.chemin.slice(0, -3).split("/");
    for (let i = 0; i < segs.length; i++) {
      const suffixe = segs.slice(i).join("/");
      const l = parNom.get(suffixe);
      if (l) l.push(p.chemin);
      else parNom.set(suffixe, [p.chemin]);
    }
  }
  return { pages, dossiers: new Set(espace.dossiers.keys()), fichiers: new Set(espace.fichiers.keys()), parNom };
}

function lienPage(ix: Index, chemin: string, b: string): Lien | null {
  let p = ix.pages.get(chemin);
  if (!p) return null;
  // lien symbolique vers une autre page (CLAUDE.md -> AGENTS.md) : la cible
  if (p.alias && ix.pages.has(p.alias)) p = ix.pages.get(p.alias)!;
  return { brut: b, genre: "page", chemin: p.chemin, titre: p.titre, url: null, resolu: true };
}

/** Cherche `cible` (chemin logique sans « .md » final, ou avec) : page, dossier, fichier ; d'abord tel quel, puis relatif à la fiche, puis nom unique. */
function chercher(ix: Index, cible: string, depuis: string, b: string, veutDossier: boolean): Lien | null {
  const n = cible.normalize("NFC").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!n) return null;
  const candidats: string[] = [n];
  const rel = resoudre(dossierDe(depuis), n);
  if (rel && rel !== n) candidats.push(rel);
  for (const c of candidats) {
    if (c.split("/").some((s) => s.startsWith("."))) continue;
    const sansMd = c.replace(/\.md$/i, "");
    if (!veutDossier) {
      const l = lienPage(ix, sansMd + ".md", b);
      if (l) return l;
      if (ix.fichiers.has(c)) return { brut: b, genre: "fichier", chemin: c, titre: feuille(c), url: null, resolu: true };
    }
    if (ix.dossiers.has(sansMd)) {
      // un dossier qui a sa page (« X.md » + « X/ ») s'ouvre sur sa page
      const l = veutDossier ? null : lienPage(ix, sansMd + ".md", b);
      return l ?? { brut: b, genre: "dossier", chemin: sansMd, titre: feuille(sansMd), url: null, resolu: true };
    }
  }
  if (!veutDossier && !n.includes("..")) {
    const l = ix.parNom.get(n.replace(/\.md$/i, ""));
    if (l && l.length === 1) return lienPage(ix, l[0], b);
  }
  return null;
}

const RE_WIKI_SEUL = /^!?\[\[([^\[\]\n]+)\]\]$/;
const RE_MD_SEUL = /^!?\[([^\]\n]*)\]\((<[^<>\n]*>|[^\s()<>]+)(?:[ \t]+"[^"\n]*")?\)$/;
const RE_SCHEMA = /^([a-z][a-z0-9+.-]*):/i;

function introuvable(b: string, cible: string): Lien {
  return { brut: b, genre: "introuvable", chemin: null, titre: propre(cible, 160) || b, url: null, resolu: false };
}

function invalide(b: string): Lien {
  return { brut: b, genre: "invalide", chemin: null, titre: b, url: null, resolu: false };
}

function lienUrl(b: string, url: string): Lien {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return invalide(b);
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return invalide(b);
  return { brut: b, genre: "externe", chemin: null, titre: propre(u.host + (u.pathname === "/" ? "" : u.pathname), 120), url: u.href, resolu: false };
}

/** Résout une valeur de lien d'une fiche (wikilien, lien Markdown, URL, chemin simple). */
function resoudreLien(ix: Index, v: unknown, depuis: string): Lien | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") {
    const b = brut(v);
    return b === null ? null : invalide(b);
  }
  const s = v.replace(RE_CONTROLES, "").trim();
  if (!s) return null;
  const b = propre(s, 500);
  let m = RE_WIKI_SEUL.exec(s);
  if (m) {
    const cible = m[1].split("|")[0].split("#")[0].trim();
    if (!cible) return invalide(b);
    return chercher(ix, cible, depuis, b, cible.endsWith("/")) ?? introuvable(b, cible);
  }
  m = RE_MD_SEUL.exec(s);
  if (m) {
    let cible = m[2];
    if (cible.startsWith("<")) cible = cible.slice(1, -1);
    if (RE_SCHEMA.test(cible) || cible.startsWith("//")) return lienUrl(b, cible);
    const r = resoudre(dossierDe(depuis), cible);
    if (r === null) return introuvable(b, cible);
    return chercher(ix, r, "", b, cible.split(/[?#]/)[0].endsWith("/")) ?? introuvable(b, r);
  }
  if (RE_SCHEMA.test(s)) return lienUrl(b, s);
  if (s.startsWith("//") || s.includes("\\")) return invalide(b);
  return chercher(ix, s, depuis, b, s.endsWith("/")) ?? introuvable(b, s);
}

function listeLiens(ix: Index, v: unknown, depuis: string): { liens: Lien[]; invalide: boolean } {
  if (v === undefined || v === null || v === "") return { liens: [], invalide: false };
  const valeurs = Array.isArray(v) ? v : [v];
  const liens: Lien[] = [];
  for (const x of valeurs.slice(0, MAX_LIVRABLES)) {
    const l = resoudreLien(ix, x, depuis);
    if (l) liens.push(l);
  }
  return { liens, invalide: typeof v === "object" && !Array.isArray(v) };
}

// ---------------------------------------------------------------------------------------------
// Calcul
// ---------------------------------------------------------------------------------------------

export function estMission(p: Page): boolean {
  const t = p.fm?.type;
  return typeof t === "string" && plier(t).trim() === "mission";
}

function nommer(l: Lien): string {
  return l.genre === "externe" ? (l.url ?? l.brut) : (l.titre ?? l.brut);
}

function decrireMission(ix: Index, p: Page, o: Required<Pick<OptionsMissions, "maintenant" | "fuseau">> & OptionsMissions): Mission {
  const fm = p.fm ?? {};
  const etat = lireEtat(fm.etat);
  const signal = lireSignal(fm.dernier_signal, o.fuseau);
  const anomalies: Anomalie[] = [];

  const liv = listeLiens(ix, fm.livrables, p.chemin);
  const livrables = liv.liens;
  const resultat = livrables.find((l) => l.resolu) ?? null;
  const dec = resoudreLien(ix, Array.isArray(fm.decision) ? fm.decision[0] : fm.decision, p.chemin);
  let decision: Mission["decision"] = null;
  if (dec) {
    const pd = dec.genre === "page" && dec.chemin ? ix.pages.get(dec.chemin) : undefined;
    decision = { ...dec, statut: pd?.fm ? champTexte(pd.fm.statut) : null };
  }
  const client = resoudreLien(ix, Array.isArray(fm.client) ? fm.client[0] : fm.client, p.chemin);

  // Section : l'état DÉCLARÉ, sauf « terminée déclarée » sans livrable vérifiable, qui demande ton œil (À arbitrer).
  let section: Section;
  switch (etat.code) {
    case "a_arbitrer": section = "a_arbitrer"; break;
    case "terminee_declaree": section = resultat ? "resultats" : "a_arbitrer"; break;
    case "a_faire": case "en_cours": case "bloquee": section = "en_cours"; break;
    default: section = "autres";
  }

  if (etat.code === "terminee_declaree" && !resultat) {
    const externes = livrables.filter((l) => l.genre === "externe");
    if (externes.length && externes.length === livrables.length) {
      anomalies.push({ code: "livrable_non_verifie", texte: "terminée déclarée · livrable externe, non vérifié" });
    } else {
      anomalies.push({ code: "livrable_absent", texte: "terminée déclarée · livrable absent" });
    }
  }
  if (etat.code === "terminee_declaree") {
    for (const l of livrables) if (l.genre === "introuvable") anomalies.push({ code: "livrable_introuvable", texte: `livrable introuvable : ${nommer(l)}` });
  }
  for (const l of livrables) if (l.genre === "invalide") anomalies.push({ code: "livrable_invalide", texte: `livrable illisible : ${l.brut}` });
  if (liv.invalide) anomalies.push({ code: "livrable_invalide", texte: "champ « livrables » illisible (liste attendue)" });
  if (etat.brut === null) anomalies.push({ code: "etat_absent", texte: "état non déclaré" });
  else if (etat.code === null) anomalies.push({ code: "etat_inconnu", texte: `état inconnu : « ${etat.brut} »` });
  if (signal.brut !== null && signal.date === null) anomalies.push({ code: "signal_illisible", texte: `dernier signal illisible : « ${signal.brut} »` });
  if (signal.date !== null && signal.date > o.maintenant + AVANCE_TOLEREE) anomalies.push({ code: "signal_futur", texte: "dernier signal daté dans le futur" });
  if (decision && !decision.resolu && decision.genre !== "externe") anomalies.push({ code: "decision_introuvable", texte: `décision introuvable : ${nommer(decision)}` });

  return {
    chemin: p.chemin,
    titre: p.titre,
    icone: p.icone,
    etag: p.etag,
    id: champTexte(fm.id),
    demande: lireDemande(p),
    demande_par: champTexte(fm.demande_par),
    responsable_declare: champTexte(fm.responsable_declare),
    etat,
    section,
    signal,
    observe: p.mtime,
    prochain_pas: champTexte(fm.prochain_pas),
    blocage: champTexte(fm.blocage),
    livrables,
    resultat,
    decision,
    client,
    journal: lireJournal(p),
    technique: o.estTechnique ? o.estTechnique(p.chemin) : false,
    anomalies,
  };
}

export const ORDRE_SECTIONS: readonly Section[] = ["a_arbitrer", "resultats", "en_cours", "autres"];
const RANG_EN_COURS: Record<string, number> = { bloquee: 0, en_cours: 1, a_faire: 2 };

function cleTemps(m: Mission): number {
  return m.signal.date ?? m.observe;
}

/** Toutes les missions de l'espace visible (alias exclus ; zones masquées et cachées jamais indexées). */
export function calculerMissions(espace: Espace, opts: OptionsMissions = {}): ReponseMissions {
  const maintenant = opts.maintenant ?? Date.now();
  const fuseau = opts.fuseau ?? FUSEAU_DEFAUT;
  const ix = construireIndex(espace);
  // lot 6 : ni missions archivées (`archive: true`, ou sous une page archivée) ni modèles (dossier Modèles/)
  const toutes = espace.pagesCourantes().filter(estMission).map((p) => decrireMission(ix, p, { ...opts, maintenant, fuseau }));

  // identifiants en double : signalés sur chaque fiche concernée
  const parId = new Map<string, Mission[]>();
  for (const m of toutes) if (m.id) parId.set(m.id, [...(parId.get(m.id) ?? []), m]);
  for (const [id, l] of parId) {
    if (l.length < 2) continue;
    for (const m of l) {
      const autres = l.filter((x) => x !== m).map((x) => `« ${x.titre} »`).join(", ");
      m.anomalies.push({ code: "id_double", texte: `identifiant ${id} partagé avec ${autres}` });
    }
  }

  // Ordre : section (À arbitrer, Résultats, En cours, Autres) ; dans « En cours » bloquées puis en cours puis à faire ;
  // puis dernier signal déclaré (à défaut, date du fichier), le plus récent d'abord.
  toutes.sort((a, b) => ORDRE_SECTIONS.indexOf(a.section) - ORDRE_SECTIONS.indexOf(b.section)
    || (RANG_EN_COURS[a.etat.code ?? ""] ?? 3) - (RANG_EN_COURS[b.etat.code ?? ""] ?? 3)
    || cleTemps(b) - cleTemps(a)
    || (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
  const tronque = toutes.length > MAX_MISSIONS;
  let missions = toutes;
  if (tronque) {
    const garder = new Set([...toutes].sort((a, b) => b.observe - a.observe).slice(0, MAX_MISSIONS));
    missions = toutes.filter((m) => garder.has(m));
  }

  const compteurs: Compteurs = { total: missions.length, a_arbitrer: 0, resultats: 0, en_cours: 0, autres: 0, bloquees: 0, anomalies: 0 };
  for (const m of missions) {
    compteurs[m.section]++;
    if (m.etat.code === "bloquee") compteurs.bloquees++;
    if (m.anomalies.length) compteurs.anomalies++;
  }
  return { maintenant, fuseau, missions, compteurs, tronque };
}

// ---------------------------------------------------------------------------------------------
// Route (branchée par une ligne dans api.ts)
// ---------------------------------------------------------------------------------------------

type Gestionnaire = (ctx: Ctx) => Promise<void>;

export function routesMissions(api: {
  espace: Espace;
  cfg?: { fuseau: string; techniques: Techniques };
  agents?: { demandes: Demandes };
}): [string, Gestionnaire][] {
  return [
    ["GET /api/missions", async (ctx) => {
      const cfg = api.cfg;
      // Intégration lots 1 et 3 : fuseau de Carnet et règles des fichiers des agents (fiche montrée, signalée).
      const r = calculerMissions(api.espace, cfg ? { fuseau: cfg.fuseau, estTechnique: (c) => estTechnique(cfg.techniques, c) } : {});
      // Intégration lot 3 : le statut montré d'une décision liée est son statut EFFECTIF (résultat attesté, « en
      // attente » si elle peut être prise) ; le statut écrit dans le fichier reste à part (`statut_declare`).
      if (api.agents) {
        for (const m of r.missions) {
          const d = m.decision;
          if (!d || !d.resolu || d.genre !== "page" || !d.chemin) continue;
          const p = api.espace.pages.get(d.chemin);
          if (!p?.fm || p.fm.type !== "decision") continue;
          try {
            const v = await api.agents.demandes.analyser(p.chemin, p.contenu, p.fm, p.titre);
            d.statut_declare = d.statut;
            d.statut = Demandes.statutEffectif(v);
          } catch { /* décision illisible : statut déclaré seulement */ }
        }
      }
      envoyerJson(ctx.req, ctx.res, 200, r);
    }],
  ];
}
