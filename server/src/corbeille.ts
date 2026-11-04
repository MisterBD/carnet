// Carnet · corbeille : `.corbeille/<id>/<chemin d'origine>` (X.md et/ou X/) + `.corbeille/<id>/.meta.json`.
// Le dossier `.corbeille/` est caché : jamais servi par /api/page ou /api/fichier, jamais listé dans l'arbre ni la
// recherche. Toute lecture ou écriture ici vérifie qu'on reste DANS l'élément (aucun lien symbolique suivi).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { titreDe } from "../../shared/navigation.ts";
import { feuille } from "../../shared/page.ts";
import type { Config } from "./config.ts";
import { lstatOuNull } from "./disque.ts";
import { ErreurHttp } from "./http.ts";
import { cheminPage } from "./securite.ts";

/** Identifiant d'un élément : `AAAAMMJJ-HHMMSS-<4 hexa>` (ou, pour les anciens, `AAAAMMJJ-HHMMSS[-k]`). */
export const RE_ID_CORBEILLE = /^\d{8}-\d{6}(?:-[0-9a-z]{1,12})?$/;
export const FICHIER_META = ".meta.json";
const MAX_META = 64 * 1024;
const MAX_PROFONDEUR = 32;

export interface MetaCorbeille {
  version: 1;
  chemin: string;
  titre: string;
  icone: string | null;
  date: string;
  sousPages: number;
  login: string;
}

export interface ElementCorbeille {
  id: string;
  /** Chemin d'origine de la page (« Démo/To-do.md »), ou "" s'il n'a pas pu être retrouvé. */
  chemin: string;
  /** Segments du chemin d'origine, validés (null : meta piégée ou chemin introuvable : pas restaurable). */
  segs: string[] | null;
  titre: string;
  icone: string | null;
  date: number;
  sousPages: number;
  /** La meta existe mais son chemin est refusé (traversée, caché, zone interdite…). */
  metaInvalide: boolean;
  /** Erreur de validation à renvoyer en cas de restauration. */
  erreur: ErreurHttp | null;
}

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

