// Carnet · artefacts : signature /_art (même jeton que deploy/art/app/art.py) et liste des artefacts.
import crypto from "node:crypto";
import fs from "node:fs";
import type { FileHandle } from "node:fs/promises";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { ErreurHttp } from "./http.ts";

/** Clé HMAC de 32 octets (64 caractères hexadécimaux), relue si le fichier change (comme art.py). */
export class Cle {
  chemin: string;
  #mtime = -1;
  #cle: Buffer | null = null;
  constructor(chemin: string) {
    this.chemin = chemin;
    this.valeur(); // échoue vite au démarrage
  }
  valeur(): Buffer {
    const st = fs.statSync(this.chemin);
    if (!this.#cle || st.mtimeMs !== this.#mtime) {
      const t = fs.readFileSync(this.chemin, "ascii").trim();
      if (!/^[0-9a-fA-F]{64}$/.test(t)) throw new Error("clé HMAC : 64 caractères hexadécimaux attendus (32 octets)");
      this.#cle = Buffer.from(t, "hex");
      this.#mtime = st.mtimeMs;
    }
    return this.#cle;
  }
}

/** base64url(HMAC-SHA256(clé, `${exp}/${portee}`)) sans « = » : identique à art.mac(). */
export function mac(cle: Buffer, exp: number, portee: string): string {
  return crypto.createHmac("sha256", cle).update(`${exp}/${portee}`, "utf8").digest("base64url");
}

/** « exp.hmac » avec exp = maintenant + ttl (secondes Unix) : identique à art.signer(). */
export function signer(cle: Buffer, portee: string, ttl: number, maintenant = Date.now() / 1000): string {
  const exp = Math.floor(maintenant) + ttl;
  return `${exp}.${mac(cle, exp, portee)}`;
}

/** urllib.parse.quote(s, safe="/") : tout sauf A-Z a-z 0-9 _ . - ~ et « / » est encodé en %XX (UTF-8). */
export function quotePy(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())
    .replace(/%2F/g, "/");
}

/** Port de art.segments_surs() : un seul décodage, mêmes refus. */
export function segmentsSurs(brut: string): string[] {
  if (brut.length > 1024) throw new ErreurHttp(403, "Chemin trop long.", "chemin_trop_long");
  let txt: string;
  try {
    txt = decodeURIComponent(brut);
  } catch {
    throw new ErreurHttp(403, "Encodage invalide.", "encodage_invalide");
  }
  if (/[\u0000-\u001f\u007f]/.test(txt) || txt.includes("\\")) throw new ErreurHttp(403, "Caractère interdit.", "caractere_interdit");
  const slashFinal = txt.endsWith("/");
  let segs = txt.split("/");
  if (slashFinal && txt !== "/") segs = segs.slice(0, -1);
  if (txt === "" || txt === "/") throw new ErreurHttp(404, "Introuvable.", "chemin_vide");
  if (segs.length > 16) throw new ErreurHttp(403, "Chemin trop profond.", "chemin_trop_profond");
  for (const s of segs) {
    if (s === "" || s.startsWith(".") || s.length > 255) throw new ErreurHttp(403, "Chemin interdit.", "segment_interdit");
  }
  return segs;
}

function dans(parent: string, enfant: string): boolean {
  return enfant === parent || enfant.startsWith(parent.replace(/\/+$/, "") + "/");
}

async function realpathOuNull(p: string): Promise<string | null> {
  try {
    return await fsp.realpath(p);
  } catch {
    return null;
  }
}

/** Dossier réel des artefacts (doit être dans l'espace). */
export async function racineArtefacts(cfg: Config): Promise<string> {
  const r = await realpathOuNull(path.join(cfg.espace, "artefacts"));
  if (!r || !dans(cfg.espace, r) || r === cfg.espace) throw new ErreurHttp(404, "Pas d'artefacts.", "pas_d_artefacts");
  return r;
}

/**
 * Port de art.ouvrir_fichier() : fichier régulier sous la racine, liens confinés au dossier de l'artefact (1er
 * segment), contrôle avant (realpath) et après ouverture (/proc/self/fd), dossier -> index.html.
 */
