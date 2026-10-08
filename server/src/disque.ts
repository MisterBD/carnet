// Carnet · accès disque : résolution confinée, lecture sûre, écriture atomique, verrou des mutations.
import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { ErreurHttp } from "./http.ts";
import { reelAutorise } from "./securite.ts";

export async function lstatOuNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fsp.lstat(p);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return null;
    throw e;
  }
}

/**
 * Chemin disque absolu d'un chemin logique (segments NFC). Si le chemin direct n'existe pas, cherche segment par
 * segment un nom du disque dont la forme NFC correspond (fichiers venus d'un Mac en NFD). Ne suit aucun lien.
 */
export async function resoudre(cfg: Config, segs: string[]): Promise<string> {
  const direct = path.join(cfg.espace, ...segs);
  if (await lstatOuNull(direct)) return direct;
  let cur = cfg.espace;
  for (let i = 0; i < segs.length; i++) {
    const cand = path.join(cur, segs[i]);
    if (await lstatOuNull(cand)) { cur = cand; continue; }
    let trouve: string | null = null;
    try {
      for (const n of await fsp.readdir(cur)) if (n.normalize("NFC") === segs[i]) { trouve = n; break; }
    } catch { /* dossier absent */ }
    if (trouve === null) return path.join(cur, ...segs.slice(i));
    cur = path.join(cur, trouve);
  }
  return cur;
}

const O_LECTURE = fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY;

/**
 * Ouvre en lecture un fichier de l'espace. Les liens symboliques sont suivis seulement si leur cible reste dans
 * l'espace et hors des zones interdites ; contrôle AVANT (realpath) et APRÈS l'ouverture (/proc/self/fd, anti-course).
 */
export async function ouvrirConfine(cfg: Config, abs: string): Promise<{ fh: FileHandle; st: fs.Stats; lien: boolean }> {
  let reel: string;
  try {
    reel = await fsp.realpath(abs);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw new ErreurHttp(404, "Introuvable.", "introuvable");
    throw e;
  }
  if (!reelAutorise(cfg, reel)) throw new ErreurHttp(403, "Chemin interdit (lien symbolique).", "lien_hors_zone");
  let fh: FileHandle;
  try {
    fh = await fsp.open(abs, O_LECTURE);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR" || code === "ELOOP") throw new ErreurHttp(404, "Introuvable.", "introuvable");
    throw e;
  }
  try {
    const st = await fh.stat();
    let reelFd = reel;
    try { reelFd = await fsp.readlink(`/proc/self/fd/${fh.fd}`); } catch { /* /proc indisponible */ }
    if (!reelAutorise(cfg, reelFd)) throw new ErreurHttp(403, "Chemin interdit (lien symbolique).", "lien_hors_zone");
    return { fh, st, lien: reelFd !== abs };
  } catch (e) {
    await fh.close().catch(() => {});
    throw e;
  }
}

/** Lit un fichier texte confiné (fichier régulier, au plus `max` octets). */
export async function lireConfine(cfg: Config, abs: string, max = 5 * 1024 * 1024): Promise<{ contenu: string; st: fs.Stats; lien: boolean }> {
  const { fh, st, lien } = await ouvrirConfine(cfg, abs);
  try {
    if (st.isDirectory()) throw new ErreurHttp(404, "C'est un dossier.", "dossier");
    if (!st.isFile()) throw new ErreurHttp(404, "Pas un fichier.", "pas_un_fichier");
    if (st.size > max) throw new ErreurHttp(413, "Fichier trop volumineux.", "trop_gros");
    const contenu = (await fh.readFile()).toString("utf8");
    return { contenu, st, lien };
  } finally {
    await fh.close().catch(() => {});
  }
}

/**
 * Vérifie qu'on peut écrire au chemin logique `segs` sans traverser de lien symbolique : chaque dossier parent
 * existant doit être un vrai dossier, la cible (si elle existe) ne doit pas être un lien. Renvoie le chemin disque
 * et le lstat de la cible (null si absente).
 */
export async function verifierEcriture(cfg: Config, segs: string[]): Promise<{ abs: string; st: fs.Stats | null }> {
  const abs = await resoudre(cfg, segs);
  const rel = path.relative(cfg.espace, abs).split(path.sep);
  let cur = cfg.espace;
  for (let i = 0; i < rel.length; i++) {
    cur = path.join(cur, rel[i]);
    const st = await lstatOuNull(cur);
    if (!st) return { abs, st: null };
    if (st.isSymbolicLink()) throw new ErreurHttp(403, "Modification refusée : lien symbolique (lecture seule).", "lien_symbolique");
    if (i < rel.length - 1 && !st.isDirectory()) throw new ErreurHttp(409, "Un fichier occupe la place d'un dossier.", "pas_un_dossier");
    if (i === rel.length - 1) return { abs, st };
  }
  return { abs, st: null };
}

