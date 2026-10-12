// Carnet · attestations signées des gestes humains engageants (décisions), HORS de l'espace.
// Voir docs/architecture.md (section « Écritures »).
//
// `CARNET_ETAT/journal/<espace>/attestations.jsonl`, une ligne par geste, signée HMAC-SHA256 avec une clé DÉRIVÉE de la
// clé du serveur : HMAC(cle_serveur, "carnet-attestation-v1"). Clé du serveur = CARNET_CLE (celle des artefacts) ; à
// défaut, un fichier `cle-attestations.key` créé dans CARNET_ETAT (0600). Jamais rien dans l'espace.
// Signature sur le JSON CANONIQUE (clés triées) de tous les champs sauf `sig`, dont {v, espace, demande, empreinte,
// resultat, portee, principal, t, geste}.
// Chaîne par demande : la DERNIÈRE attestation valide d'une demande fait foi ; une approbation suivie d'un refus, d'une
// demande de correction ou d'une approbation d'une autre empreinte est « remplacée ».
// LIMITE (à dire honnêtement) : un processus qui peut lire la clé sur le VPS peut signer. Protection contre l'erreur et
// l'agent naïf, pas contre un agent malveillant sur la même machine. Et `principal` n'est PAS une preuve de geste humain :
// les agents et la personne partagent l'identité Tailscale ; seul `geste: "cle-d-acces"` (WebAuthn, lot 3) en est une.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { horodatageIso, nouvelIdentifiant } from "../../shared/identifiants.ts";
import { Cle } from "./art.ts";
import type { Config } from "./config.ts";
import { lstatOuNull } from "./disque.ts";
import { ajouterLigne, jsonCanonique, lireLignes } from "./journal-ecritures.ts";

export const CONTEXTE_CLE = "carnet-attestation-v1";

export type Geste = "cle-d-acces" | "identite-seule";

/** Ce qu'un lot demande d'attester (le reste est posé par le socle). */
export interface DemandeAttestation {
  /** Identifiant de la demande (ex. `dec-20261011-0812-k3f9`). */
  demande: string;
  /** Empreinte de la proposition figée (`sha256:…`), méthode documentée par le lot 3. */
  empreinte: string;
  /** « approuvée », « à corriger », « refusée »… */
  resultat: string;
  /** Ce que couvre le geste (ex. « proposition figée ci-dessous, sans ses liens externes »). */
  portee: string;
  /** Défaut : « identite-seule ». « cle-d-acces » seulement après vérification WebAuthn (lot 3). */
  geste?: Geste;
}

export interface Attestation {
  id: string;
  v: 1;
  espace: string;
  t: string;
  principal: string;
  geste: Geste;
  resultat: string;
  portee: string;
  chemin: string;
  demande: string;
  empreinte: string;
  sig: string;
}

export type EtatPreuve = "absente" | "valide" | "perimee" | "remplacee" | "indeterminee";

const RE_DEMANDE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const RE_EMPREINTE = /^sha256:[0-9a-f]{64}$/;

export class Attestations {
  readonly fichier: string;
  #cfg: Config;
  #cleDerivee: Buffer | null = null;
  #cache: { cle: string; lignes: { a: Attestation; valide: boolean }[] } | null = null;

  constructor(cfg: Config, dossier: string) {
    this.#cfg = cfg;
    this.fichier = path.join(dossier, "attestations.jsonl");
  }

