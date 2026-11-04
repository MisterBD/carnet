// Carnet · ordre manuel de l'arbre : `.carnet/ordre.json` dans l'espace.
//
//   { "version": 1, "dossiers": { "": ["Démo", "Accueil"], "Démo": ["To-do", "Projets", "rapport.pdf"] } }
//
// Clé = dossier logique ("" = racine) ; valeurs = noms des entrées de ce dossier (nom de page sans « .md », qui vaut
// aussi pour son dossier de sous-pages ; nom complet pour un autre fichier). Écrit seulement par le glisser-déposer
// (et suivi par renommer / déplacer / dupliquer) : aucun fichier .md n'est réécrit pour ranger l'arbre (pas de bruit
// pour les agents). Le dossier `.carnet/` est caché : jamais servi, jamais listé, jamais surveillé.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import type { Config } from "./config.ts";
import { ecrireAtomique, lstatOuNull } from "./disque.ts";
import { ErreurHttp, journal } from "./http.ts";

const MAX_FICHIER = 1024 * 1024;
const MAX_NOMS = 5000;

function nomValide(n: unknown): n is string {
  return typeof n === "string" && n !== "" && n.length <= 255 && !n.includes("/") && !n.includes("\\")
    && !n.startsWith(".") && !/[\u0000-\u001f\u007f]/.test(n);
}

function dossierValide(d: string): boolean {
  if (d === "") return true;
  if (d.length > 1024) return false;
  return d.split("/").every(nomValide);
}

export class Ordres {
  #cfg: Config;
  #dossiers = new Map<string, string[]>();
  /** Empreinte disque du fichier lu (mtime, taille, inode) : relire seulement s'il a changé. */
  #cle = "";

  constructor(cfg: Config) {
    this.#cfg = cfg;
  }

  get #dossierCarnet(): string {
    return path.join(this.#cfg.espace, ".carnet");
  }

  get #fichier(): string {
    return path.join(this.#dossierCarnet, "ordre.json");
  }

  /** Ordre manuel d'un dossier logique, ou undefined. */
  liste(dossier: string): readonly string[] | undefined {
    return this.#dossiers.get(dossier);
  }

  get taille(): number {
    return this.#dossiers.size;
  }

