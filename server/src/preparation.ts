// Carnet · « Dossier de rendez-vous » (lot 11).
//
// À partir d'une page dont le frontmatter a `sources` (une « fiche » client ou projet), assemble de façon DÉTERMINISTE
// quatre sections : décisions consignées, tâches ouvertes, notes récentes, livrables. Chaque extrait cite sa page source
// et la révision lue (etag court + date). Aucune IA, aucun résumé, aucun appel réseau : seulement l'index en mémoire de
// l'espace (lui-même confiné : ni fichiers cachés, ni zones masquées, ni liens symboliques sortants).
//
// Garanties :
//   - sources explicites seulement (pas d'exploration de l'espace) ; pas de suivi en cascade des `sources` d'une source ;
//   - une source introuvable est « manquante » ; une source masquée, technique, hors de l'espace ou trop volumineuse est
//     « non accessible » SANS lecture ni indice sur son contenu (même réponse qu'elle existe ou non) ; une URL n'est
//     jamais récupérée ;
//   - bornes : 50 entrées dans `sources`, 200 pages par dossier (un niveau, puis plus profond), 400 pages en tout,
//     50 missions, et des extraits courts en texte simple (jamais de HTML brut) ;
//   - même index + même instant = même résultat (ordre de tri explicite partout, empreinte calculée hors horodatage).
import crypto from "node:crypto";
import { dateDuJour, FUSEAU_DEFAUT, horodatageIso, nouvelIdentifiant } from "../../shared/identifiants.ts";
import { decouper, dossierDe, feuille, nomDeFichier, plier } from "../../shared/page.ts";
import { analyserTache, marquerCode } from "../../shared/taches.ts";
import type { Ctx } from "./api.ts";
import type { Config } from "./config.ts";
import { preuveDecision } from "./decisions.ts";
import type { PreuveDecision } from "./decisions.ts";
import type { Ecrivain } from "./ecriture.ts";
import { collateur, texte } from "./espace.ts";
import type { Espace, Page } from "./espace.ts";
import { chaine, envoyerJson, ErreurHttp, lireJson } from "./http.ts";
import { nettoyerLigne, texteApercu } from "./liens.ts";
import { cheminPage, zoneInterdite } from "./securite.ts";

// ---------------------------------------------------------------------------------------------
// Bornes
// ---------------------------------------------------------------------------------------------

export const BORNES = {
  entrees: 50,
  pagesDossier: 200,
  pagesTotal: 400,
  missions: 50,
  decisions: 50,
  taches: 150,
  tachesParPage: 60,
  notes: 30,
  livrables: 100,
  joursRecents: 30,
  extraitNote: 360,
  extraitDecision: 280,
  texteTache: 200,
  brut: 300,
};
const MAX_MD = 5 * 1024 * 1024;
const JOUR_MS = 24 * 3600 * 1000;
export const DOSSIER_PREPARATIONS = "Préparations";

// ---------------------------------------------------------------------------------------------
// Types (réponse de GET /api/preparation)
// ---------------------------------------------------------------------------------------------

export interface Revision {
  /** etag complet (sans guillemets). */
  etag: string;
  /** 8 premiers caractères, pour l'affichage. */
  court: string;
  /** Date de modification observée du fichier (ISO, fuseau de Carnet). */
  modifiee: string;
  mtime: number;
}

export interface RefPage {
  chemin: string;
  titre: string;
  revision: Revision;
}

export type EtatSource = "lue" | "dossier" | "introuvable" | "non_accessible" | "externe" | "ignoree";

export interface SourceDeclaree {
  /** Texte tel qu'écrit dans `sources` (borné) ; pour une mission rattachée, « mission : <titre> ». VIDE pour une source
   *  non accessible : ni titre ni chemin d'une zone masquée ou technique ne sont exposés. */
  brut: string;
  /** Nom lisible (dernier segment du lien) : source manquante, lien externe (hôte). */
  nom?: string;
  etat: EtatSource;
  /** Précision lisible : « masquée », « hors de l'espace », « fichier des agents », « la fiche elle-même »… */
  raison?: string;
  /** Page ou dossier résolu (jamais pour une source non accessible). */
  chemin?: string;
  /** Dossier : pages lues / pages trouvées. */
  pages?: number;
  total?: number;
  tronque?: boolean;
  /** Mission rattachée par son champ `client` (pas déclarée dans la fiche). */
  implicite?: boolean;
  /** Déjà lue par une autre entrée. */
  doublon?: boolean;
  /** Dossier : pages écartées (préparations conservées, fichiers des agents, pages de plus de 5 Mo). */
  exclues?: number;
}

export type OriginePage = "fiche" | "source" | "dossier" | "mission" | "decision" | "livrable";

export interface PageLue extends RefPage {
  origine: OriginePage;
}

export interface Decision {
  source: RefPage;
  /** Statut en attente (ou absent) et aucune attestation valide : « à confirmer », pas « prise ». */
  aConfirmer: boolean;
  id: string | null;
  /** Statut DÉCLARÉ dans le fichier (jamais une preuve). */
  statut: string | null;
  cree: string | null;
  demandePar: string | null;
  extrait: string;
  preuve: PreuveDecision | null;
}

export interface TacheOuverte {
  source: RefPage;
  /** Numéro de ligne (0 = première ligne du fichier). */
  ligne: number;
  texte: string;
  echeance: string | null;
  priorite: string | null;
  enCours: boolean;
  enRetard: boolean;
  anomalies: string[];
}

export interface Note {
  source: RefPage;
  extrait: string;
}

export interface Livrable {
  titre: string;
  etat: "present" | "absent" | "externe" | "non_accessible";
  /** Page (ou dossier) du livrable quand il est présent. */
  chemin?: string;
  dossier?: boolean;
  revision?: Revision;
  /** Lien externe, affiché sans jamais être récupéré (http/https seulement). */
  url?: string;
  /** Texte du lien tel qu'écrit (absent, non accessible, externe). */
  brut?: string;
  origine: "mission" | "type" | "etiquette";
  mission?: { chemin: string; titre: string; etat: string | null };
}

export interface Couverture {
  /** Entrées de `sources` prises en compte (après la borne). */
  declarees: number;
  /** Entrées au-delà de la borne, ignorées. */
  entreesIgnorees: number;
  /** Pages sources lues (sans la fiche). */
  lues: number;
  manquantes: number;
  nonAccessibles: number;
  externes: number;
  ignorees: number;
  /** Un dossier ou le total a été tronqué. */
  tronquee: boolean;
}

export interface Apercu {
  version: 1;
  fiche: RefPage;
  genere: string;
  /** sha256 du contenu assemblé (hors `genere`) : « Conserver » vérifie que l'aperçu vu est toujours exact. */
  empreinte: string;
  couverture: Couverture;
  sources: SourceDeclaree[];
  pages: PageLue[];
  decisions: Decision[];
  taches: TacheOuverte[];
  notes: Note[];
  livrables: Livrable[];
  /** Éléments au-delà des bornes, non affichés. */
  masques: { decisions: number; taches: number; notes: number; livrables: number; notesAnciennes: number };
}

