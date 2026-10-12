// Carnet · journaux durables de la porte d'écriture, HORS de l'espace (CARNET_ETAT/journal/<espace>/, dossier 0700) :
//   - ecritures.jsonl  : attribution, une ligne par écriture faite par Carnet (append-only, rotation à 10 Mo) ;
//   - intentions.jsonl : intention fsyncée AVANT toute écriture dans l'espace, puis validation (reprise après panne) ;
//   - requetes.jsonl   : résultats des requêtes idempotentes (X-Carnet-Requete), conservés 7 jours, relus au démarrage.
// Voir docs/architecture.md (section « Écritures »).
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { nomDeFichier } from "../../shared/page.ts";
import type { Config } from "./config.ts";
import { ecrireAtomique, horodatage, lstatOuNull } from "./disque.ts";
import { journal as journalStdout } from "./http.ts";

export const MAX_JOURNAL = 10 * 1024 * 1024;
export const RETENTION_REQUETES_MS = 7 * 24 * 3600 * 1000;
/** Entrées gardées en mémoire par chemin (dernieres, contenuDejaEcritParCarnet). */
const MEMOIRE_PAR_CHEMIN = 50;

/** Une ligne du journal des écritures. */
export interface EntreeJournal {
  /** Horodatage ISO avec fuseau. */
  t: string;
  /** Identité vérifiée de la requête (en-tête posé par Tailscale) : JAMAIS une valeur venant du fichier. */
  principal: string;
  /** Client authentifié séparément : réservé, toujours null pour l'instant. */
  client: null;
  action: string;
  chemin: string;
  /** Destination d'un renommage / déplacement. */
  vers?: string;
  /** etag avant (null : création) et après (null : suppression). */
  avant: string | null;
  apres: string | null;
  requete: string | null;
  /** `maj_par` du contenu écrit : une DÉCLARATION, jamais une preuve. */
  auteur_declare?: string;
  /** Écriture complétée par la reprise au démarrage (intention retrouvée sans validation). */
  reprise?: true;
}

/** Dossier d'état des journaux de l'espace (créé à la demande, 0700). */
export function dossierJournal(cfg: Config): string {
  return path.join(cfg.etat, "journal", nomDeFichier(cfg.nomEspace));
}

/** Ajoute une ligne et la rend durable (fsync) avant de rendre la main. */
export async function ajouterLigne(fichier: string, objet: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(fichier), { recursive: true, mode: 0o700 });
  const fh = await fsp.open(fichier, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    await fh.writeFile(JSON.stringify(objet) + "\n");
    await fh.sync();
  } finally {
    await fh.close();
  }
}

/** Lit un fichier JSONL (lignes illisibles ignorées et comptées). */
export async function lireLignes<T>(fichier: string): Promise<{ lignes: T[]; illisibles: number }> {
  let brut: string;
  try {
    const st = await lstatOuNull(fichier);
    if (!st || !st.isFile()) return { lignes: [], illisibles: 0 };
    brut = await fsp.readFile(fichier, "utf8");
  } catch {
    return { lignes: [], illisibles: 0 };
  }
  const lignes: T[] = [];
  let illisibles = 0;
  for (const l of brut.split("\n")) {
    if (!l.trim()) continue;
    try {
      lignes.push(JSON.parse(l) as T);
    } catch {
      illisibles++;
    }
  }
  return { lignes, illisibles };
}

/** JSON canonique : clés triées à tous les niveaux (empreintes, signatures). */
export function jsonCanonique(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map(jsonCanonique).join(",") + "]";
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).filter((k) => o[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + jsonCanonique(o[k])).join(",") + "}";
}

export function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------
// Journal des écritures (attribution)
// ---------------------------------------------------------------------------------------------

export class JournalEcritures {
  readonly fichier: string;
  readonly max: number;
  #parChemin = new Map<string, EntreeJournal[]>();
  #pret: Promise<void> | null = null;

  /** `max` : taille au-delà de laquelle le fichier courant est archivé (10 Mo ; réglable pour les tests). */
  constructor(dossier: string, max = MAX_JOURNAL) {
    this.fichier = path.join(dossier, "ecritures.jsonl");
    this.max = max;
  }