  #vider(): boolean {
    const avait = this.#dossiers.size > 0;
    this.#dossiers.clear();
    this.#cle = "";
    return avait;
  }

  /** (Re)lit le fichier s'il a changé sur le disque. Renvoie true si l'ordre connu a changé. */
  async rafraichir(): Promise<boolean> {
    const stD = await lstatOuNull(this.#dossierCarnet);
    if (!stD || stD.isSymbolicLink() || !stD.isDirectory()) return this.#vider();
    const st = await lstatOuNull(this.#fichier);
    if (!st || st.isSymbolicLink() || !st.isFile()) return this.#vider();
    const cle = `${st.mtimeMs}:${st.size}:${st.ino}`;
    if (cle === this.#cle) return false;
    if (st.size > MAX_FICHIER) {
      journal({ niveau: "avertissement", quoi: "ordre", erreur: "ordre.json trop volumineux : ignoré" });
      this.#vider();
      this.#cle = cle;
      return true;
    }
    let brut: unknown;
    try {
      const fh = await fsp.open(this.#fichier, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
      try {
        brut = JSON.parse((await fh.readFile()).toString("utf8"));
      } finally {
        await fh.close().catch(() => {});
      }
    } catch (e) {
      journal({ niveau: "avertissement", quoi: "ordre", erreur: `ordre.json illisible : ${String((e as Error).message).slice(0, 200)}` });
      this.#vider();
      this.#cle = cle;
      return true;
    }
    const avant = JSON.stringify([...this.#dossiers]);
    this.#dossiers.clear();
    const d = brut && typeof brut === "object" ? (brut as { dossiers?: unknown }).dossiers : null;
    if (d && typeof d === "object" && !Array.isArray(d)) {
      for (const [k, v] of Object.entries(d as Record<string, unknown>)) {
        const cleD = k.normalize("NFC");
        if (!dossierValide(cleD) || !Array.isArray(v)) continue;
        const noms = [...new Set(v.filter(nomValide).map((n) => n.normalize("NFC")))].slice(0, MAX_NOMS);
        if (noms.length) this.#dossiers.set(cleD, noms);
      }
    }
    this.#cle = cle;
    return JSON.stringify([...this.#dossiers]) !== avant;
  }

  /** Pose l'ordre complet d'un dossier (liste vide : retire l'entrée). */
  poser(dossier: string, noms: string[]): void {
    if (!dossierValide(dossier)) throw new ErreurHttp(400, "Dossier invalide.", "dossier_invalide");
    const propres = [...new Set(noms.filter(nomValide))].slice(0, MAX_NOMS);
    if (propres.length) this.#dossiers.set(dossier, propres);
    else this.#dossiers.delete(dossier);
  }

  /** Une entrée change de nom dans son dossier (renommage). Renvoie true si l'ordre a changé. */
  renommerNom(dossier: string, ancien: string, nouveau: string): boolean {
    const l = this.#dossiers.get(dossier);
    if (!l || ancien === nouveau) return false;
    const i = l.indexOf(ancien);
    if (i === -1) return false;
    const n = l.filter((x) => x !== nouveau);
    n.splice(n.indexOf(ancien), 1, nouveau);
    this.#dossiers.set(dossier, n);
    return true;
  }

  /** Retire une entrée de la liste de son dossier. */
  retirer(dossier: string, nom: string): boolean {
    const l = this.#dossiers.get(dossier);
    if (!l || !l.includes(nom)) return false;
    const n = l.filter((x) => x !== nom);
    if (n.length) this.#dossiers.set(dossier, n);
    else this.#dossiers.delete(dossier);
    return true;
  }

  /** Insère `nom` juste après `reference` (si le dossier a un ordre manuel et contient la référence). */
  insererApres(dossier: string, reference: string, nom: string): boolean {
    const l = this.#dossiers.get(dossier);
    if (!l || !nomValide(nom)) return false;
    const n = l.filter((x) => x !== nom);
    const i = n.indexOf(reference);
    if (i === -1) n.push(nom);
    else n.splice(i + 1, 0, nom);
    this.#dossiers.set(dossier, n);
    return true;
  }

  /** Le dossier logique `ancien` (et tout ce qui est dessous) s'appelle désormais `nouveau`. */
  renommerPrefixe(ancien: string, nouveau: string): boolean {
    if (ancien === "" || ancien === nouveau) return false;
    let change = false;
    for (const [k, v] of [...this.#dossiers]) {
      let n: string | null = null;
      if (k === ancien) n = nouveau;
      else if (k.startsWith(ancien + "/")) n = nouveau + k.slice(ancien.length);
      if (n === null) continue;
      this.#dossiers.delete(k);
      if (dossierValide(n)) this.#dossiers.set(n, v);
      change = true;
    }
    return change;
  }

  /** Écrit le fichier (atomique). Le dossier `.carnet/` est créé au besoin ; un lien symbolique est refusé. */
  async enregistrer(): Promise<void> {
    try {
      await fsp.mkdir(this.#dossierCarnet, { mode: 0o755 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    const stD = await fsp.lstat(this.#dossierCarnet);
    if (stD.isSymbolicLink() || !stD.isDirectory()) throw new ErreurHttp(500, "Dossier .carnet inutilisable.", "carnet_dossier");
    const dossiers: Record<string, string[]> = {};
    for (const k of [...this.#dossiers.keys()].sort()) dossiers[k] = this.#dossiers.get(k)!;
    const st = await ecrireAtomique(this.#fichier, JSON.stringify({ version: 1, dossiers }, null, 1) + "\n");
    this.#cle = `${st.mtimeMs}:${st.size}:${st.ino}`;
  }
}
