// Carnet · index en mémoire de l'espace (pages, fichiers visibles, dossiers), arbre, recherche, surveillance du disque.
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import YAML from "yaml";
import { decouper, feuille, dossierDe, plier } from "../../shared/page.ts";
import type { Config } from "./config.ts";
import { etagDe, lireConfine, lstatOuNull, resoudre } from "./disque.ts";
import type { Verrou } from "./disque.ts";
import { journal } from "./http.ts";
import { analyser, extraitCorps } from "./markdown.ts";
import { Ordres } from "./ordre.ts";
import type { Tache } from "./markdown.ts";
import { extension, fichierVisible, reelAutorise, relatifReel, zoneInterdite } from "./securite.ts";

export interface Page {
  chemin: string;
  nom: string;
  titre: string;
  icone: string | null;
  ordre: number | null;
  resume: string | null;
  statut: string | null;
  tags: string[];
  fm: Record<string, unknown> | null;
  mtime: number;
  taille: number;
  etag: string;
  /** Empreinte disque (mtime fin, ctime, taille, inode) : relire seulement si elle change. */
  cle: string;
  contenu: string;
  /** Début du corps (après frontmatter et bloc titre) dans `contenu`. */
  debutCorps: number;
  lien: boolean;
  /** Lien symbolique vers une autre page de l'espace (ex. CLAUDE.md -> AGENTS.md) : chemin de la cible, sinon null. */
  alias: string | null;
  taches: Tache[];
  mention: boolean;
  pTitre: string;
  pNom: string;
  pCorps: string;
  pFm: string;
}

export interface Fichier {
  chemin: string;
  nom: string;
  ext: string;
  mtime: number;
  taille: number;
  lien: boolean;
}

export interface Noeud {
  chemin: string;
  nom: string;
  titre: string;
  icone: string | null;
  existe: boolean;
  type: "page" | "fichier";
  ext?: string;
  enfants: Noeud[];
  mtime: number;
  resume?: string;
  lectureSeule?: boolean;
}

export interface Changements {
  /** chemin -> nouvel etag (contenu modifié d'une page déjà connue). */
  modifs: Map<string, string>;
  arbre: boolean;
}

interface Vus {
  pages: Set<string>;
  fichiers: Set<string>;
  dossiers: Set<string>;
}

const MAX_MD = 5 * 1024 * 1024;
const MAX_PROFONDEUR = 32;
export const collateur = new Intl.Collator("fr", { numeric: true, sensitivity: "base" });

export function nouveauxChangements(): Changements {
  return { modifs: new Map(), arbre: false };
}

function vide(): Vus {
  return { pages: new Set(), fichiers: new Set(), dossiers: new Set() };
}