  #cle(): Buffer {
    if (this.#cleDerivee) return this.#cleDerivee;
    let base: Buffer;
    if (this.#cfg.fichierCle) base = new Cle(this.#cfg.fichierCle).valeur();
    else {
      const f = path.join(this.#cfg.etat, "cle-attestations.key");
      fs.mkdirSync(this.#cfg.etat, { recursive: true, mode: 0o700 });
      try {
        fs.writeFileSync(f, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      }
      base = new Cle(f).valeur();
    }
    this.#cleDerivee = crypto.createHmac("sha256", base).update(CONTEXTE_CLE, "utf8").digest();
    return this.#cleDerivee;
  }

  /** Signature HMAC-SHA256 (hex) du JSON canonique des champs, `sig` exclu. */
  signer(champs: Omit<Attestation, "sig">): string {
    return crypto.createHmac("sha256", this.#cle()).update(jsonCanonique(champs), "utf8").digest("hex");
  }

  /** Signature valide et champs bien formés ? (comparaison en temps constant) */
  estValide(a: unknown): a is Attestation {
    if (!a || typeof a !== "object") return false;
    const x = a as Record<string, unknown>;
    if (x.v !== 1 || typeof x.sig !== "string" || !/^[0-9a-f]{64}$/.test(x.sig)) return false;
    for (const k of ["id", "espace", "t", "principal", "geste", "resultat", "portee", "chemin", "demande", "empreinte"]) {
      if (typeof x[k] !== "string") return false;
    }
    const { sig, ...champs } = x;
    const attendu = Buffer.from(this.signer(champs as Omit<Attestation, "sig">), "hex");
    return crypto.timingSafeEqual(attendu, Buffer.from(sig as string, "hex"));
  }

  /** Prépare (sans l'écrire) une attestation signée. Lève une Error si les champs sont mal formés. */
  preparer(d: DemandeAttestation, principal: string, chemin: string, maintenant = new Date()): Attestation {
    if (!RE_DEMANDE.test(d.demande)) throw new Error("attestation : identifiant de demande invalide");
    if (!RE_EMPREINTE.test(d.empreinte)) throw new Error("attestation : empreinte « sha256:<64 hexa> » attendue");
    if (typeof d.resultat !== "string" || !d.resultat || d.resultat.length > 100) throw new Error("attestation : résultat invalide");
    if (typeof d.portee !== "string" || d.portee.length > 500) throw new Error("attestation : portée invalide");
    const geste: Geste = d.geste === "cle-d-acces" ? "cle-d-acces" : "identite-seule";
    const champs: Omit<Attestation, "sig"> = {
      id: nouvelIdentifiant("att", this.#cfg.fuseau, maintenant), v: 1, espace: this.#cfg.nomEspace, t: horodatageIso(maintenant, this.#cfg.fuseau),
      principal, geste, resultat: d.resultat, portee: d.portee, chemin, demande: d.demande, empreinte: d.empreinte,
    };
    return { ...champs, sig: this.signer(champs) };
  }

  /** Ajoute une attestation préparée (append + fsync). */
  async ajouter(a: Attestation): Promise<void> {
    await ajouterLigne(this.fichier, a);
    this.#cache = null;
  }

  async #lignes(): Promise<{ a: Attestation; valide: boolean }[]> {
    const st = await lstatOuNull(this.fichier);
    const cle = st ? `${st.size}:${st.mtimeMs}:${st.ino}` : "absent";
    if (this.#cache && this.#cache.cle === cle) return this.#cache.lignes;
    const { lignes } = await lireLignes<Attestation>(this.fichier);
    const res = lignes.filter((a) => a && typeof a === "object").map((a) => ({ a, valide: this.estValide(a) }));
    this.#cache = { cle, lignes: res };
    return res;
  }

  /** Attestations (valides ou non) d'un chemin ou d'une demande, dans l'ordre du fichier. */
  async lister(filtre: { chemin?: string; demande?: string } = {}): Promise<{ attestation: Attestation; valide: boolean }[]> {
    return (await this.#lignes())
      .filter(({ a }) => (filtre.chemin === undefined || a.chemin === filtre.chemin) && (filtre.demande === undefined || a.demande === filtre.demande))
      .map(({ a, valide }) => ({ attestation: a, valide }));
  }

  /** Attestation par identifiant (valide seulement), ou null. */
  async parId(id: string): Promise<Attestation | null> {
    return (await this.#lignes()).find((x) => x.valide && x.a.id === id)?.a ?? null;
  }

  /**
   * La DERNIÈRE attestation valide de la demande, si elle porte sur cette empreinte (et ce chemin quand il est fourni) ;
   * sinon null. Les lignes falsifiées (signature fausse) sont ignorées.
   */
  async verifier(chemin: string | null, demande: string, empreinte: string): Promise<Attestation | null> {
    const chaine = (await this.#lignes()).filter((x) => x.valide && x.a.demande === demande);
    const derniere = chaine[chaine.length - 1]?.a;
    if (!derniere || derniere.empreinte !== empreinte) return null;
    if (chemin !== null && derniere.chemin !== chemin) return null;
    return derniere;
  }

  /**
   * État de la preuve d'une demande pour une empreinte attendue :
   * absente (aucune attestation valide), valide (la dernière porte sur cette empreinte et ce résultat), perimee (la dernière
   * porte sur une autre empreinte : la proposition a changé), remplacee (une attestation antérieure portait sur cette
   * empreinte mais une plus récente l'a remplacée), indeterminee (lignes falsifiées présentes pour cette demande, sans
   * attestation valide).
   */
  async etat(demande: string, empreinte: string | null, resultat?: string): Promise<{ etat: EtatPreuve; attestation: Attestation | null }> {
    const toutes = (await this.#lignes()).filter((x) => x.a.demande === demande);
    const chaine = toutes.filter((x) => x.valide).map((x) => x.a);
    const derniere = chaine[chaine.length - 1] ?? null;
    if (!derniere) return { etat: toutes.length ? "indeterminee" : "absente", attestation: null };
    if (empreinte !== null && derniere.empreinte !== empreinte) {
      return { etat: chaine.some((a) => a.empreinte === empreinte) ? "remplacee" : "perimee", attestation: derniere };
    }
    if (resultat !== undefined && derniere.resultat !== resultat) return { etat: "remplacee", attestation: derniere };
    return { etat: "valide", attestation: derniere };
  }
}