export async function verifierArtefact(racine: string, segsInit: string[]): Promise<{ st: fs.Stats; finaux: string[] }> {
  let segs = [...segsInit];
  for (let tour = 0; tour < 2; tour++) {
    const chemin = path.join(racine, ...segs);
    const reel = (await realpathOuNull(chemin)) ?? chemin;
    if (!dans(racine, reel)) throw new ErreurHttp(403, "Lien hors du dossier.", "lien_hors_dossier");
    const portee = (await realpathOuNull(path.join(racine, segs[0]))) ?? path.join(racine, segs[0]);
    if (!dans(racine, portee) || !dans(portee, reel)) throw new ErreurHttp(403, "Lien hors du dossier.", "lien_hors_dossier");
    let fh: FileHandle;
    try {
      fh = await fsp.open(chemin, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK | fs.constants.O_NOCTTY);
    } catch {
      throw new ErreurHttp(404, "Introuvable.", "introuvable");
    }
    try {
      const st = await fh.stat();
      let reelFd = reel;
      try { reelFd = await fsp.readlink(`/proc/self/fd/${fh.fd}`); } catch { /* /proc indisponible */ }
      if (!dans(racine, reelFd) || !dans(portee, reelFd)) throw new ErreurHttp(403, "Lien hors du dossier.", "lien_hors_dossier");
      if (st.isDirectory()) {
        if (segs[segs.length - 1] !== "index.html") { segs = [...segs, "index.html"]; continue; }
        throw new ErreurHttp(404, "Pas de listing.", "pas_de_listing");
      }
      if (!st.isFile()) throw new ErreurHttp(404, "Pas un fichier.", "pas_un_fichier");
      return { st, finaux: segs };
    } finally {
      await fh.close().catch(() => {});
    }
  }
  throw new ErreurHttp(404, "Introuvable.", "introuvable");
}

export const TAILLE_MAX_ARTEFACT = 5 * 1024 * 1024;

/** Calcule la redirection signée pour `/_art/<brut>` (brut = chemin encore encodé, relatif à artefacts/). */
export async function lienSigne(cfg: Config, cle: Cle, artBase: string, brut: string): Promise<{ location: string; chemin: string; jeton: string }> {
  const segs = segmentsSurs(brut);
  const racine = await racineArtefacts(cfg);
  const { st, finaux } = await verifierArtefact(racine, segs);
  if (st.size > TAILLE_MAX_ARTEFACT) throw new ErreurHttp(413, "Fichier trop volumineux.", "trop_gros");
  const jeton = signer(cle.valeur(), finaux[0], cfg.ttl);
  const chemin = finaux.join("/");
  return { location: `${artBase}/a/${jeton}/${quotePy(chemin)}`, chemin, jeton };
}

function decoderEntites(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#[0-9]+|amp|lt|gt|quot|apos|nbsp);/gi, (tout, e: string) => {
    const l = e.toLowerCase();
    if (l === "amp") return "&";
    if (l === "lt") return "<";
    if (l === "gt") return ">";
    if (l === "quot") return '"';
    if (l === "apos") return "'";
    if (l === "nbsp") return " ";
    const n = l.startsWith("#x") ? parseInt(l.slice(2), 16) : parseInt(l.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : tout;
  });
}

export interface ArtefactListe {
  chemin: string;
  titre: string;
  date: string | null;
}

/** Artefacts : dossiers non cachés de artefacts/ contenant un index.html régulier. Lecture du <title> seulement. */
export async function listerArtefacts(cfg: Config): Promise<ArtefactListe[]> {
  let racine: string;
  try {
    racine = await racineArtefacts(cfg);
  } catch {
    return [];
  }
  const out: ArtefactListe[] = [];
  let entrees: fs.Dirent[];
  try {
    entrees = await fsp.readdir(racine, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const d of entrees) {
    if (!d.isDirectory() || d.name.startsWith(".")) continue;
    const index = path.join(racine, d.name, "index.html");
    let st: fs.Stats;
    try {
      st = await fsp.lstat(index);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    let titre = d.name;
    try {
      const fh = await fsp.open(index, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        const tampon = Buffer.alloc(65536);
        const { bytesRead } = await fh.read(tampon, 0, tampon.length, 0);
        const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(tampon.subarray(0, bytesRead).toString("utf8"));
        const t = m ? decoderEntites(m[1]).replace(/\s+/g, " ").trim() : "";
        if (t) titre = t.slice(0, 200);
      } finally {
        await fh.close();
      }
    } catch { /* titre = nom du dossier */ }
    const date = /^(\d{4}-\d{2}-\d{2})/.exec(d.name);
    out.push({ chemin: `${d.name}/index.html`, titre, date: date ? date[1] : null });
  }
  out.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "") || a.chemin.localeCompare(b.chemin, "fr"));
  return out;
}
