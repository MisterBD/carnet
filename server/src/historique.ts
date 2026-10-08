// Carnet · historique des versions d'une page : git (LECTURE SEULE) + instantanés à la demande (hors de l'espace).
//
// Git n'est appelé que par execFile (jamais de shell, aucun texte interprété) avec un environnement assaini :
// pas de configuration système ni globale, pas d'invite, pas de verrou optionnel, chemins littéraux (aucune
// « magie » de pathspec), pas d'objets de remplacement. Seules deux commandes servent : `log` (liste) et
// `cat-file blob` (lecture), toujours limitées à un chemin de page validé de l'espace.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { nomDeFichier } from "../../shared/page.ts";
import type { Config } from "./config.ts";
import { ecrireAtomique, lstatOuNull } from "./disque.ts";
import { ErreurHttp, journal } from "./http.ts";

export const RE_HASH = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
export const RE_INSTANTANE = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})(-auto)?$/;
const MAX_SIMULTANES = 2;
const DELAI_MS = 5000;
const MAX_SORTIE = 10 * 1024 * 1024;
const CACHE_MS = 10_000;
const MAX_INSTANTANES = 100;

export interface CommitPage {
  hash: string;
  /** ms */
  date: number;
  auteur: string;
  message: string;
  /** Chemin du fichier dans le dépôt à ce commit (préfixe de l'espace compris). */
  chemin: string;
}

/** Décode un chemin cité à la manière de git (« "a\303\251" ») ; renvoie le texte tel quel sinon. */
export function deciter(s: string): string {
  if (!(s.length >= 2 && s.startsWith('"') && s.endsWith('"'))) return s;
  const octets: number[] = [];
  const interieur = s.slice(1, -1);
  for (let i = 0; i < interieur.length; i++) {
    const c = interieur[i];
    if (c !== "\\") {
      for (const o of Buffer.from(c, "utf8")) octets.push(o);
      continue;
    }
    const n = interieur[++i];
    if (n === undefined) break;
    if (/[0-7]/.test(n)) {
      const oct = interieur.slice(i, i + 3);
      octets.push(parseInt(oct, 8) & 0xff);
      i += oct.length - 1;
      continue;
    }
    const table: Record<string, number> = { n: 10, t: 9, r: 13, a: 7, b: 8, f: 12, v: 11, "\\": 92, '"': 34 };
    octets.push(table[n] ?? n.charCodeAt(0));
  }
  return Buffer.from(octets).toString("utf8");
}

export class Git {
  actif = false;
  /** Dossier de travail des commandes (racine du dépôt, ou l'espace avec GIT_DIR). */
  cwd = "";
  /** Chemin de l'espace dans le dépôt, avec « / » final, ou "". */
  prefixe = "";
  #env: NodeJS.ProcessEnv;
  #enCours = 0;
  #file: (() => void)[] = [];
  #cache = new Map<string, { t: number; liste: CommitPage[] }>();

  constructor(gitDir: string | null) {
    this.#env = {
      PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      HOME: os.tmpdir(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_LITERAL_PATHSPECS: "1",
      GIT_NO_REPLACE_OBJECTS: "1",
      GIT_PAGER: "cat",
      GIT_ASKPASS: "",
      ...(gitDir ? { GIT_DIR: gitDir } : {}),
    };
  }