  /** Charge en mémoire les dernières entrées (fichier courant + archive la plus récente). */
  charger(): Promise<void> {
    this.#pret ??= (async () => {
      const dossier = path.dirname(this.fichier);
      let archives: string[] = [];
      try {
        const rang = (n: string) => {
          const m = /^ecritures-(\d{8}-\d{6})(?:-(\d+))?\.jsonl$/.exec(n)!;
          return m[1] + String(Number(m[2] ?? 0)).padStart(4, "0");
        };
        archives = (await fsp.readdir(dossier)).filter((n) => /^ecritures-\d{8}-\d{6}(-\d+)?\.jsonl$/.test(n)).sort((x, y) => (rang(x) < rang(y) ? -1 : 1));
      } catch { /* pas encore de dossier */ }
      const fichiers = [...archives.slice(-1).map((n) => path.join(dossier, n)), this.fichier];
      for (const f of fichiers) {
        const { lignes } = await lireLignes<EntreeJournal>(f);
        for (const e of lignes) this.#memoriser(e);
      }
    })();
    return this.#pret;
  }

  #memoriser(e: EntreeJournal): void {
    if (!e || typeof e.chemin !== "string") return;
    const l = this.#parChemin.get(e.chemin) ?? [];
    l.push(e);
    if (l.length > MEMOIRE_PAR_CHEMIN) l.splice(0, l.length - MEMOIRE_PAR_CHEMIN);
    this.#parChemin.set(e.chemin, l);
    if (e.vers && e.vers !== e.chemin) {
      // le suivi continue sous le nouveau nom (l'ancien garde son historique)
      const v = this.#parChemin.get(e.vers) ?? [];
      this.#parChemin.set(e.vers, [...v, ...l].slice(-MEMOIRE_PAR_CHEMIN));
    }
  }

  /** Ajoute une entrée (append + fsync), avec rotation au-delà de 10 Mo (archive `ecritures-<horodatage>.jsonl`). */
  async ajouter(e: EntreeJournal): Promise<void> {
    await this.charger();
    const st = await lstatOuNull(this.fichier);
    if (st && st.size >= this.max) await this.#tourner();
    await ajouterLigne(this.fichier, e);
    this.#memoriser(e);
  }

  async #tourner(): Promise<void> {
    const dossier = path.dirname(this.fichier);
    const base = `ecritures-${horodatage()}`;
    for (let k = 0; k < 100; k++) {
      const cible = path.join(dossier, `${base}${k ? "-" + k : ""}.jsonl`);
      if (await lstatOuNull(cible)) continue;
      await fsp.rename(this.fichier, cible);
      journalStdout({ niveau: "info", quoi: "journal_rotation", archive: path.basename(cible) });
      return;
    }
  }

  /** Les `n` dernières écritures Carnet connues pour ce chemin (la plus récente en dernier). */
  dernieres(chemin: string, n = 10): EntreeJournal[] {
    const l = this.#parChemin.get(chemin) ?? [];
    return l.slice(-Math.max(0, n));
  }

  /**
   * Ce contenu (etag) a-t-il déjà été enregistré par Carnet à ce chemin ? Sert seulement à dire « contenu déjà enregistré
   * par Carnet » : ce n'est PAS une preuve d'auteur humain (les agents et la personne partagent la même identité
   * Tailscale). Portée : les 50 dernières écritures du chemin (fichier courant + dernière archive).
   */
  contenuDejaEcritParCarnet(chemin: string, etag: string): boolean {
    return (this.#parChemin.get(chemin) ?? []).some((e) => e.apres === etag);
  }

  /** @deprecated ancien nom : utiliser contenuDejaEcritParCarnet. */
  estEcritureCarnet(chemin: string, etag: string): boolean {
    return this.contenuDejaEcritParCarnet(chemin, etag);
  }
}

// ---------------------------------------------------------------------------------------------
// Requêtes idempotentes
// ---------------------------------------------------------------------------------------------

export interface RequeteMemorisee<R> {
  /** sha256(principal + "\n" + requete) : la clé (espace = ce fichier). */
  cle: string;
  /** sha256 du JSON canonique {action, chemin, operation}. */
  empreinte: string;
  /** ms */
  t: number;
  resultat: R;
}

export class RegistreRequetes<R> {
  readonly fichier: string;
  #memoire = new Map<string, RequeteMemorisee<R>>();
  #pret: Promise<void> | null = null;

  constructor(dossier: string) {
    this.fichier = path.join(dossier, "requetes.jsonl");
  }