/** Crée les dossiers manquants d'un chemin disque absolu (dans l'espace), sans jamais traverser de lien. */
export async function creerDossiers(cfg: Config, absDossier: string): Promise<boolean> {
  const rel = path.relative(cfg.espace, absDossier);
  if (rel === "") return false;
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new ErreurHttp(403, "Chemin interdit.", "hors_espace");
  let cur = cfg.espace;
  let cree = false;
  for (const s of rel.split(path.sep)) {
    cur = path.join(cur, s);
    try {
      await fsp.mkdir(cur, { mode: 0o755 });
      cree = true;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const st = await fsp.lstat(cur);
    if (st.isSymbolicLink()) throw new ErreurHttp(403, "Modification refusée : lien symbolique.", "lien_symbolique");
    if (!st.isDirectory()) throw new ErreurHttp(409, "Un fichier occupe la place d'un dossier.", "pas_un_dossier");
  }
  return cree;
}

export async function fsyncDossier(dossier: string): Promise<void> {
  let d: FileHandle | null = null;
  try {
    d = await fsp.open(dossier, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY);
    await d.sync();
  } catch { /* certains systèmes de fichiers refusent fsync sur un dossier */ } finally {
    await d?.close().catch(() => {});
  }
}

/**
 * Écriture atomique : fichier temporaire caché dans le même dossier (`.<nom>.carnet-<aléa>.tmp`), fsync, mêmes
 * permissions que l'original (sinon `mode`, 0644 par défaut), puis rename (ou link si `exclusif` : jamais
 * d'écrasement), puis fsync du dossier. La cible ne doit pas être un lien symbolique (vérifié par l'appelant).
 */
export async function ecrireAtomique(abs: string, donnees: string | Buffer, opts: { exclusif?: boolean; mode?: number } = {}): Promise<fs.Stats> {
  const dossier = path.dirname(abs);
  const nom = path.basename(abs);
  const tmp = path.join(dossier, `.${nom.slice(0, 200)}.carnet-${crypto.randomBytes(6).toString("hex")}.tmp`);
  let mode = opts.mode ?? 0o644;
  if (!opts.exclusif) {
    const st = await lstatOuNull(abs);
    if (st) {
      if (st.isSymbolicLink()) throw new ErreurHttp(403, "Modification refusée : lien symbolique.", "lien_symbolique");
      if (!st.isFile()) throw new ErreurHttp(409, "La cible n'est pas un fichier.", "pas_un_fichier");
      mode = st.mode & 0o7777;
    }
  }
  const fh = await fsp.open(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, mode);
  try {
    await fh.writeFile(donnees);
    await fh.chmod(mode);
    await fh.sync();
  } catch (e) {
    await fh.close().catch(() => {});
    await fsp.unlink(tmp).catch(() => {});
    throw e;
  }
  await fh.close();
  try {
    if (opts.exclusif) {
      await fsp.link(tmp, abs); // EEXIST si la cible existe déjà : pas d'écrasement
      await fsp.unlink(tmp);
    } else {
      await fsp.rename(tmp, abs);
    }
  } catch (e) {
    await fsp.unlink(tmp).catch(() => {});
    if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new ErreurHttp(409, "Existe déjà.", "existe");
    throw e;
  }
  await fsyncDossier(dossier);
  return await fsp.stat(abs);
}

/** File d'attente : les mutations (et le traitement des événements disque) passent une par une. */
export class Verrou {
  #file: Promise<unknown> = Promise.resolve();
  executer<T>(f: () => Promise<T>): Promise<T> {
    const r = this.#file.then(() => f());
    this.#file = r.then(() => undefined, () => undefined);
    return r;
  }
}

function deux(n: number): string {
  return String(n).padStart(2, "0");
}

/** « AAAAMMJJ-HHMMSS » en heure locale (TZ du processus). */
export function horodatage(d = new Date()): string {
  return `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}`;
}

export function etagDe(contenu: string | Buffer): string {
  return `"${crypto.createHash("sha256").update(contenu).digest("hex").slice(0, 16)}"`;
}