  /** Détecte le dépôt (CARNET_GIT=auto), ou vérifie le dossier git fourni ; échec = git désactivé, sans erreur. */
  static async creer(cfg: Config): Promise<Git> {
    if (cfg.git === "non") return new Git(null);
    if (cfg.git === "auto") {
      const g = new Git(null);
      try {
        const out = (await g.#executer(["-C", cfg.espace, "rev-parse", "--show-toplevel", "--show-prefix"], cfg.espace)).toString("utf8");
        const lignes = out.split("\n");
        const haut = lignes[0]?.trim();
        if (!haut || !path.isAbsolute(haut)) throw new Error("racine introuvable");
        g.cwd = haut;
        g.prefixe = (lignes[1] ?? "").trim().replace(/^\/+/, "");
        if (g.prefixe && !g.prefixe.endsWith("/")) g.prefixe += "/";
        g.actif = true;
      } catch (e) {
        journal({ niveau: "info", quoi: "historique_git", etat: "désactivé", raison: String((e as Error).message).slice(0, 200) });
      }
      return g;
    }
    const g = new Git(cfg.git);
    try {
      await g.#executer(["rev-parse", "--git-dir"], cfg.espace);
      g.cwd = cfg.espace;
      g.prefixe = cfg.gitPrefixe ? cfg.gitPrefixe + "/" : "";
      g.actif = true;
    } catch (e) {
      journal({ niveau: "avertissement", quoi: "historique_git", etat: "désactivé", raison: String((e as Error).message).slice(0, 200) });
    }
    return g;
  }

  async #place(): Promise<void> {
    if (this.#enCours < MAX_SIMULTANES) { this.#enCours++; return; }
    await new Promise<void>((ok) => this.#file.push(ok));
    this.#enCours++;
  }

  #liberer(): void {
    this.#enCours--;
    const suivant = this.#file.shift();
    if (suivant) suivant();
  }

  async #executer(args: string[], cwd = this.cwd): Promise<Buffer> {
    await this.#place();
    try {
      return await new Promise<Buffer>((ok, ko) => {
        execFile("git", ["--no-pager", "-c", "color.ui=never", "-c", "log.showSignature=false", "-c", "core.quotepath=off", ...args], {
          cwd, env: this.#env, timeout: DELAI_MS, maxBuffer: MAX_SORTIE, encoding: "buffer", windowsHide: true, shell: false,
        }, (err, stdout, stderr) => {
          if (err) {
            const msg = Buffer.isBuffer(stderr) ? stderr.toString("utf8").trim().split("\n")[0] : "";
            ko(new Error(msg || err.message));
            return;
          }
          ok(stdout);
        });
      });
    } finally {
      this.#liberer();
    }
  }

  /** Commits qui touchent la page (renommages suivis), plus récent d'abord ; [] si la page n'est pas suivie. */
  async historique(cheminEspace: string, frais = false): Promise<CommitPage[]> {
    if (!this.actif) return [];
    const c = this.#cache.get(cheminEspace);
    if (!frais && c && Date.now() - c.t < CACHE_MS) return c.liste;
    const spec = this.prefixe + cheminEspace;
    let sortie: string;
    try {
      sortie = (await this.#executer([
        "log", "--follow", "--diff-filter=d", "--format=%x1e%H%x1f%at%x1f%an%x1f%s", "--name-only", "-n", "200", "--", spec,
      ])).toString("utf8");
    } catch (e) {
      journal({ niveau: "avertissement", quoi: "historique_git", erreur: String((e as Error).message).slice(0, 200) });
      return [];
    }
    const liste: CommitPage[] = [];
    let dernier = spec;
    for (const bloc of sortie.split("\x1e").slice(1)) {
      const lignes = bloc.split("\n");
      const [hash, at, auteur, ...reste] = (lignes[0] ?? "").split("\x1f");
      if (!hash || !RE_HASH.test(hash)) continue;
      const chemins = lignes.slice(1).filter((l) => l !== "").map(deciter);
      const chemin = (chemins[0] ?? dernier).normalize("NFC");
      dernier = chemin;
      const date = Number(at) * 1000;
      liste.push({ hash, date: Number.isFinite(date) ? date : 0, auteur: (auteur ?? "").slice(0, 200), message: reste.join("\x1f").slice(0, 500), chemin });
    }
    this.#cache.set(cheminEspace, { t: Date.now(), liste });
    if (this.#cache.size > 500) this.#cache.delete(this.#cache.keys().next().value!);
    return liste;
  }

  /** Contenu d'un fichier à un commit (hash et chemin déjà validés par l'appelant). */
  async lire(hash: string, cheminDepot: string): Promise<string> {
    if (!RE_HASH.test(hash)) throw new ErreurHttp(400, "Version invalide.", "version_invalide");
    try {
      return (await this.#executer(["cat-file", "blob", `${hash}:${cheminDepot}`])).toString("utf8");
    } catch {
      throw new ErreurHttp(404, "Version introuvable.", "version_introuvable");
    }
  }

  oublier(cheminEspace?: string): void {
    if (cheminEspace === undefined) this.#cache.clear();
    else this.#cache.delete(cheminEspace);
  }
}

// ---------------------------------------------------------------------------------------------
// Instantanés : copies complètes prises à la demande (ou juste avant une restauration), HORS de l'espace
// (`<CARNET_ETAT>/instantanes/<espace>/<chemin de la page>/<AAAAMMJJ-HHMMSS-mmm>[-auto].md`).
// ---------------------------------------------------------------------------------------------

export interface Instantane {
  id: string;
  stamp: string;
  date: number;
  auto: boolean;
}

function dateDeStamp(m: RegExpExecArray): number {
  return new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime();
}