export interface ContexteAssemblage {
  cfg: Config;
  espace: Espace;
  /** Instant de l'assemblage (ms) : seul élément variable, fixé par l'appelant (tests déterministes). */
  maintenant: number;
  fuseau?: string;
  /** Fichiers techniques (lot 3, CARNET_TECHNIQUES) : traités comme non accessibles. */
  technique?: (chemin: string) => boolean;
  /** Preuve d'une décision (socle : server/src/decisions.ts) ; null si inconnue. */
  preuve?: (page: Page) => Promise<PreuveDecision | null>;
}

// ---------------------------------------------------------------------------------------------
// Dates (fuseau explicite, jamais celui du processus)
// ---------------------------------------------------------------------------------------------

/** « 2026-10-11T08:12:03+02:00 » (fuseau de Carnet, jamais celui du processus). */
export function isoLocal(ms: number, fuseau = FUSEAU_DEFAUT): string {
  return horodatageIso(new Date(ms), fuseau);
}

// ---------------------------------------------------------------------------------------------
// Liens
// ---------------------------------------------------------------------------------------------

export type Cible =
  | { type: "page"; chemin: string }
  | { type: "dossier"; chemin: string }
  | { type: "introuvable" }
  | { type: "non_accessible"; raison: string }
  | { type: "externe"; url: string }
  | { type: "vide" };

interface LienAnalyse {
  cible: string;
  dossier: boolean;
  /** Lien Markdown ou chemin écrit : d'abord relatif à la page, puis depuis la racine. */
  relatifDabord: boolean;
}

const RE_CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;
const RE_URL = /^[a-z][a-z0-9+.-]*:/i;

/** Texte d'une entrée (`"[[x]]"`, ou `[[x]]` non guillemeté que YAML lit comme [["x"]]), sinon null. */
export function texteEntree(v: unknown): string | null {
  if (typeof v === "string") return v;
  // YAML : `- [[Clients/A]]` sans guillemets = liste dans une liste ; Obsidian l'écrit souvent ainsi.
  if (Array.isArray(v) && v.length === 1 && Array.isArray(v[0]) && v[0].length === 1 && typeof v[0][0] === "string") return `[[${v[0][0]}]]`;
  return null;
}