  static cle(principal: string, requete: string): string {
    return sha256(principal + "\n" + requete);
  }

  /** Relit le fichier (entrées de moins de 7 jours) et le compacte s'il contient des entrées périmées. */
  charger(maintenant = Date.now()): Promise<void> {
    this.#pret ??= (async () => {
      const { lignes, illisibles } = await lireLignes<RequeteMemorisee<R>>(this.fichier);
      let perimees = illisibles;
      for (const r of lignes) {
        if (!r || typeof r.cle !== "string" || typeof r.t !== "number") { perimees++; continue; }
        if (maintenant - r.t > RETENTION_REQUETES_MS) { perimees++; continue; }
        this.#memoire.set(r.cle, r);
      }
      if (perimees > 0) await this.#reecrire();
    })();
    return this.#pret;
  }

  async #reecrire(): Promise<void> {
    const texte = [...this.#memoire.values()].map((r) => JSON.stringify(r) + "\n").join("");
    await fsp.mkdir(path.dirname(this.fichier), { recursive: true, mode: 0o700 });
    await ecrireAtomique(this.fichier, texte, { mode: 0o600 }).catch((e) => journalStdout({ niveau: "avertissement", quoi: "requetes_compactage", erreur: String((e as Error).message) }));
  }

  /** Retire les entrées de plus de 7 jours (mémoire et fichier). À appeler sous le verrou des mutations. */
  async compacter(maintenant = Date.now()): Promise<void> {
    await this.charger();
    let n = 0;
    for (const [k, r] of this.#memoire) if (maintenant - r.t > RETENTION_REQUETES_MS) { this.#memoire.delete(k); n++; }
    if (n > 0) await this.#reecrire();
  }

  async trouver(cle: string, maintenant = Date.now()): Promise<RequeteMemorisee<R> | null> {
    await this.charger();
    const r = this.#memoire.get(cle);
    if (!r || maintenant - r.t > RETENTION_REQUETES_MS) return null;
    return r;
  }

  async enregistrer(r: RequeteMemorisee<R>): Promise<void> {
    await this.charger();
    await ajouterLigne(this.fichier, r);
    this.#memoire.set(r.cle, r);
  }
}

// ---------------------------------------------------------------------------------------------
// Intentions (reprise après panne)
// ---------------------------------------------------------------------------------------------

export interface Intention {
  type: "intention";
  id: string;
  t: string;
  principal: string;
  action: string;
  chemin: string;
  vers?: string;
  avant: string | null;
  apres: string | null;
  requete: string | null;
  /** Clé et empreinte de la requête idempotente, pour mémoriser le résultat à la reprise. */
  cleRequete?: string;
  empreinteRequete?: string;
  /** Attestation déjà signée, à ajouter si elle manque. */
  attestation?: unknown;
  /** Renommer / déplacer / supprimer : la reprise regarde la source et la destination. */
  mouvement?: true;
  auteur_declare?: string;
  /** Lot 5 : instantané de la version remplacée (option `instantaneAvant`), rendu dans le résultat. */
  instantane?: string;
}

export interface Validation {
  type: "validation";
  id: string;
  t: string;
  etat: "faite" | "abandonnee" | "indeterminee";
}

export class Intentions {
  readonly fichier: string;
  constructor(dossier: string) {
    this.fichier = path.join(dossier, "intentions.jsonl");
  }

  noter(i: Intention): Promise<void> {
    return ajouterLigne(this.fichier, i);
  }

  valider(id: string, t: string, etat: Validation["etat"] = "faite"): Promise<void> {
    return ajouterLigne(this.fichier, { type: "validation", id, t, etat } satisfies Validation);
  }

  /** Intentions sans validation. */
  async enAttente(): Promise<Intention[]> {
    const { lignes } = await lireLignes<Intention | Validation>(this.fichier);
    const faites = new Set(lignes.filter((l) => l?.type === "validation").map((l) => l.id));
    return lignes.filter((l): l is Intention => l?.type === "intention" && !faites.has(l.id));
  }

  /** Vide le fichier quand plus rien n'est en attente (il ne sert qu'à la reprise). */
  async compacter(): Promise<void> {
    if ((await this.enAttente()).length) return;
    const st = await lstatOuNull(this.fichier);
    if (!st || st.size === 0) return;
    await ecrireAtomique(this.fichier, "", { mode: 0o600 });
  }
}