function deux(n: number, l = 2): string {
  return String(n).padStart(l, "0");
}

export function stampDe(d: Date): string {
  return `${d.getFullYear()}${deux(d.getMonth() + 1)}${deux(d.getDate())}-${deux(d.getHours())}${deux(d.getMinutes())}${deux(d.getSeconds())}-${deux(d.getMilliseconds(), 3)}`;
}

export class Instantanes {
  #base: string;

  constructor(cfg: Config) {
    this.#base = path.join(cfg.etat, "instantanes", nomDeFichier(cfg.nomEspace));
  }

  #dossier(segs: string[]): string {
    return path.join(this.#base, ...segs);
  }

  async lister(segs: string[]): Promise<Instantane[]> {
    let noms: string[];
    try {
      noms = await fsp.readdir(this.#dossier(segs));
    } catch {
      return [];
    }
    const res: Instantane[] = [];
    for (const n of noms) {
      if (!n.endsWith(".md")) continue;
      const stamp = n.slice(0, -3);
      const m = RE_INSTANTANE.exec(stamp);
      if (!m) continue;
      res.push({ id: `inst:${stamp}`, stamp, date: dateDeStamp(m), auto: Boolean(m[8]) });
    }
    res.sort((a, b) => b.date - a.date || (a.stamp < b.stamp ? 1 : -1));
    return res;
  }

  async lire(segs: string[], stamp: string): Promise<{ contenu: string; date: number }> {
    const m = RE_INSTANTANE.exec(stamp);
    if (!m) throw new ErreurHttp(400, "Version invalide.", "version_invalide");
    const f = path.join(this.#dossier(segs), stamp + ".md");
    const st = await lstatOuNull(f);
    if (!st || !st.isFile()) throw new ErreurHttp(404, "Version introuvable.", "version_introuvable");
    const fh = await fsp.open(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    try {
      return { contenu: (await fh.readFile()).toString("utf8"), date: dateDeStamp(m) };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  /** Prend un instantané ; s'il est identique au dernier, rien n'est écrit (identique: true). */
  async creer(segs: string[], contenu: string, auto: boolean): Promise<Instantane & { identique: boolean }> {
    const existants = await this.lister(segs);
    if (existants.length) {
      const dernier = existants[0];
      try {
        const x = await this.lire(segs, dernier.stamp);
        if (x.contenu === contenu) return { ...dernier, identique: true };
      } catch { /* illisible : on en prend un nouveau */ }
    }
    const dossier = this.#dossier(segs);
    await fsp.mkdir(dossier, { recursive: true, mode: 0o700 });
    let t = Date.now();
    for (let k = 0; k < 50; k++, t++) {
      const stamp = stampDe(new Date(t)) + (auto ? "-auto" : "");
      try {
        await ecrireAtomique(path.join(dossier, stamp + ".md"), contenu, { exclusif: true, mode: 0o600 });
      } catch (e) {
        if (e instanceof ErreurHttp && e.raison === "existe") continue;
        throw e;
      }
      const m = RE_INSTANTANE.exec(stamp)!;
      await this.#elaguer(segs);
      return { id: `inst:${stamp}`, stamp, date: dateDeStamp(m), auto, identique: false };
    }
    throw new ErreurHttp(409, "Instantané impossible à nommer.", "conflit_nom");
  }

  async #elaguer(segs: string[]): Promise<void> {
    const l = await this.lister(segs);
    for (const x of l.slice(MAX_INSTANTANES)) {
      await fsp.unlink(path.join(this.#dossier(segs), x.stamp + ".md")).catch(() => {});
    }
  }

  /** La page `ancienNom` (nom logique sans .md) devient `nouveauNom` : ses instantanés et ceux des sous-pages suivent. */
  async deplacer(ancienNom: string, nouveauNom: string): Promise<void> {
    for (const [a, b] of [[ancienNom + ".md", nouveauNom + ".md"], [ancienNom, nouveauNom]]) {
      const src = path.join(this.#base, ...a.split("/"));
      const dst = path.join(this.#base, ...b.split("/"));
      try {
        const st = await lstatOuNull(src);
        if (!st || !st.isDirectory() || st.isSymbolicLink()) continue;
        if (await lstatOuNull(dst)) continue; // jamais d'écrasement
        await fsp.mkdir(path.dirname(dst), { recursive: true, mode: 0o700 });
        await fsp.rename(src, dst);
      } catch (e) {
        journal({ niveau: "avertissement", quoi: "instantanes", erreur: String((e as Error).message).slice(0, 200) });
      }
    }
  }
}