export function lireFrontmatter(yaml: string): Record<string, unknown> | null {
  if (!yaml.trim()) return null;
  try {
    // parseDocument : les erreurs restent dans doc.errors (YAML.parse + logLevel « silent » les ignorerait)
    const doc = YAML.parseDocument(yaml, { uniqueKeys: false, prettyErrors: false });
    if (doc.errors.length) return null;
    const v: unknown = doc.toJS({ maxAliasCount: 50 });
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Valeur scalaire en texte (chaîne, nombre, booléen, date), sinon null. */
export function texte(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean" || typeof v === "bigint") return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

function listeTags(v: unknown): string[] {
  const brut = Array.isArray(v) ? v.map(texte).filter((x): x is string => x !== null) : (texte(v) ?? "").split(/[,\s]+/);
  return brut.map((t) => t.trim().replace(/^#/, "")).filter(Boolean);
}

/** Identité d'un dossier : inode + date de naissance (un inode est souvent réutilisé aussitôt par ext4). */
function identiteDossier(st: fs.Stats): string {
  return `${st.ino}:${st.birthtimeMs}`;
}

export function cleDisque(st: fs.Stats): string {
  return `${st.mtimeMs}:${st.ctimeMs}:${st.size}:${st.ino}`;
}

export function construirePage(chemin: string, contenu: string, st: fs.Stats, lien: boolean, mentions: readonly string[] = []): Page {
  const d = decouper(contenu);
  const fm = lireFrontmatter(d.yaml);
  const nom = feuille(chemin);
  const titreFm = fm ? texte(fm.title) : null;
  const titre = (titreFm && titreFm.trim()) || (d.titreH1 && d.titreH1.trim()) || nom;
  let icone = fm ? texte(fm.icon) : null;
  if (!icone && fm && fm.pageDecoration && typeof fm.pageDecoration === "object" && !Array.isArray(fm.pageDecoration)) {
    const i = (fm.pageDecoration as Record<string, unknown>).icon;
    if (typeof i === "string") icone = i;
  }
  let ordre: number | null = null;
  if (fm && fm.ordre !== undefined && fm.ordre !== null) {
    const o = typeof fm.ordre === "number" ? fm.ordre : Number(texte(fm.ordre));
    if (Number.isFinite(o)) ordre = o;
  }
  const resume = fm ? texte(fm.resume) : null;
  const lignesFm = d.frontmatter ? d.frontmatter.split("\n").length - (d.frontmatter.endsWith("\n") ? 1 : 0) : 0;
  const an = analyser(contenu, lignesFm, mentions);
  const debutCorps = d.frontmatter.length + d.blocTitre.length;
  return {
    chemin, nom, titre, icone: icone && icone.trim() ? icone.trim() : null, ordre, resume: resume && resume.trim() ? resume.trim() : null,
    statut: fm ? texte(fm.statut) : null, tags: fm ? listeTags(fm.tags) : [], fm,
    mtime: Math.floor(st.mtimeMs), taille: st.size, etag: etagDe(contenu), cle: cleDisque(st), contenu, debutCorps, lien, alias: null,
    taches: an.taches, mention: an.mention,
    pTitre: plier(titre), pNom: plier(nom), pCorps: plier(contenu.slice(debutCorps)), pFm: plier(d.yaml),
  };
}

/** Indice dans `orig` correspondant à l'indice `cible` dans plier(orig). */
function indiceOriginal(orig: string, cible: number): number {
  let plie = 0;
  let i = 0;
  while (i < orig.length && plie < cible) {
    const cp = orig.codePointAt(i)!;
    const n = cp > 0xffff ? 2 : 1;
    plie += cp < 128 ? 1 : plier(orig.slice(i, i + n)).length;
    i += n;
  }
  return i;
}

function aplatir(s: string): string {
  return s.replace(/\s+/g, " ");
}

export interface Resultat {
  chemin: string;
  titre: string;
  icone: string | null;
  avant: string;
  extrait: string;
  apres: string;
  score: number;
}

export class Espace {
  cfg: Config;
  verrou: Verrou;
  pages = new Map<string, Page>();
  fichiers = new Map<string, Fichier>();
  /** dossier logique -> { mtime, abs (chemin disque) } */
  dossiers = new Map<string, { mtime: number; abs: string }>();
  version = Date.now();
  surChangement: (ch: Changements, version: number) => void = () => {};
  #attente = new Set<string>();
  #minuteur: ReturnType<typeof setTimeout> | null = null;
  #surveillants = new Map<string, fs.FSWatcher>();
  /** Inode du dossier surveillé : un dossier supprimé puis recréé sous le même nom (rsync, agent) doit être
   *  resurveillé, l'ancien fs.watch restant attaché à l'inode disparu sans toujours signaler d'erreur. */
  #inodes = new Map<string, string>();
  #balayage: ReturnType<typeof setInterval> | null = null;
  #surveillance = false;
  #cache: { version: number; json: string } | null = null;
  /** Ordre manuel des dossiers (`.carnet/ordre.json`). */
  ordres: Ordres;

  constructor(cfg: Config, verrou: Verrou) {
    this.cfg = cfg;
    this.verrou = verrou;
    this.ordres = new Ordres(cfg);
  }

  // -------------------------------------------------------------------------------------------
  // Balayage
  // -------------------------------------------------------------------------------------------

  async balayerTout(): Promise<Changements> {
    const ch = nouveauxChangements();
    const vus = vide();
    await this.#scanner(this.cfg.espace, "", 0, vus, ch);
    this.#retirerSous("", vus, ch);
    try {
      if (await this.ordres.rafraichir()) ch.arbre = true;
    } catch (e) {
      journal({ niveau: "avertissement", quoi: "ordre", erreur: String((e as Error).message) });
    }
    return ch;
  }

  async #scanner(abs: string, rel: string, prof: number, vus: Vus, ch: Changements): Promise<void> {
    if (prof > MAX_PROFONDEUR) return;
    let entrees: fs.Dirent[];
    try {
      entrees = await fsp.readdir(abs, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entrees) {
      const nom = d.name.normalize("NFC");
      if (nom.startsWith(".")) continue;
      const r = rel ? `${rel}/${nom}` : nom;
      if (zoneInterdite(this.cfg, r.split("/"))) continue;
      const a = path.join(abs, d.name);
      if (d.isDirectory()) {
        if (nom === "_assets") continue;
        const st = await lstatOuNull(a);
        if (!st || !st.isDirectory()) continue;
        vus.dossiers.add(r);
        this.#majDossier(r, a, st.mtimeMs, ch);
        await this.#scanner(a, r, prof + 1, vus, ch);
      } else if (d.isFile() || d.isSymbolicLink()) {
        await this.#indexerFichier(a, r, nom, vus, ch);
      }
    }
  }

  async #indexerFichier(a: string, r: string, nom: string, vus: Vus, ch: Changements): Promise<void> {
    const estMd = nom.endsWith(".md") && nom.length > 3;
    if (!estMd && !fichierVisible(nom)) return;
    let st: fs.Stats;
    let lien = false;
    let cible: string | null = null;
    try {
      const l = await fsp.lstat(a);
      lien = l.isSymbolicLink();
      // lien symbolique : cible dans l'espace, hors zones interdites, fichier seulement (les dossiers liés ne sont pas suivis)
      if (lien) {
        const reel = await fsp.realpath(a);
        if (!reelAutorise(this.cfg, reel)) return;
        const segs = relatifReel(this.cfg, reel);
        cible = segs ? segs.join("/").normalize("NFC") : null;
      }
      st = lien ? await fsp.stat(a) : l;
    } catch {
      return;
    }
    if (!st.isFile()) return;
    if (estMd) {
      const ancien = this.pages.get(r);
      if (ancien && ancien.cle === cleDisque(st) && ancien.lien === lien && ancien.alias === (cible && cible !== r && cible.endsWith(".md") ? cible : null)) {
        vus.pages.add(r);
        return;
      }
      let contenu = "";
      if (st.size <= MAX_MD) {
        try {
          const x = await lireConfine(this.cfg, a, MAX_MD);
          contenu = x.contenu;
          st = x.st;
        } catch {
          return;
        }
      }
      vus.pages.add(r);
      const page = construirePage(r, contenu, st, lien, this.cfg.mentions);
      page.alias = cible && cible !== r && cible.endsWith(".md") ? cible : null;
      this.#poserPage(page, ch);
    } else {
      vus.fichiers.add(r);
      if (!this.fichiers.has(r)) ch.arbre = true;
      this.fichiers.set(r, { chemin: r, nom, ext: extension(nom), mtime: Math.floor(st.mtimeMs), taille: st.size, lien });
    }
  }

  #poserPage(page: Page, ch: Changements): void {
    const ancien = this.pages.get(page.chemin);
    if (!ancien) ch.arbre = true;
    else {
      if (ancien.etag !== page.etag) ch.modifs.set(page.chemin, page.etag);
      if (ancien.titre !== page.titre || ancien.icone !== page.icone || ancien.ordre !== page.ordre
        || ancien.resume !== page.resume || ancien.lien !== page.lien) ch.arbre = true;
    }
    this.pages.set(page.chemin, page);
  }

  #majDossier(r: string, abs: string, mtime: number, ch: Changements): void {
    if (!this.dossiers.has(r)) ch.arbre = true;
    this.dossiers.set(r, { mtime: Math.floor(mtime), abs });
  }

  /** Retire tout ce qui est sous `prefixe` ("" = tout) et n'a pas été vu. */
  #retirerSous(prefixe: string, vus: Vus, ch: Changements): void {
    const dans = (c: string) => prefixe === "" || c === prefixe || c.startsWith(prefixe + "/");
    for (const c of [...this.pages.keys()]) if (dans(c) && !vus.pages.has(c)) { this.pages.delete(c); ch.arbre = true; }
    for (const c of [...this.fichiers.keys()]) if (dans(c) && !vus.fichiers.has(c)) { this.fichiers.delete(c); ch.arbre = true; }
    for (const c of [...this.dossiers.keys()]) if (dans(c) && !vus.dossiers.has(c)) { this.dossiers.delete(c); ch.arbre = true; }
  }

  #retirer(rel: string, ch: Changements): void {
    this.#retirerSous(rel, vide(), ch);
  }

  async #assurerParents(segs: string[], ch: Changements): Promise<void> {
    for (let i = 1; i < segs.length; i++) {
      const p = segs.slice(0, i).join("/");
      if (this.dossiers.has(p)) continue;
      const abs = await resoudre(this.cfg, segs.slice(0, i));
      const st = await lstatOuNull(abs);
      if (st && st.isDirectory()) this.#majDossier(p, abs, st.mtimeMs, ch);
    }
  }

  /** Met à jour l'index pour une liste de chemins logiques (événements du disque, opérations de l'API). */
  async traiter(rels: Iterable<string>): Promise<Changements> {
    const ch = nouveauxChangements();
    const liste = [...new Set(rels)].sort((a, b) => a.length - b.length);
    const faits: string[] = [];
    for (const rel of liste) {
      if (rel === "") return await this.balayerTout();
      if (faits.some((f) => rel === f || rel.startsWith(f + "/"))) continue;
      faits.push(rel);
      const segs = rel.split("/");
      if (segs.some((s) => s === "" || s.startsWith(".")) || zoneInterdite(this.cfg, segs) || segs.includes("_assets")) continue;
      const abs = await resoudre(this.cfg, segs);
      const st = await lstatOuNull(abs);
      if (!st) { this.#retirer(rel, ch); continue; }
      await this.#assurerParents(segs, ch);
      if (st.isDirectory()) {
        const vus = vide();
        vus.dossiers.add(rel);
        this.#majDossier(rel, abs, st.mtimeMs, ch);
        await this.#scanner(abs, rel, segs.length, vus, ch);
        this.#retirerSous(rel, vus, ch);
      } else {
        // ce chemin était peut-être un dossier : retirer le dossier et son contenu, garder la page / le fichier lui-même
        const garder = vide();
        garder.pages.add(rel);
        garder.fichiers.add(rel);
        this.#retirerSous(rel, garder, ch);
        const vus = vide();
        await this.#indexerFichier(abs, rel, segs[segs.length - 1], vus, ch);
        if (!vus.pages.has(rel) && this.pages.delete(rel)) ch.arbre = true;
        if (!vus.fichiers.has(rel) && this.fichiers.delete(rel)) ch.arbre = true;
      }
    }
    return ch;
  }

  /** Mise à jour immédiate après une écriture faite par le serveur lui-même. */
  async majPage(segs: string[], contenu: string, st: fs.Stats): Promise<Changements> {
    const ch = nouveauxChangements();
    await this.#assurerParents(segs, ch);
    this.#poserPage(construirePage(segs.join("/"), contenu, st, false, this.cfg.mentions), ch);
    return ch;
  }

  /** Publie les changements (version de l'arbre, SSE) et ajuste la surveillance des dossiers. */
  appliquer(ch: Changements): void {
    if (ch.arbre) {
      this.version++;
      this.#cache = null;
    }
    this.#synchroniserSurveillants();
    if (ch.arbre || ch.modifs.size) this.surChangement(ch, this.version);
  }

  // -------------------------------------------------------------------------------------------
  // Surveillance : un fs.watch (inotify) par dossier VISIBLE (jamais .git, .corbeille, artefacts, dossiers masqués…)
  // + rebalayage de sécurité périodique.
  // -------------------------------------------------------------------------------------------

  demarrerSurveillance(): void {
    this.#surveillance = true;
    this.#synchroniserSurveillants();
    this.#balayage = setInterval(() => {
      this.verrou.executer(async () => this.appliquer(await this.balayerTout()))
        .catch((e) => journal({ niveau: "erreur", quoi: "rebalayage", erreur: String((e as Error).message) }));
    }, this.cfg.rebalayageMs);
    this.#balayage.unref();
  }

  arreter(): void {
    this.#surveillance = false;
    if (this.#balayage) clearInterval(this.#balayage);
    if (this.#minuteur) clearTimeout(this.#minuteur);
    for (const w of this.#surveillants.values()) w.close();
    this.#surveillants.clear();
    this.#inodes.clear();
  }

  #synchroniserSurveillants(): void {
    if (!this.#surveillance) return;
    const voulus = new Map<string, string>([["", this.cfg.espace]]);
    for (const [r, d] of this.dossiers) voulus.set(r, d.abs);
    for (const [r, w] of this.#surveillants) {
      if (!voulus.has(r)) { w.close(); this.#surveillants.delete(r); this.#inodes.delete(r); }
    }
    for (const [r, abs] of voulus) {
      const w = this.#surveillants.get(r);
      if (w) {
        let ino = "";
        try { ino = identiteDossier(fs.statSync(abs)); } catch { /* disparu : retiré au prochain passage */ }
        if (ino === this.#inodes.get(r)) continue;
        w.close();
        this.#surveillants.delete(r);
        this.#signaler(r); // le contenu du nouveau dossier a pu changer avant la nouvelle surveillance
      }
      this.#surveiller(r, abs);
    }
  }

  #surveiller(rel: string, abs: string): void {
    let w: fs.FSWatcher;
    try {
      w = fs.watch(abs, { persistent: false }, (_ev, nom) => {
        if (nom == null) { this.#signaler(rel); return; }
        const n = String(nom).normalize("NFC");
        this.#signaler(rel ? `${rel}/${n}` : n);
      });
    } catch {
      this.#signaler(rel);
      return;
    }
    w.on("error", () => {
      w.close();
      if (this.#surveillants.get(rel) === w) this.#surveillants.delete(rel);
      this.#signaler(rel);
    });
    this.#surveillants.set(rel, w);
    try { this.#inodes.set(rel, identiteDossier(fs.statSync(abs))); } catch { this.#inodes.delete(rel); }
  }

  #signaler(rel: string): void {
    if (rel !== "") {
      const segs = rel.split("/");
      if (segs.some((s) => s.startsWith(".")) || segs.includes("_assets") || zoneInterdite(this.cfg, segs)) return;
    }
    this.#attente.add(rel);
    if (!this.#minuteur) this.#minuteur = setTimeout(() => this.#vider(), this.cfg.regroupementMs);
  }

  #vider(): void {
    this.#minuteur = null;
    const rels = [...this.#attente];
    this.#attente.clear();
    this.verrou.executer(async () => this.appliquer(await this.traiter(rels)))
      .catch((e) => journal({ niveau: "erreur", quoi: "surveillance", erreur: String((e as Error).message) }));
  }

  get nbSurveillants(): number {
    return this.#surveillants.size;
  }

  // -------------------------------------------------------------------------------------------
  // Arbre
  // -------------------------------------------------------------------------------------------

  arbreJson(): string {
    if (this.#cache && this.#cache.version === this.version) return this.#cache.json;
    const enfants = new Map<string, Noeud[]>();
    const parNom = new Map<string, Noeud>();
    const ordres = new Map<Noeud, number | null>();
    const ajouter = (dossier: string, n: Noeud) => {
      const l = enfants.get(dossier);
      if (l) l.push(n);
      else enfants.set(dossier, [n]);
    };
    for (const p of this.pages.values()) {
      if (this.estAlias(p)) continue; // CLAUDE.md -> AGENTS.md : une seule entrée dans l'arbre
      const n: Noeud = { chemin: p.chemin, nom: p.nom, titre: p.titre, icone: p.icone, existe: true, type: "page", enfants: [], mtime: p.mtime };
      if (p.resume) n.resume = p.resume;
      if (p.lien) n.lectureSeule = true;
      ordres.set(n, p.ordre);
      ajouter(dossierDe(p.chemin), n);
      parNom.set(p.chemin.slice(0, -3), n);
    }
    for (const [d, info] of this.dossiers) {
      if (parNom.has(d)) continue;
      const nom = feuille(d);
      const n: Noeud = { chemin: d + ".md", nom, titre: nom, icone: null, existe: false, type: "page", enfants: [], mtime: info.mtime };
      ordres.set(n, null);
      ajouter(dossierDe(d), n);
      parNom.set(d, n);
    }
    for (const f of this.fichiers.values()) {
      const n: Noeud = { chemin: f.chemin, nom: f.nom, titre: f.nom, icone: null, existe: true, type: "fichier", ext: f.ext, enfants: [], mtime: f.mtime };
      if (f.lien) n.lectureSeule = true;
      ordres.set(n, null);
      ajouter(dossierDe(f.chemin), n);
    }
    // Tri d'un dossier : l'ordre manuel (`.carnet/ordre.json`, écrit par le glisser-déposer) passe d'abord ; il gagne
    // sur le champ `ordre:` du frontmatter, car c'est le dernier geste explicite de l'utilisateur. Les entrées qu'il ne
    // nomme pas (pages créées depuis, par un agent par exemple) suivent, triées comme avant : `ordre:` puis titre.
    const comparateur = (dossier: string) => {
      const manuel = this.ordres.liste(dossier);
      const rang = manuel ? new Map(manuel.map((n, i) => [n, i])) : null;
      return (a: Noeud, b: Noeud): number => {
        if (rang) {
          const ra = rang.get(a.nom);
          const rb = rang.get(b.nom);
          if (ra !== undefined && rb !== undefined && ra !== rb) return ra - rb;
          if (ra !== undefined && rb === undefined) return -1;
          if (ra === undefined && rb !== undefined) return 1;
        }
        const oa = ordres.get(a) ?? null;
        const ob = ordres.get(b) ?? null;
        if (oa !== null && ob !== null && oa !== ob) return oa - ob;
        if (oa !== null && ob === null) return -1;
        if (oa === null && ob !== null) return 1;
        return collateur.compare(a.titre, b.titre) || (a.chemin < b.chemin ? -1 : a.chemin > b.chemin ? 1 : 0);
      };
    };
    for (const [d, liste] of enfants) {
      liste.sort(comparateur(d));
      if (d !== "") {
        const parent = parNom.get(d);
        if (parent) parent.enfants = liste;
      }
    }
    const json = JSON.stringify({ racine: enfants.get("") ?? [], version: this.version });
    this.#cache = { version: this.version, json };
    return json;
  }

  /** L'arbre a changé sans événement disque (ordre manuel) : nouvelle version, cache vidé. */
  arbreModifie(): Changements {
    const ch = nouveauxChangements();
    ch.arbre = true;
    return ch;
  }

  /** Noms des entrées d'un dossier logique, dans l'ordre affiché par l'arbre. */
  enfantsOrdonnes(dossier: string): string[] {
    const arbre = JSON.parse(this.arbreJson()) as { racine: Noeud[] };
    let liste = arbre.racine;
    if (dossier !== "") {
      const segs = dossier.split("/");
      for (let i = 0; i < segs.length; i++) {
        const c = segs.slice(0, i + 1).join("/") + ".md";
        const n = liste.find((x) => x.type === "page" && x.chemin === c);
        if (!n) return [];
        liste = n.enfants;
      }
    }
    return liste.map((n) => n.nom);
  }

  /** Nombre d'entrées (pages, dossiers, fichiers) sous la page `chemin` dans l'arbre. */
  nbEnfants(chemin: string): number {
    return this.enfantsOrdonnes(chemin.replace(/\.md$/i, "")).length;
  }

  // -------------------------------------------------------------------------------------------
  // Recherche
  // -------------------------------------------------------------------------------------------

  /** Page qui n'est qu'un lien symbolique vers une autre page déjà listée : jamais un 2e nœud, ni un doublon en recherche. */
  estAlias(p: Page): boolean {
    return p.alias !== null && this.pages.has(p.alias);
  }

  /** Pages à montrer (arbre, recherche, accueil, projets) : sans les alias. */
  pagesVisibles(): Page[] {
    return [...this.pages.values()].filter((p) => !this.estAlias(p));
  }

  rechercher(q: string, limite: number): Resultat[] {
    const termes = [...new Set(plier(q).split(/\s+/).filter(Boolean))].slice(0, 10);
    if (!termes.length) return [];
    const qp = termes.join(" ");
    const trouves: { p: Page; score: number }[] = [];
    for (const p of this.pagesVisibles()) {
      let score = 0;
      let ok = true;
      for (const t of termes) {
        let s = 0;
        if (p.pTitre.includes(t)) s += p.pTitre.startsWith(t) ? 30 : 20;
        if (p.pNom.includes(t)) s += 10;
        if (p.pCorps.includes(t)) s += 3;
        else if (p.pFm.includes(t)) s += 1;
        if (s === 0) { ok = false; break; }
        score += s;
      }
      if (!ok) continue;
      if (p.pTitre === qp) score += 50;
      trouves.push({ p, score });
    }
    trouves.sort((a, b) => b.score - a.score || b.p.mtime - a.p.mtime);
    return trouves.slice(0, limite).map(({ p, score }) => ({ chemin: p.chemin, titre: p.titre, icone: p.icone, ...this.#extrait(p, termes), score }));
  }

  #extrait(p: Page, termes: string[]): { avant: string; extrait: string; apres: string } {
    const corps = p.contenu.slice(p.debutCorps);
    let pos = -1;
    let long = 0;
    for (const t of termes) {
      const i = p.pCorps.indexOf(t);
      if (i !== -1 && (pos === -1 || i < pos)) { pos = i; long = t.length; }
    }
    if (pos === -1) {
      const debut = aplatir(corps.slice(0, 400)).trim();
      return { avant: "", extrait: "", apres: debut.length > 120 ? debut.slice(0, 119).trimEnd() + "…" : debut };
    }
    const i0 = indiceOriginal(corps, pos);
    const i1 = Math.max(i0 + 1, indiceOriginal(corps, pos + long));
    let debut = Math.max(0, i0 - 50);
    let fin = Math.min(corps.length, i1 + 70);
    // ne pas couper une paire de substitution
    if (debut > 0 && /[\udc00-\udfff]/.test(corps[debut])) debut--;
    if (fin < corps.length && /[\udc00-\udfff]/.test(corps[fin])) fin++;
    let avant = aplatir(corps.slice(debut, i0));
    let apres = aplatir(corps.slice(i1, fin));
    if (debut > 0) avant = "…" + avant.replace(/^\S*\s/, "");
    else avant = avant.trimStart();
    if (fin < corps.length) apres = apres.replace(/\s\S*$/, "") + "…";
    else apres = apres.trimEnd();
    return { avant, extrait: aplatir(corps.slice(i0, i1)), apres };
  }

  /** Résumé d'une page : frontmatter `resume`, sinon premier paragraphe du corps. */
  resume(p: Page): string {
    return p.resume ?? extraitCorps(p.contenu.slice(p.debutCorps));
  }
}