function analyserLien(brut: string): LienAnalyse | { externe: string } | null {
  let s = brut.trim();
  let relatifDabord = false;
  const w = /^!?\[\[([^\[\]\n]*)\]\]$/.exec(s);
  const md = /^!?\[[^\]\n]*\]\(\s*(<[^<>\n]*>|[^\s()]*)(?:\s+"[^"\n]*")?\s*\)$/.exec(s);
  if (w) {
    s = w[1].split("|")[0];
    s = s.split("#")[0];
  } else if (md) {
    s = md[1].startsWith("<") ? md[1].slice(1, -1) : md[1];
    if (RE_URL.test(s) || s.startsWith("//")) return { externe: s };
    s = s.split(/[?#]/)[0];
    try { s = decodeURIComponent(s); } catch { /* garder tel quel */ }
    relatifDabord = true;
  } else {
    if (RE_URL.test(s) || s.startsWith("//")) return { externe: s };
    relatifDabord = s.startsWith("./") || s.startsWith("../");
  }
  s = s.normalize("NFC").trim();
  if (!s) return null;
  const dossier = s.endsWith("/");
  s = s.replace(/\/+$/, "");
  if (/\.md$/i.test(s)) s = s.slice(0, -3);
  return { cible: s, dossier, relatifDabord };
}

/**
 * Résout un lien vers une page ou un dossier de l'espace, depuis la page `depuis`, comme l'interface :
 * chemin exact, relatif au dossier de la page, puis nom unique (style Obsidian). Rien n'est lu sur le disque.
 */
export class Resolveur {
  #espace: Espace;
  #cfg: Config;
  #technique?: (chemin: string) => boolean;
  #parSuffixe: Map<string, string[]> | null = null;

  constructor(cfg: Config, espace: Espace, technique?: (chemin: string) => boolean) {
    this.#cfg = cfg;
    this.#espace = espace;
    this.#technique = technique;
  }

  #suffixes(): Map<string, string[]> {
    if (this.#parSuffixe) return this.#parSuffixe;
    const m = new Map<string, string[]>();
    for (const p of this.#espace.pagesVisibles()) {
      const segs = p.chemin.slice(0, -3).split("/");
      for (let i = 1; i < segs.length; i++) {
        const k = segs.slice(i).join("/");
        const l = m.get(k);
        if (l) l.push(p.chemin);
        else m.set(k, [p.chemin]);
      }
    }
    this.#parSuffixe = m;
    return m;
  }

  /** Candidat → page ou dossier visible, « interdit » (zone ou segment refusé), ou null. */
  #essayer(c: string, dossierSeul: boolean): Cible | "interdit" | null {
    const segs = c.split("/");
    if (segs.some((x) => x === "" || x === "." || x === ".." || x.startsWith(".") || Buffer.byteLength(x) > 255)) return "interdit";
    if (zoneInterdite(this.#cfg, segs) || zoneInterdite(this.#cfg, [...segs.slice(0, -1), segs[segs.length - 1] + ".md"])) return "interdit";
    if (segs.includes("_assets")) return "interdit";
    if (!dossierSeul) {
      const p = this.#espace.pages.get(c + ".md");
      if (p && !this.#espace.estAlias(p)) return { type: "page", chemin: p.chemin };
      if (p && p.alias) return { type: "page", chemin: p.alias };
    }
    if (this.#espace.dossiers.has(c)) return { type: "dossier", chemin: c };
    return null;
  }

  resoudre(brut: string, depuis: string): Cible {
    if (brut.length > 1024 || RE_CONTROLE.test(brut) || brut.includes("\\")) return { type: "non_accessible", raison: "chemin refusé" };
    const a = analyserLien(brut);
    if (a === null) return { type: "vide" };
    if ("externe" in a) return { type: "externe", url: a.externe };
    const t = a.cible;
    const segsT = t.split("/");
    // un segment caché écrit dans le lien (« .git/config ») est refusé d'emblée, sans regarder s'il existe
    if (segsT.some((x) => x.startsWith(".") && x !== "." && x !== "..")) return { type: "non_accessible", raison: "masquée" };
    const candidats: string[] = [];
    let horsEspace = false;
    const candidat = (c: string | null) => { if (c === null) horsEspace = true; else if (c) candidats.push(c); };
    const ici = dossierDe(depuis);
    if (t.startsWith("/")) candidat(normaliser("", t));
    else if (a.relatifDabord) {
      // lien Markdown : relatif à la page, puis depuis la racine (chemin « le plus court » d'Obsidian)
      candidat(normaliser(ici, t));
      if (!t.startsWith(".")) candidat(normaliser("", t));
    } else {
      // wikilien : chemin exact depuis la racine, puis relatif au dossier de la page
      if (!segsT.includes("..")) candidat(normaliser("", t));
      candidat(normaliser(ici, t));
    }
    let interdit = false;
    for (const c of [...new Set(candidats)]) {
      const r = this.#essayer(c, a.dossier);
      if (r === "interdit") { interdit = true; continue; }
      if (r) return this.#filtrer(r);
    }
    // nom unique (« [[Compte rendu 03-10]] » où qu'il soit) : pages seulement
    if (!a.dossier && !t.startsWith("/") && !segsT.includes("..") && !segsT.includes(".")) {
      const l = this.#suffixes().get(t);
      if (l && l.length === 1) return this.#filtrer({ type: "page", chemin: l[0] });
    }
    if (interdit) return { type: "non_accessible", raison: "masquée" };
    if (horsEspace) return { type: "non_accessible", raison: "hors de l'espace" };
    return { type: "introuvable" };
  }

  #filtrer(r: Cible): Cible {
    if (r.type === "page") {
      if (this.#technique && this.#technique(r.chemin)) return { type: "non_accessible", raison: "fichier des agents" };
      const p = this.#espace.pages.get(r.chemin);
      if (p && p.taille > MAX_MD) return { type: "non_accessible", raison: "trop volumineuse" };
    }
    if (r.type === "dossier" && this.#technique && this.#technique(r.chemin + "/")) return { type: "non_accessible", raison: "fichier des agents" };
    return r;
  }
}

/** Chemin relatif (« ../x/y ») depuis un dossier, sans décodage ni coupure sur « # » ou « ? » ; null s'il sort de l'espace. */
function normaliser(dossier: string, rel: string): string | null {
  const base = rel.startsWith("/") ? [] : (dossier ? dossier.split("/") : []);
  for (const seg of rel.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!base.length) return null; base.pop(); continue; }
    base.push(seg);
  }
  return base.join("/");
}

// ---------------------------------------------------------------------------------------------
// Lecture des pages
// ---------------------------------------------------------------------------------------------

function etagNu(etag: string): string {
  return etag.replace(/^W\//, "").replace(/"/g, "");
}

export function revisionDe(p: Page, fuseau: string): Revision {
  const e = etagNu(p.etag);
  return { etag: e, court: e.slice(0, 8), modifiee: isoLocal(p.mtime, fuseau), mtime: p.mtime };
}

function typeDe(p: Page): string | null {
  const t = p.fm ? texte(p.fm.type) : null;
  return t ? plier(t).trim() : null;
}

function texteBorne(v: unknown, max = 200): string | null {
  const t = texte(v);
  if (t === null) return null;
  const s = t.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  return s ? (s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s) : null;
}

function brutBorne(s: string): string {
  const x = s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return x.length > BORNES.brut ? x.slice(0, BORNES.brut - 1) + "…" : x;
}

function listeDe(v: unknown): unknown[] {
  if (v === undefined || v === null) return [];
  if (Array.isArray(v)) {
    // `[[A]]` seul (non guillemeté) : liste d'une liste, c'est UNE entrée
    if (texteEntree(v) !== null && !(typeof v[0] === "string")) return [v];
    return v;
  }
  return [v];
}

function aEtiquette(p: Page, etiquette: string): boolean {
  return p.tags.some((t) => plier(t) === etiquette);
}

/** Lignes du corps hors frontmatter : indice de la première ligne après le frontmatter. */
function premiereLigneCorps(p: Page): number {
  const d = decouper(p.contenu);
  if (!d.frontmatter) return 0;
  return d.frontmatter.split("\n").length - (d.frontmatter.endsWith("\n") ? 1 : 0);
}

// ---------------------------------------------------------------------------------------------
// Tâches (format Obsidian Tasks, lecture tolérante)
// ---------------------------------------------------------------------------------------------

const RANG_PRIORITE: Record<string, number> = { "plus-haute": 0, haute: 1, moyenne: 2, basse: 4, "plus-basse": 5 };

// ---------------------------------------------------------------------------------------------
// Extraits (texte simple, borné, jamais de HTML)
// ---------------------------------------------------------------------------------------------

function corpsDe(p: Page): string {
  return p.contenu.slice(p.debutCorps);
}

/** Section `## <titre>` (niveau 1 ou 2) d'un corps, sans son titre ; null si absente. */
function section(corps: string, titres: string[]): string | null {
  const lignes = corps.split("\n");
  const code = marquerCode(lignes);
  let debut = -1;
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const m = /^ {0,3}(#{1,2})[ \t]+(.*?)[ \t#]*\r?$/.exec(lignes[i]);
    if (!m) continue;
    if (debut !== -1) return lignes.slice(debut, i).join("\n");
    if (titres.includes(plier(m[2]).trim())) debut = i + 1;
  }
  return debut === -1 ? null : lignes.slice(debut).join("\n");
}

const RE_LIGNE_TACHE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[.\]/u;
const RE_DEBUT_BLOC = /^(#{1,6}\s|[-*+]\s|\d{1,9}[.)]\s|>|\||`{3,}|~{3,}|---|\*\*\*|___)/;
const ENTITES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'" };

/**
 * Retire les commentaires HTML (`<!-- … -->`, chacun remplacé par une espace), en temps LINÉAIRE. Même résultat que
 * `replace(/<!--[\s\S]*?-->/g, " ")`, mais cette expression paresseuse est quadratique sur une page pleine de `<!--` non
 * fermés (un agent trompé pourrait bloquer le serveur). Un commentaire non fermé reste tel quel, comme avec l'expression.
 */
export function sansCommentairesHtml(s: string): string {
  let sortie = "";
  let i = 0;
  for (;;) {
    const debut = s.indexOf("<!--", i);
    if (debut === -1) break;
    const fin = s.indexOf("-->", debut + 4);
    if (fin === -1) break; // aucun « --> » après ce « <!-- » : aucun commentaire plus loin non plus
    sortie += s.slice(i, debut) + " ";
    i = fin + 3;
  }
  return sortie + s.slice(i);
}

/** Texte simple d'un passage : sans HTML (balises et commentaires retirés), sans code, sans tâches (déjà dans leur section). */
export function extrait(corps: string, max: number): string {
  const lignes = sansCommentairesHtml(corps).split("\n");
  const code = marquerCode(lignes);
  const garde = lignes.map((l, i) => (code[i] || RE_LIGNE_TACHE.test(l) ? "" : l.replace(/<\/?[A-Za-z][^<>]*>/g, "").replace(/\r$/, "")));
  // retours à la ligne « doux » d'un paragraphe (texte coupé à 120 colonnes) : recollés, pour un extrait lisible
  const fusion: string[] = [];
  for (const l of garde) {
    const t = l.trim();
    const prec = fusion.length ? fusion[fusion.length - 1] : "";
    if (t && prec.trim() && !RE_DEBUT_BLOC.test(t) && !/^\s*(#{1,6}\s|\|)/.test(prec)) fusion[fusion.length - 1] = prec.trimEnd() + " " + t;
    else fusion.push(l);
  }
  return texteApercu(fusion.join("\n"), max)
    .replace(/&(amp|lt|gt|quot|apos|nbsp|#39);/g, (_t, n: string) => ENTITES[n] ?? _t)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ---------------------------------------------------------------------------------------------
// Assemblage
// ---------------------------------------------------------------------------------------------

interface Lu {
  page: Page;
  origine: OriginePage;
  rang: number;
}

/** Fiche : page + liste brute des `sources` (422 explicites si absente ou YAML illisible). */
export function lireFiche(espace: Espace, chemin: string): { page: Page; entrees: unknown[] } {
  const page = espace.pages.get(chemin);
  if (!page) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
  const d = decouper(page.contenu);
  if (d.yaml.trim() && page.fm === null) throw new ErreurHttp(422, "Le frontmatter de cette page est illisible (YAML invalide) : ses sources ne peuvent pas être lues.", "yaml_invalide", { raison: "yaml_invalide" });
  const v = page.fm ? page.fm.sources : undefined;
  if (v === undefined || v === null) throw new ErreurHttp(422, "Cette page n'a pas de sources (propriété « sources » du frontmatter).", "sans_sources", { raison: "sans_sources" });
  return { page, entrees: listeDe(v) };
}

export async function assembler(ctx: ContexteAssemblage, cheminFiche: string): Promise<Apercu> {
  const fuseau = ctx.fuseau ?? FUSEAU_DEFAUT;
  const { espace } = ctx;
  const { page: fiche, entrees: brutes } = lireFiche(espace, cheminFiche);
  const res = new Resolveur(ctx.cfg, espace, ctx.technique);
  const lus = new Map<string, Lu>();
  const sources: SourceDeclaree[] = [];
  let tronquee = false;
  const ref = (p: Page): RefPage => ({ chemin: p.chemin, titre: p.titre, revision: revisionDe(p, fuseau) });
  const ajouter = (p: Page, origine: OriginePage): "ajoutee" | "deja" | "plein" => {
    if (lus.has(p.chemin)) return "deja";
    if (lus.size >= BORNES.pagesTotal + 1) { tronquee = true; return "plein"; }
    lus.set(p.chemin, { page: p, origine, rang: lus.size });
    return "ajoutee";
  };
  ajouter(fiche, "fiche");

  const entrees = brutes.slice(0, BORNES.entrees);
  const entreesIgnorees = Math.max(0, brutes.length - BORNES.entrees);
  for (const v of entrees) {
    const t = texteEntree(v);
    if (t === null) { sources.push({ brut: brutBorne(JSON.stringify(v) ?? String(v)), etat: "ignoree", raison: "entrée illisible (texte attendu)" }); continue; }
    const s: SourceDeclaree = { brut: brutBorne(t), etat: "introuvable" };
    sources.push(s);
    const c = res.resoudre(t, fiche.chemin);
    if (c.type === "vide") { s.etat = "ignoree"; s.raison = "entrée vide"; continue; }
    if (c.type === "externe") { s.etat = "externe"; s.raison = "lien externe, jamais récupéré"; s.nom = hoteDe(c.url); continue; }
    if (c.type === "non_accessible") { s.etat = "non_accessible"; s.raison = c.raison; s.brut = ""; continue; }
    if (c.type === "introuvable") { s.raison = "introuvable"; s.nom = titreDeLien(t); continue; }
    if (c.type === "page") {
      s.chemin = c.chemin;
      const p = espace.pages.get(c.chemin)!;
      if (p.chemin === fiche.chemin) { s.etat = "ignoree"; s.raison = "la fiche elle-même"; continue; }
      if (typeDe(p) === "preparation") { s.etat = "ignoree"; s.raison = "préparation conservée"; continue; }
      const r = ajouter(p, "source");
      s.etat = r === "plein" ? "ignoree" : "lue";
      if (r === "deja") s.doublon = true;
      if (r === "plein") s.raison = "limite de pages atteinte";
      continue;
    }
    // dossier : ses pages, un niveau puis plus profond, ordre stable, borné
    s.etat = "dossier";
    s.chemin = c.chemin;
    const prefixe = c.chemin + "/";
    const candidates = espace.pagesVisibles()
      .filter((p) => p.chemin.startsWith(prefixe))
      .map((p) => ({ p, prof: p.chemin.split("/").length }))
      .sort((a, b) => a.prof - b.prof || collateur.compare(a.p.chemin, b.p.chemin) || (a.p.chemin < b.p.chemin ? -1 : a.p.chemin > b.p.chemin ? 1 : 0));
    let n = 0;
    let total = 0;
    let exclues = 0;
    for (const { p } of candidates) {
      if (p.chemin === fiche.chemin) continue;
      // lot 6 : une page archivée d'un dossier source n'est pas reprise (une source nommée explicitement, si)
      if (typeDe(p) === "preparation" || (ctx.technique && ctx.technique(p.chemin)) || p.taille > MAX_MD || espace.archivee(p)) { exclues++; continue; }
      total++;
      if (n >= BORNES.pagesDossier) { tronquee = true; continue; }
      if (ajouter(p, "dossier") === "plein") continue;
      n++;
    }
    s.pages = n;
    s.total = total;
    if (exclues) s.exclues = exclues;
    if (total > n) s.tronque = true;
    if (total === 0) s.raison = "dossier sans page";
  }

  // Missions : celles des sources, puis celles qui se rattachent à la fiche par `client`
  const missions: Page[] = [];
  for (const l of lus.values()) if (typeDe(l.page) === "mission") missions.push(l.page);
  const rattachees = espace.pagesCourantes() // lot 6 : sans missions archivées
    .filter((p) => typeDe(p) === "mission" && !lus.has(p.chemin) && p.fm && p.fm.client !== undefined)
    .sort((a, b) => collateur.compare(a.chemin, b.chemin) || (a.chemin < b.chemin ? -1 : 1));
  for (const p of rattachees) {
    if (missions.length >= BORNES.missions) break;
    const cl = texteEntree(p.fm!.client);
    if (cl === null) continue;
    const c = res.resoudre(cl, p.chemin);
    if (c.type !== "page" || c.chemin !== fiche.chemin) continue;
    if (ajouter(p, "mission") !== "ajoutee") continue;
    missions.push(p);
    sources.push({ brut: brutBorne(`mission : ${p.titre}`), etat: "lue", chemin: p.chemin, implicite: true, raison: "mission rattachée à cette fiche (champ client)" });
  }
  missions.splice(BORNES.missions);

  // Livrables (missions d'abord, dans l'ordre), et décisions attendues par les missions
  const livrables: Livrable[] = [];
  const cheminsLivrables = new Set<string>();
  for (const m of missions) {
    const fm = m.fm ?? {};
    const etatMission = texteBorne(fm.etat, 60);
    const mission = { chemin: m.chemin, titre: m.titre, etat: etatMission };
    const dec = texteEntree(fm.decision);
    if (dec !== null) {
      const c = res.resoudre(dec, m.chemin);
      if (c.type === "page") {
        const p = espace.pages.get(c.chemin)!;
        if (typeDe(p) === "decision") ajouter(p, "decision");
      }
    }
    const liste = listeDe(fm.livrables);
    let n = 0;
    for (const v of liste) {
      const t = texteEntree(v);
      if (t === null) continue;
      n++;
      const c = res.resoudre(t, m.chemin);
      if (c.type === "page") {
        const p = espace.pages.get(c.chemin)!;
        if (cheminsLivrables.has(p.chemin)) continue;
        cheminsLivrables.add(p.chemin);
        if (p.chemin !== fiche.chemin) ajouter(p, "livrable");
        livrables.push({ titre: p.titre, etat: "present", chemin: p.chemin, revision: revisionDe(p, fuseau), origine: "mission", mission });
      } else if (c.type === "dossier") {
        livrables.push({ titre: feuille(c.chemin), etat: "present", chemin: c.chemin, dossier: true, origine: "mission", mission });
      } else if (c.type === "externe") {
        const url = /^https?:\/\//i.test(c.url) ? c.url.slice(0, 2000) : undefined;
        livrables.push({ titre: brutBorne(t), etat: "externe", ...(url ? { url } : {}), brut: brutBorne(t), origine: "mission", mission });
      } else if (c.type === "non_accessible") {
        livrables.push({ titre: "Livrable non accessible", etat: "non_accessible", origine: "mission", mission });
      } else if (c.type === "introuvable") {
        livrables.push({ titre: titreDeLien(t), etat: "absent", brut: brutBorne(t), origine: "mission", mission });
      }
    }
    if (n === 0 && etatMission !== null && plier(etatMission).startsWith("terminee")) {
      livrables.push({ titre: "Aucun livrable déclaré", etat: "absent", origine: "mission", mission });
    }
  }
  for (const l of lus.values()) {
    const p = l.page;
    if (l.origine === "fiche" || cheminsLivrables.has(p.chemin)) continue;
    const parType = typeDe(p) === "livrable";
    if (!parType && !aEtiquette(p, "livrable")) continue;
    cheminsLivrables.add(p.chemin);
    livrables.push({ titre: p.titre, etat: "present", chemin: p.chemin, revision: revisionDe(p, fuseau), origine: parType ? "type" : "etiquette" });
  }

  // Ordre des pages lues : celui de la fiche (rang d'insertion)
  const ordre = [...lus.values()].sort((a, b) => a.rang - b.rang);
  const pages: PageLue[] = ordre.map((l) => ({ ...ref(l.page), origine: l.origine }));

  // Décisions
  const toutesDecisions: Decision[] = [];
  for (const l of ordre) {
    const p = l.page;
    if (typeDe(p) !== "decision") continue;
    const fm = p.fm ?? {};
    const corps = corpsDe(p);
    const sec = section(corps, ["decision"]) ?? section(corps, ["proposition"]) ?? corps;
    const statut = texteBorne(fm.statut, 60);
    const preuve = ctx.preuve ? await ctx.preuve(p) : null;
    toutesDecisions.push({
      source: ref(p), aConfirmer: decisionAConfirmer(statut, preuve), id: texteBorne(fm.id, 80), statut, cree: texteBorne(fm.cree, 40),
      demandePar: texteBorne(fm.demande_par, 80), extrait: extrait(sec, BORNES.extraitDecision), preuve,
    });
  }
  toutesDecisions.sort((a, b) => {
    const da = a.cree ?? a.source.revision.modifiee;
    const db = b.cree ?? b.source.revision.modifiee;
    return da < db ? 1 : da > db ? -1 : (a.source.chemin < b.source.chemin ? -1 : a.source.chemin > b.source.chemin ? 1 : 0);
  });
  const decisions = toutesDecisions.slice(0, BORNES.decisions);

  // Tâches ouvertes
  const aujourdHui = dateDuJour(fuseau, new Date(ctx.maintenant));
  const toutesTaches: (TacheOuverte & { rang: number })[] = [];
  for (const l of ordre) {
    const p = l.page;
    if (typeDe(p) === "decision") continue;
    const lignes = p.contenu.split("\n");
    const code = marquerCode(lignes);
    let n = 0;
    for (let i = premiereLigneCorps(p); i < lignes.length && n < BORNES.tachesParPage; i++) {
      if (code[i]) continue;
      const t = analyserTache(lignes[i]);
      if (!t) continue;
      // ouvertes : « [ ] » et « [/] » (en cours, statut Obsidian Tasks) ; ni faites, ni annulées, ni autres statuts
      if (t.coche !== " " && t.coche !== "/") continue;
      if (t.annulee !== undefined) continue;
      n++;
      const echeance = t.echeance ?? null;
      toutesTaches.push({
        source: ref(p), ligne: i, texte: nettoyerLigne(t.texte, BORNES.texteTache) || "(tâche sans texte)", echeance, priorite: t.priorite ?? null,
        enCours: t.coche === "/", enRetard: echeance !== null && echeance < aujourdHui, anomalies: t.anomalies.slice(0, 3).map((x) => x.slice(0, 120)), rang: l.rang,
      });
    }
  }
  toutesTaches.sort((a, b) => {
    if (a.echeance !== b.echeance) {
      if (a.echeance === null) return 1;
      if (b.echeance === null) return -1;
      return a.echeance < b.echeance ? -1 : 1;
    }
    const pa = a.priorite ? RANG_PRIORITE[a.priorite] : 3;
    const pb = b.priorite ? RANG_PRIORITE[b.priorite] : 3;
    return pa - pb || a.rang - b.rang || a.ligne - b.ligne;
  });
  const taches = toutesTaches.slice(0, BORNES.taches).map(({ rang: _r, ...t }) => t);

  // Notes récentes : pages lues modifiées depuis 30 jours (ni la fiche, ni décisions, ni livrables)
  const seuil = ctx.maintenant - BORNES.joursRecents * JOUR_MS;
  const candidatesNotes = ordre.filter((l) => l.origine !== "fiche" && typeDe(l.page) !== "decision" && !cheminsLivrables.has(l.page.chemin));
  const recentes = candidatesNotes.filter((l) => l.page.mtime >= seuil)
    .sort((a, b) => b.page.mtime - a.page.mtime || (a.page.chemin < b.page.chemin ? -1 : a.page.chemin > b.page.chemin ? 1 : 0));
  const notes: Note[] = recentes.slice(0, BORNES.notes).map((l) => ({ source: ref(l.page), extrait: extrait(corpsDe(l.page), BORNES.extraitNote) }));

  const couverture: Couverture = {
    declarees: entrees.length,
    entreesIgnorees,
    lues: pages.filter((p) => p.origine !== "fiche").length,
    manquantes: sources.filter((s) => s.etat === "introuvable").length,
    nonAccessibles: sources.filter((s) => s.etat === "non_accessible").length,
    externes: sources.filter((s) => s.etat === "externe").length,
    ignorees: sources.filter((s) => s.etat === "ignoree").length,
    tronquee: tronquee || sources.some((s) => s.tronque === true),
  };
  const contenu = {
    version: 1 as const, fiche: ref(fiche), couverture, sources, pages, decisions, taches, notes, livrables: livrables.slice(0, BORNES.livrables),
    masques: {
      decisions: toutesDecisions.length - decisions.length, taches: toutesTaches.length - taches.length,
      notes: recentes.length - notes.length, livrables: Math.max(0, livrables.length - BORNES.livrables),
      notesAnciennes: candidatesNotes.length - recentes.length,
    },
  };
  const empreinte = "sha256:" + crypto.createHash("sha256").update(JSON.stringify(contenu)).digest("hex");
  return { ...contenu, genere: isoLocal(ctx.maintenant, fuseau), empreinte };
}

function hoteDe(url: string): string {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#\s]+)/i.exec(url);
  return brutBorne(m ? m[1] : url).slice(0, 80);
}

const RE_EN_ATTENTE = /^(en attente|a confirmer|a valider|a arbitrer|a decider|proposee?|demandee?|en cours)\b/;

/** Décision encore ouverte : statut en attente (ou absent) et pas d'attestation valide. */
export function decisionAConfirmer(statut: string | null, preuve: PreuveDecision | null): boolean {
  if (preuve && preuve.etat === "valide") return false;
  return statut === null || RE_EN_ATTENTE.test(plier(statut).trim());
}

function titreDeLien(t: string): string {
  const a = analyserLien(t);
  if (!a || "externe" in a) return brutBorne(t);
  const w = /^!?\[\[[^|\]]*\|([^\]]+)\]\]$/.exec(t.trim());
  return brutBorne(w ? w[1] : feuille(a.cible) || t);
}

// ---------------------------------------------------------------------------------------------
// Préparation conservée : Markdown (nouvelle page, jamais réécrite) et relecture
// ---------------------------------------------------------------------------------------------

/** Lien [[…]] vers une page depuis `Préparations/` (chemin complet) ; lien Markdown si le nom contient [ ] | #. */
export function lienPage(chemin: string, titre?: string): string {
  const nom = chemin.replace(/\.md$/i, "");
  const alias = titre ? aliasSur(titre) : "";
  if (!/[\[\]|#^]/.test(nom)) return alias && alias !== feuille(nom) ? `[[${nom}|${alias}]]` : `[[${nom}]]`;
  const rel = "../" + chemin.split("/").map((s) => encodeURIComponent(s).replace(/[()]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())).join("/");
  return `[${echapperMd(alias || feuille(nom))}](${rel})`;
}

function aliasSur(t: string): string {
  return t.replace(/[\[\]|#^\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim().slice(0, 120);
}

/** Texte non fiable → Markdown inerte (pas de lien, pas de HTML, pas de structure). */
export function echapperMd(s: string): string {
  return s
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[\\`*_[\]<>|~=$]/g, (c) => "\\" + c)
    .replace(/&(?=#?[A-Za-z0-9]+;)/g, "\\&")
    .replace(/^(#+|[+\-])(?=\s|$)/, "\\$1")
    .replace(/^(\d+)([.)])(?=\s|$)/, "$1\\$2")
    .replace(/^!/, "\\!");
}

/** Texte tel qu'écrit dans un fichier, en code en ligne : jamais un lien ni de la mise en forme (même pour l'éditeur). */
export function codeEnLigne(s: string): string {
  const t = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  const plus = Math.max(0, ...[...t.matchAll(/`+/g)].map((m) => m[0].length));
  const f = "`".repeat(plus + 1);
  return /^`|`$/.test(t) ? `${f} ${t} ${f}` : `${f}${t}${f}`;
}

const fmtDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`;
const fmtHeure = (iso: string) => `${iso.slice(11, 13)}h${iso.slice(14, 16)}`;

function rev(r: Revision): string {
  return `rév. \`${r.court}\` · modifiée le ${fmtDate(r.modifiee)}`;
}

function citation(texteBrut: string): string[] {
  const lignes = texteBrut.split("\n").map((l) => l.trim()).filter(Boolean).slice(0, 8);
  return lignes.map((l) => `  > ${echapperMd(l)}`);
}

function yamlChaine(s: string): string {
  return JSON.stringify(s.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, " "));
}

function libelleCouverture(c: Couverture): string {
  const morceaux = [`${c.lues} ${c.lues > 1 ? "sources lues" : "source lue"}`];
  if (c.manquantes) morceaux.push(`${c.manquantes} ${c.manquantes > 1 ? "manquantes" : "manquante"}`);
  if (c.nonAccessibles) morceaux.push(`${c.nonAccessibles} non ${c.nonAccessibles > 1 ? "accessibles" : "accessible"}`);
  if (c.externes) morceaux.push(`${c.externes} ${c.externes > 1 ? "liens externes non récupérés" : "lien externe non récupéré"}`);
  if (c.tronquee) morceaux.push("liste tronquée");
  return morceaux.join(", ");
}
export { libelleCouverture };

/** Le concret d'abord : « Contrat signé introuvable · une autre source inaccessible » ; sinon « 7 sources lues ». */
export function resumeCouverture(a: Apercu): string {
  const c = a.couverture;
  const noms = a.sources.filter((s) => s.etat === "introuvable").map((s) => s.nom || s.brut);
  const m: string[] = [];
  if (noms.length) m.push(`${noms.slice(0, 2).join(", ")}${noms.length > 2 ? ` et ${noms.length - 2} autres` : ""} introuvable${noms.length > 1 ? "s" : ""}`);
  if (c.nonAccessibles) {
    const autre = noms.length ? (c.nonAccessibles > 1 ? `${c.nonAccessibles} autres sources inaccessibles` : "une autre source inaccessible")
      : (c.nonAccessibles > 1 ? `${c.nonAccessibles} sources inaccessibles` : "une source inaccessible");
    m.push(autre);
  }
  if (c.tronquee) m.push("liste tronquée");
  if (!m.length) return `${c.lues} ${c.lues > 1 ? "sources lues" : "source lue"}`;
  return m.join(" · ");
}

/** Nom (sans .md) de la préparation : « AAAA-MM-JJ HHhMM <titre de la fiche> ». */
export function nomPreparation(a: Apercu): string {
  return nomDeFichier(`${a.genere.slice(0, 10)} ${fmtHeure(a.genere)} ${a.fiche.titre}`);
}

/** Markdown de la préparation conservée. */
export function rendreMarkdown(a: Apercu, id: string): string {
  const L: string[] = ["---", "type: preparation", `id: ${id}`, `fiche: ${yamlChaine(`[[${a.fiche.chemin.replace(/\.md$/i, "")}]]`)}`, `cree: ${a.genere}`, `empreinte: ${yamlChaine(a.empreinte)}`];
  L.push("sources_utilisees:");
  for (const p of a.pages) {
    L.push(`  - { page: ${yamlChaine(`[[${p.chemin.replace(/\.md$/i, "")}]]`)}, revision: ${yamlChaine(p.revision.etag)}, modifiee: ${p.revision.modifiee}, origine: ${p.origine} }`);
  }
  const manquantes = a.sources.filter((s) => s.etat === "introuvable").map((s) => s.brut);
  L.push(manquantes.length ? "sources_manquantes:" : "sources_manquantes: []");
  for (const m of manquantes) L.push(`  - ${yamlChaine(m)}`);
  L.push(`sources_non_accessibles: ${a.couverture.nonAccessibles}`);
  if (a.couverture.externes) L.push(`sources_externes: ${a.couverture.externes}`);
  if (a.couverture.tronquee) L.push("tronquee: true");
  L.push(`resume: ${yamlChaine(`Photographie du ${fmtDate(a.genere)} à ${fmtHeure(a.genere)} · ${resumeCouverture(a)}`)}`);
  L.push("---");
  L.push(`# Préparation — ${aliasSur(a.fiche.titre) || "fiche"}`);
  const decision = (d: Decision) => {
    const etat = d.aConfirmer ? "validation attendue" : d.statut ? echapperMd(d.statut) : "statut non renseigné";
    const preuve = d.preuve?.etat === "valide" ? (d.preuve.geste === "cle-d-acces" ? " · geste prouvé" : " · attestée") : d.aConfirmer ? "" : " · non attestée";
    L.push(`- ${lienPage(d.source.chemin, d.source.titre)} · ${etat}${preuve} · ${fmtDate(d.source.revision.modifiee)}`);
    L.push(...citation(d.extrait));
  };
  const aConfirmer = a.decisions.filter((d) => d.aConfirmer);
  const prises = a.decisions.filter((d) => !d.aConfirmer);
  L.push("", "## Décisions à confirmer", "");
  if (!aConfirmer.length) L.push("Aucune décision en attente dans les sources.");
  aConfirmer.forEach(decision);
  L.push("", "## Décisions prises", "");
  if (!prises.length) L.push("Aucune décision prise dans les sources.");
  prises.forEach(decision);
  if (a.masques.decisions) L.push("", `*${a.masques.decisions} autres décisions non reprises (limite).*`);

  L.push("", "## Tâches ouvertes", "");
  if (!a.taches.length) L.push("Aucune tâche ouverte dans les sources.");
  for (const t of a.taches) {
    const morceaux = [`- ☐ ${echapperMd(t.texte)}`];
    if (t.enCours) morceaux.push("en cours");
    if (t.echeance) morceaux.push(`échéance ${fmtDate(t.echeance)}${t.enRetard ? " (dépassée)" : ""}`);
    if (t.priorite) morceaux.push(`priorité ${t.priorite}`);
    morceaux.push(`${lienPage(t.source.chemin, t.source.titre)}`);
    L.push(morceaux.join(" · "));
  }
  if (a.masques.taches) L.push("", `*${a.masques.taches} autres tâches non reprises (limite).*`);

  L.push("", `## Notes récentes`, "");
  if (!a.notes.length) L.push(`Aucune source modifiée depuis ${BORNES.joursRecents} jours.`);
  for (const n of a.notes) {
    L.push(`- ${lienPage(n.source.chemin, n.source.titre)} · ${fmtDate(n.source.revision.modifiee)}`);
    L.push(...citation(n.extrait));
  }
  if (a.masques.notesAnciennes) {
    const n = a.masques.notesAnciennes;
    L.push("", `*${n} ${n > 1 ? "sources plus anciennes" : "source plus ancienne"} (plus de ${BORNES.joursRecents} jours) non ${n > 1 ? "reprises" : "reprise"}.*`);
  }

  L.push("", "## Livrables", "");
  if (!a.livrables.length) L.push("Aucun livrable dans les sources.");
  for (const l of a.livrables) {
    const m = l.mission ? ` · mission ${lienPage(l.mission.chemin, l.mission.titre)}${l.mission.etat ? ` (${echapperMd(l.mission.etat)}, déclaré)` : ""}` : "";
    if (l.etat === "present" && l.chemin) L.push(`- ${lienPage(l.dossier ? l.chemin + ".md" : l.chemin, l.titre)}${l.revision ? ` · ${fmtDate(l.revision.modifiee)}` : ""}${m}`);
    else if (l.etat === "externe") L.push(`- Lien externe non vérifié : ${codeEnLigne(l.brut ?? "")}${m}`);
    else if (l.etat === "non_accessible") L.push(`- Livrable non accessible${m}`);
    else L.push(`- Livrable absent : ${l.brut ? codeEnLigne(l.brut) : echapperMd(l.titre)}${m}`);
  }
  // traçabilité repliée (forme « aérée » des repliables de l'éditeur) : origine, couverture, révisions lues
  L.push("", "<details>", "<summary>Sources et traçabilité</summary>", "");
  L.push(`Assemblée sans IA le ${fmtDate(a.genere)} à ${fmtHeure(a.genere)} depuis ${lienPage(a.fiche.chemin, a.fiche.titre)} : ${libelleCouverture(a.couverture)}. Chaque extrait renvoie à sa page ; voici la révision lue de chacune. Si une source change ensuite, cette page l'indique (« À rafraîchir ») et n'est jamais réécrite.`, "");
  for (const p of a.pages) L.push(`- ${lienPage(p.chemin, p.titre)} · ${rev(p.revision)} à ${fmtHeure(p.revision.modifiee)}`);
  for (const s of a.sources) {
    if (s.etat === "introuvable") L.push(`- Introuvable : ${codeEnLigne(s.brut)}`);
    else if (s.etat === "externe") L.push(`- Lien externe, jamais récupéré : ${codeEnLigne(s.brut)}`);
  }
  if (a.couverture.nonAccessibles) {
    const n = a.couverture.nonAccessibles;
    L.push(`- ${n} ${n > 1 ? "sources non accessibles" : "source non accessible"} (zone masquée ou réservée : ni titre ni chemin repris)`);
  }
  L.push("", "</details>", "");
  return L.join("\n");
}

// ---------------------------------------------------------------------------------------------
// « À rafraîchir » d'une préparation conservée (calculé, jamais écrit)
// ---------------------------------------------------------------------------------------------

export interface Changement {
  chemin: string;
  titre: string;
  /** modifiée ; disparue (page supprimée) ; retirée (n'est plus une source de la fiche) ; nouvelle source. */
  etat: "modifiee" | "disparue" | "retiree" | "nouvelle";
}

export interface EtatPreparation {
  fiche: string | null;
  ficheExiste: boolean;
  cree: string | null;
  sources: number;
  aRafraichir: boolean;
  changements: Changement[];
}

function cheminDeLien(v: unknown): string | null {
  const t = texteEntree(v);
  if (t === null) return null;
  const m = /^\[\[([^\[\]|#\n]+)(?:[|#][^\]\n]*)?\]\]$/.exec(t.trim());
  if (!m) return null;
  const c = m[1].normalize("NFC").replace(/^\/+/, "");
  return c ? c + ".md" : null;
}

/** État d'une page `type: preparation` : null si ce n'en est pas une. */
export async function etatPreparation(ctx: ContexteAssemblage, page: Page): Promise<EtatPreparation | null> {
  if (typeDe(page) !== "preparation" || !page.fm) return null;
  const fm = page.fm;
  const ficheChemin = cheminDeLien(fm.fiche);
  const enregistrees = new Map<string, string>();
  for (const e of Array.isArray(fm.sources_utilisees) ? fm.sources_utilisees.slice(0, BORNES.pagesTotal + 1) : []) {
    if (!e || typeof e !== "object") continue;
    const o = e as Record<string, unknown>;
    const c = cheminDeLien(o.page);
    const r = texte(o.revision);
    if (c && r) enregistrees.set(c, etagNu(r));
  }
  const changements: Changement[] = [];
  let ficheExiste = false;
  let actuelles: Map<string, Page> | null = null;
  if (ficheChemin && ctx.espace.pages.has(ficheChemin)) {
    ficheExiste = true;
    try {
      const a = await assembler({ ...ctx, preuve: undefined }, ficheChemin);
      actuelles = new Map(a.pages.map((p) => [p.chemin, ctx.espace.pages.get(p.chemin)!]));
    } catch { /* la fiche n'a plus de sources : on compare page par page */ }
  }
  for (const [c, r] of enregistrees) {
    const p = ctx.espace.pages.get(c);
    if (!p) { changements.push({ chemin: c, titre: feuille(c), etat: "disparue" }); continue; }
    if (actuelles && !actuelles.has(c)) { changements.push({ chemin: c, titre: p.titre, etat: "retiree" }); continue; }
    if (etagNu(p.etag) !== r) changements.push({ chemin: c, titre: p.titre, etat: "modifiee" });
  }
  if (actuelles) {
    for (const [c, p] of actuelles) if (!enregistrees.has(c)) changements.push({ chemin: c, titre: p.titre, etat: "nouvelle" });
  }
  changements.sort((a, b) => (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0));
  return {
    fiche: ficheChemin, ficheExiste, cree: texteBorne(fm.cree, 40), sources: enregistrees.size,
    aRafraichir: changements.length > 0, changements: changements.slice(0, 50),
  };
}

// ---------------------------------------------------------------------------------------------
// Routes : GET /api/preparation, GET /api/preparation/etat, POST /api/preparation/conserver
// ---------------------------------------------------------------------------------------------

const RE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const RE_EMPREINTE = /^sha256:[0-9a-f]{64}$/;
/** Durée de validité d'un aperçu pour « Conserver » (au-delà : régénérer). */
const VALIDITE_APERCU_MS = 24 * 3600 * 1000;

export class Preparations {
  cfg: Config;
  espace: Espace;
  ecrivain: Ecrivain;
  /** Fichiers techniques (lot 3) : à brancher à l'intégration (`(chemin) => estTechnique(regles, chemin)`). */
  technique?: (chemin: string) => boolean;

  constructor(cfg: Config, espace: Espace, ecrivain: Ecrivain) {
    this.cfg = cfg;
    this.espace = espace;
    this.ecrivain = ecrivain;
  }

  contexte(maintenant = Date.now()): ContexteAssemblage {
    return {
      cfg: this.cfg, espace: this.espace, maintenant, fuseau: this.cfg.fuseau, technique: this.technique,
      preuve: (p) => preuveDecision(this.ecrivain.attestations, p.contenu),
    };
  }

  /** Aperçu (rien n'est écrit). */
  async apercu(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    envoyerJson(ctx.req, ctx.res, 200, await assembler(this.contexte(), segs.join("/")));
  }

  /** « À rafraîchir » d'une préparation conservée (calculé, jamais écrit). */
  async etat(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const p = this.espace.pages.get(segs.join("/"));
    if (!p) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
    const e = await etatPreparation(this.contexte(), p);
    if (!e) throw new ErreurHttp(422, "Cette page n'est pas une préparation (type: preparation).", "pas_une_preparation", { raison: "pas_une_preparation" });
    envoyerJson(ctx.req, ctx.res, 200, e);
  }

  /** Pour GET /api/page : état d'une page `type: preparation` de l'index (null sinon). */
  async etatDePage(chemin: string): Promise<EtatPreparation | null> {
    const p = this.espace.pages.get(chemin);
    if (!p || typeDe(p) !== "preparation") return null;
    return etatPreparation(this.contexte(), p);
  }

  /**
   * Conserver : NOUVELLE page `Préparations/AAAA-MM-JJ HHhMM <fiche>.md` (création exclusive, jamais d'écrasement).
   * Corps : {chemin, empreinte, genere} de l'aperçu vu ; en-tête X-Carnet-Requete obligatoire (idempotence : un renvoi
   * rend le même résultat, `rejoue: true`). L'aperçu est réassemblé à l'instant `genere` : si son empreinte a changé
   * (une source a bougé), 409 `apercu_perime` avec le nouvel aperçu, rien n'est écrit.
   */
  async conserver(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 64 * 1024);
    const segs = cheminPage(this.cfg, corps.chemin);
    const empreinte = chaine(corps.empreinte, "empreinte", 100);
    if (!RE_EMPREINTE.test(empreinte)) throw new ErreurHttp(400, "Champ « empreinte » invalide.", "champ_invalide");
    const genere = chaine(corps.genere, "genere", 40);
    const t = RE_ISO.test(genere) ? Date.parse(genere) : NaN;
    if (!Number.isFinite(t)) throw new ErreurHttp(400, "Champ « genere » invalide (horodatage ISO de l'aperçu).", "champ_invalide");
    const v = ctx.req.headers["x-carnet-requete"];
    const requete = typeof v === "string" ? v.trim() : "";
    if (!requete) throw new ErreurHttp(400, "En-tête X-Carnet-Requete obligatoire (un identifiant par geste « Conserver »).", "requete_absente", { raison: "requete_absente" });
    const maintenant = Date.now();
    const chemin = segs.join("/");
    const r = await this.ecrivain.verrou.executer(async () => {
      const a = await assembler(this.contexte(t), chemin);
      const perime = a.empreinte !== empreinte || t > maintenant + 5 * 60_000 || maintenant - t > VALIDITE_APERCU_MS;
      const id = nouvelIdentifiant("prep", this.cfg.fuseau, new Date(t));
      return this.ecrivain.creerUniqueSousVerrou({
        dossier: [DOSSIER_PREPARATIONS], base: nomPreparation(a), action: "preparation", requete,
        operation: { fiche: chemin, empreinte, genere },
        // appelé seulement si ce n'est pas un renvoi : un aperçu périmé n'écrit rien
        transformer: () => {
          if (perime) throw new ErreurHttp(409, "Les sources ont changé depuis cet aperçu (ou il est trop ancien) : vérifie le nouvel aperçu avant de le conserver.", "apercu_perime", { raison: "apercu_perime" });
          return rendreMarkdown(a, id);
        },
      }, ctx.login);
    });
    envoyerJson(ctx.req, ctx.res, r.rejoue ? 200 : 201, { chemin: r.chemin, etag: r.etag, rejoue: r.rejoue });
  }
}