export function nouvelId(d = new Date()): string {
  const s = `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;
  return `${s}-${crypto.randomBytes(2).toString("hex")}`;
}

/** Date (ms, heure locale) d'un identifiant, ou null. */
export function dateDeId(id: string): number | null {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(id);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

export function racineCorbeille(cfg: Config): string {
  return path.join(cfg.espace, ".corbeille");
}

/** Crée `.corbeille/` au besoin ; refuse un lien symbolique ou un fichier à sa place. */
export async function assurerCorbeille(cfg: Config): Promise<string> {
  const r = racineCorbeille(cfg);
  try {
    await fsp.mkdir(r, { mode: 0o755 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  const st = await fsp.lstat(r);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ErreurHttp(500, "Corbeille inutilisable.", "corbeille");
  return r;
}

/** Racine de la corbeille si elle existe (vrai dossier), sinon null. */
async function racineExistante(cfg: Config): Promise<string | null> {
  const r = racineCorbeille(cfg);
  const st = await lstatOuNull(r);
  return st && st.isDirectory() && !st.isSymbolicLink() ? r : null;
}

/** Chemin disque d'un élément validé (id bien formé, vrai dossier sous `.corbeille/`). */
export async function cheminElement(cfg: Config, id: unknown): Promise<string> {
  if (typeof id !== "string" || !RE_ID_CORBEILLE.test(id)) throw new ErreurHttp(400, "Identifiant de corbeille invalide.", "id_invalide");
  const r = await racineExistante(cfg);
  if (!r) throw new ErreurHttp(404, "Élément introuvable dans la corbeille.", "introuvable");
  const abs = path.join(r, id);
  const st = await lstatOuNull(abs);
  if (!st) throw new ErreurHttp(404, "Élément introuvable dans la corbeille.", "introuvable");
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ErreurHttp(403, "Élément de corbeille refusé.", "element_refuse");
  return abs;
}

/** Vérifie que chaque dossier intermédiaire entre `base` et `abs` est un vrai dossier (aucun lien suivi). */
export async function verifierSansLien(base: string, segs: string[]): Promise<void> {
  let cur = base;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = path.join(cur, segs[i]);
    const st = await lstatOuNull(cur);
    if (!st) return;
    if (st.isSymbolicLink() || !st.isDirectory()) throw new ErreurHttp(403, "Élément de corbeille refusé (lien symbolique).", "lien_symbolique");
  }
}

/** Nombre de pages .md sous un dossier (borné, sans suivre de lien, sans fichiers cachés). */
export async function compterPages(abs: string, prof = 0, compte = { n: 0 }): Promise<number> {
  if (prof > MAX_PROFONDEUR || compte.n >= 10_000) return compte.n;
  let entrees: fs.Dirent[];
  try {
    entrees = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return compte.n;
  }
  for (const d of entrees) {
    if (d.name.startsWith(".")) continue;
    if (d.isDirectory()) await compterPages(path.join(abs, d.name), prof + 1, compte);
    else if (d.isFile() && d.name.endsWith(".md") && d.name.length > 3) compte.n++;
  }
  return compte.n;
}

/** Lit un petit fichier texte DANS `racine` (chemin réel vérifié, pas de lien en dernier composant). */
export async function lireTexteDans(racine: string, abs: string, max: number): Promise<string> {
  let reel: string;
  let racineReelle: string;
  try {
    reel = await fsp.realpath(abs);
    racineReelle = await fsp.realpath(racine);
  } catch {
    throw new ErreurHttp(404, "Introuvable.", "introuvable");
  }
  if (!reel.startsWith(racineReelle + path.sep)) throw new ErreurHttp(403, "Chemin interdit.", "hors_element");
  let fh: fsp.FileHandle;
  try {
    fh = await fsp.open(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ELOOP") throw new ErreurHttp(403, "Chemin interdit (lien symbolique).", "lien_symbolique");
    throw new ErreurHttp(404, "Introuvable.", "introuvable");
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new ErreurHttp(404, "Pas un fichier.", "pas_un_fichier");
    if (st.size > max) throw new ErreurHttp(413, "Fichier trop volumineux.", "trop_gros");
    return (await fh.readFile()).toString("utf8");
  } finally {
    await fh.close().catch(() => {});
  }
}

async function lireMeta(abs: string): Promise<Record<string, unknown> | null> {
  const f = path.join(abs, FICHIER_META);
  const st = await lstatOuNull(f);
  if (!st || !st.isFile() || st.size > MAX_META) return null;
  try {
    const v: unknown = JSON.parse(await lireTexteDans(abs, f, MAX_META));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/**
 * Ancien élément sans meta : on descend tant qu'il n'y a qu'un dossier ; à ce niveau, la page est X.md (de
 * préférence celle qui a un dossier X/ voisin), sinon le dossier X (page « dossier »).
 */
async function deduireChemin(abs: string): Promise<string[] | null> {
  const segs: string[] = [];
  let cur = abs;
  for (let prof = 0; prof < MAX_PROFONDEUR; prof++) {
    let entrees: fs.Dirent[];
    try {
      entrees = (await fsp.readdir(cur, { withFileTypes: true })).filter((d) => !d.name.startsWith("."));
    } catch {
      return null;
    }
    const dossiers = entrees.filter((d) => d.isDirectory());
    const pages = entrees.filter((d) => d.isFile() && d.name.endsWith(".md") && d.name.length > 3);
    if (!pages.length && dossiers.length === 1 && entrees.length === 1) {
      segs.push(dossiers[0].name.normalize("NFC"));
      cur = path.join(cur, dossiers[0].name);
      continue;
    }
    const noms = new Set(dossiers.map((d) => d.name));
    const page = pages.find((p) => noms.has(p.name.slice(0, -3))) ?? pages[0];
    if (page) return [...segs, page.name.normalize("NFC")];
    if (dossiers.length) return [...segs, dossiers[0].name.normalize("NFC") + ".md"];
    return null;
  }
  return null;
}

/** Décrit un élément : meta si elle existe (chemin revalidé), sinon déduction. */
export async function decrireElement(cfg: Config, id: string, abs: string): Promise<ElementCorbeille> {
  const meta = await lireMeta(abs);
  let segs: string[] | null = null;
  let metaInvalide = false;
  let erreur: ErreurHttp | null = null;
  if (meta && typeof meta.chemin === "string") {
    try {
      segs = cheminPage(cfg, meta.chemin);
    } catch (e) {
      metaInvalide = true;
      erreur = e instanceof ErreurHttp ? e : new ErreurHttp(400, "Chemin d'origine invalide.", "meta_invalide");
    }
  } else {
    const d = await deduireChemin(abs);
    if (d) {
      try {
        segs = cheminPage(cfg, d.join("/"));
      } catch (e) {
        erreur = e instanceof ErreurHttp ? e : null;
      }
    }
    if (!segs && !erreur) erreur = new ErreurHttp(404, "Contenu de l'élément introuvable.", "element_vide");
  }
  const chemin = segs ? segs.join("/") : "";
  let titre = meta && typeof meta.titre === "string" && meta.titre.trim() ? meta.titre.trim().slice(0, 500) : "";
  if (!titre && segs) {
    try {
      const contenu = await lireTexteDans(abs, path.join(abs, ...segs), 2 * 1024 * 1024);
      titre = titreDe(chemin, contenu).titre;
    } catch {
      titre = feuille(chemin);
    }
  }
  if (!titre) titre = chemin ? feuille(chemin) : id;
  const icone = meta && typeof meta.icone === "string" && meta.icone.trim() ? meta.icone.trim().slice(0, 64) : null;
  let date = meta && typeof meta.date === "string" ? Date.parse(meta.date) : NaN;
  if (!Number.isFinite(date)) date = dateDeId(id) ?? NaN;
  if (!Number.isFinite(date)) {
    try { date = (await fsp.lstat(abs)).mtimeMs; } catch { date = 0; }
  }
  let sousPages = meta && typeof meta.sousPages === "number" && Number.isInteger(meta.sousPages) && meta.sousPages >= 0 ? meta.sousPages : -1;
  if (sousPages < 0) {
    sousPages = 0;
    if (segs) {
      const dir = path.join(abs, ...segs.slice(0, -1), segs[segs.length - 1].slice(0, -3));
      const st = await lstatOuNull(dir);
      if (st && st.isDirectory() && !st.isSymbolicLink()) sousPages = await compterPages(dir);
    }
  }
  return { id, chemin, segs, titre, icone, date: Math.floor(date), sousPages, metaInvalide, erreur };
}

/** Tous les éléments (vrais dossiers à l'identifiant valide), plus récent d'abord. */
export async function listerCorbeille(cfg: Config): Promise<ElementCorbeille[]> {
  const r = await racineExistante(cfg);
  if (!r) return [];
  let entrees: fs.Dirent[];
  try {
    entrees = await fsp.readdir(r, { withFileTypes: true });
  } catch {
    return [];
  }
  const res: ElementCorbeille[] = [];
  for (const d of entrees) {
    if (!RE_ID_CORBEILLE.test(d.name) || !d.isDirectory()) continue;
    try {
      res.push(await decrireElement(cfg, d.name, path.join(r, d.name)));
    } catch { /* élément illisible : ignoré */ }
  }
  res.sort((a, b) => b.date - a.date || (a.id < b.id ? 1 : -1));
  return res;
}

/** Supprime définitivement un élément (dossier vérifié ; fs.rm ne suit pas les liens symboliques). */
export async function effacerElement(abs: string): Promise<void> {
  const st = await fsp.lstat(abs);
  if (st.isSymbolicLink() || !st.isDirectory()) throw new ErreurHttp(403, "Élément de corbeille refusé.", "element_refuse");
  await fsp.rm(abs, { recursive: true, force: true });
}
