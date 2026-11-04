// Carnet · PORTE D'ÉCRITURE UNIQUE des pages (voir docs/architecture.md, section « Écritures »).
// Propriétaire : lot 0 « socle ». Les lots 1-3 n'écrivent JAMAIS une page autrement que par `Ecrivain`.
//
// Déroulé d'une écriture, sous le verrou des mutations :
//   1. idempotence : (principal, X-Carnet-Requete) déjà traité → même résultat, `rejoue: true`, rien de réécrit ;
//      même identifiant avec une autre opération → 409 `requete_reutilisee` ;
//   2. relecture du fichier et contrôle de la révision attendue (412 `etag_discordant` + {etag, contenu} actuels) ;
//   3. `transformer(avant)` (pure) : ErreurFormat → 422, ErreurHttp → telle quelle, rien n'est écrit ;
//      résultat identique → `inchange: true`, rien n'est écrit ;
//   4. « Garder la mienne » (`ecraser: true`) : la version externe est d'abord mise en instantané `-ecrasee` ;
//   5. intention durable (fsync) dans CARNET_ETAT, écriture atomique avec re-vérification de l'etag juste avant le
//      rename, index + SSE, journal d'attribution, attestation éventuelle, mémorisation de la requête, validation.
// LIMITE ASSUMÉE : le verrou ne protège que les écrivains Carnet ; un écrivain externe (Obsidian, git,
// agent) qui écrit entre la re-vérification et le rename n'est pas détecté (fenêtre de quelques millisecondes).
//
// INTERBLOCAGE : `ecrire` prend le verrou. Depuis un code qui le tient déjà (verrou.executer), appeler
// `ecrireSousVerrou` / `creerUniqueSousVerrou`.
import "./analyseur-yaml.ts";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { horodatageIso } from "../../shared/identifiants.ts";
import { decouper, lireChampSimple, nomDeFichier } from "../../shared/page.ts";
import { ErreurFormat } from "../../shared/proprietes.ts";
import { Attestations } from "./attestations.ts";
import type { Attestation, DemandeAttestation } from "./attestations.ts";
import type { Config } from "./config.ts";
import { creerDossiers, ecrireAtomique, etagDe, lireConfine, lstatOuNull, resoudre, verifierEcriture } from "./disque.ts";
import type { Verrou } from "./disque.ts";
import type { Changements, Espace } from "./espace.ts";
import { contenuVerrouille } from "./espace.ts";
import { ErreurHttp, journal as journalStdout, normEtag } from "./http.ts";
import { Instantanes } from "./historique.ts";
import type { GenreInstantane } from "./historique.ts";
import { dossierJournal, Intentions, JournalEcritures, jsonCanonique, RegistreRequetes, sha256 } from "./journal-ecritures.ts";
import type { Intention } from "./journal-ecritures.ts";
import { exigerZoneAutorisee, zoneInterdite } from "./securite.ts";

/**
 * Lot 6 « verrou » : écritures d'un geste dans le CONTENU refusées (423) sur une page `verrou: true`, sauf la demande
 * explicite qui pose ou retire le drapeau (`deverrouiller`). Non concernées : liens réécrits après un renommage
 * ailleurs (« liens »), décisions (geste délibéré du lot 3), mouvements (renommer par le menu, déplacer, corbeille).
 */
const ACTIONS_VERROUILLEES = new Set(["page", "tache", "meta", "propriete", "titre", "restauration", "retour-vue"]); // + lot 5 : retour à la version vue

/** Écritures d'un geste dans la page qui ouvrent une « séance » (versions automatiques du lot 4). */
const ACTIONS_SEANCE = new Set(["page", "tache", "meta", "propriete", "decision"]);

export const MAX_PAGE = 2 * 1024 * 1024;
const MAX_LECTURE = 5 * 1024 * 1024;

/**
 * Révision « existante » : le fichier doit exister, sans contrôle d'etag ; le `transformer` vérifie lui-même ce qu'il
 * modifie (ex. /api/tache compare la ligne attendue). Réservé aux routes qui font ce contrôle de contenu.
 */
export const REVISION_EXISTANTE = "existante";

/** Identifiant d'idempotence accepté (UUID ou équivalent). */
export const RE_REQUETE = /^[A-Za-z0-9_-]{8,100}$/;

export interface DemandeEcriture {
  /** Segments déjà validés (cheminPage). */
  chemin: string[];
  /** etag attendu ; null = création (412 `existe` si le fichier existe) ; REVISION_EXISTANTE (voir ci-dessus). */
  revision: string | null;
  /** "page" | "meta" | "tache" | "capture" | "base-cellule" | "base-vue" | "decision" | … (journalisé). */
  action: string;
  /** Pure, sans effet de bord ; reçoit le contenu ACTUEL sous verrou (null si absent). */
  transformer: (avant: string | null) => string;
  /** Identifiant d'idempotence (en-tête X-Carnet-Requete, UUID par geste côté client). */
  requete?: string;
  /** Paramètres de l'appel (JSON, sans le callback) : même `requete` + autre `operation` = 409 requete_reutilisee. */
  operation?: unknown;
  /** « Garder la mienne » (action "page" seulement) : `revision` = etag reçu dans le 412 ; instantané `-ecrasee` d'abord. */
  ecraser?: boolean;
  /** Attestation signée à ajouter APRÈS l'écriture (geste humain engageant, lot 3). */
  attester?: DemandeAttestation;
  /**
   * Lot 5 : la version REMPLACÉE est d'abord gardée en instantané de ce genre (ex. « avant-retour » : retour à la
   * version marquée vue), sous le verrou, juste avant l'écriture ; son id est rendu dans `ResultatEcriture.instantane`.
   */
  instantaneAvant?: GenreInstantane;
  /** Lot 6 : seule écriture admise sur une page verrouillée : poser / retirer la propriété `verrou` (POST /api/propriete). */
  deverrouiller?: boolean;
}

/** Écriture retrouvée ni faite ni abandonnée à la reprise (lot 5 : persistée, listée, « traitée » à la main). */
export interface Indeterminee {
  id: string;
  chemin: string;
  action: string;
  t: string;
  vers?: string;
  avant?: string | null;
  apres?: string | null;
}

export interface ResultatEcriture {
  etag: string;
  mtime: number;
  inchange: boolean;
  rejoue: boolean;
  /** Chemin écrit (utile après creerUnique). */
  chemin: string;
  /** Attestation ajoutée (si `attester`). */
  attestation?: Attestation;
  /** Instantané de la version remplacée (si `instantaneAvant`), ex. `inst:20261011-021403-117-retour`. */
  instantane?: string;
}

export interface DemandeCreationUnique extends Omit<DemandeEcriture, "chemin" | "revision" | "ecraser"> {
  /** Dossier de destination (segments validés, "" = racine). */
  dossier: string[];
  /** Nom souhaité, sans extension (passé par nomDeFichier). */
  base: string;
  /** Nom du k-ième essai (k ≥ 2) ; défaut : « base (k) ». */
  nommer?: (base: string, k: number) => string;
}

/** Renommer, déplacer, supprimer une page. */
export interface DemandeMouvement {
  /** « restaurer » (lot 5) : sortie de la corbeille, source = `.corbeille/<id>`, destination = chemin restauré. */
  action: "renommer" | "deplacer" | "supprimer" | "restaurer";
  /** Page source (segments validés, « .md »). */
  chemin: string[];
  /** Destination logique connue d'avance (null pour une suppression : la corbeille). */
  vers: string | null;
  /** etag attendu de la source (facultatif ; 412 `etag_discordant` s'il ne correspond pas). */
  revision?: string;
  requete?: string;
  operation?: unknown;
}

type Publier = (ch: Changements) => void;

function sansRejoue(r: ResultatEcriture): ResultatEcriture {
  return { ...r, rejoue: false };
}

export class Ecrivain {
  cfg: Config;
  espace: Espace;
  verrou: Verrou;
  publier: Publier;
  /** Journal d'attribution : dernieres(chemin, n), contenuDejaEcritParCarnet(chemin, etag). */
  journal: JournalEcritures;
  attestations: Attestations;
  instantanes: Instantanes;
  /**
   * Intentions retrouvées ni faites ni abandonnées à la reprise (signalées, jamais « réparées »). Lot 5 : persistées
   * dans `indeterminees.json` (journal de l'espace), rechargées au démarrage, retirées par `traiterIndeterminee`.
   */
  indeterminees: Indeterminee[] = [];
  #fichierIndeterminees: string;
  #requetes: RegistreRequetes<ResultatEcriture>;
  #intentions: Intentions;

  constructor(cfg: Config, espace: Espace, verrou: Verrou, publier: Publier) {
    this.cfg = cfg;
    this.espace = espace;
    this.verrou = verrou;
    this.publier = publier;
    const dossier = dossierJournal(cfg);
    this.journal = new JournalEcritures(dossier);
    this.attestations = new Attestations(cfg, dossier);
    this.instantanes = new Instantanes(cfg);
    this.#requetes = new RegistreRequetes<ResultatEcriture>(dossier);
    this.#intentions = new Intentions(dossier);
    this.#fichierIndeterminees = path.join(dossier, "indeterminees.json");
  }

  ecrire(d: DemandeEcriture, principal: string): Promise<ResultatEcriture> {
    return this.verrou.executer(() => this.ecrireSousVerrou(d, principal));
  }

  creerUnique(d: DemandeCreationUnique, principal: string): Promise<ResultatEcriture> {
    return this.verrou.executer(() => this.creerUniqueSousVerrou(d, principal));
  }

  /** Comme `ecrire`, quand l'appelant tient DÉJÀ le verrou. */
  async ecrireSousVerrou(d: DemandeEcriture, principal: string): Promise<ResultatEcriture> {
    const chemin = d.chemin.join("/");
    const req = await this.#idempotence(d.requete, principal, { action: d.action, chemin, operation: d.operation ?? null });
    if (req && "rejeu" in req) return req.rejeu;
    return this.#executer(d, principal, req);
  }

  /**
   * Rejeu seul (sans écrire) : résultat mémorisé de cette requête idempotente, ou null. 409 si l'identifiant a servi pour
   * une autre opération. Pour les routes qui doivent répondre une erreur d'en-tête AVANT d'appeler ecrireSousVerrou.
   */
  async rejeuSousVerrou(d: Pick<DemandeEcriture, "chemin" | "action" | "requete" | "operation">, principal: string): Promise<ResultatEcriture | null> {
    const req = await this.#idempotence(d.requete, principal, { action: d.action, chemin: d.chemin.join("/"), operation: d.operation ?? null });
    return req && "rejeu" in req ? req.rejeu : null;
  }

  /**
   * Renommer / déplacer / supprimer par la même porte, quand l'appelant tient le verrou : idempotence,
   * révision de la source, intention durable, `faire()` (qui doit créer la destination de façon EXCLUSIVE : link,
   * jamais d'écrasement), journal (`chemin` → `vers`), validation. `faire` renvoie le résultat HTTP et la destination finale.
   */
  async mouvementSousVerrou<T>(m: DemandeMouvement, principal: string, faire: () => Promise<{ resultat: T; vers: string | null }>): Promise<T> {
    const chemin = m.chemin.join("/");
    const req = await this.#idempotence(m.requete, principal, { action: m.action, chemin, operation: m.operation ?? null });
    if (req && "rejeu" in req) return req.rejeu as unknown as T;
    const src = await verifierEcriture(this.cfg, m.chemin);
    let avant: string | null = null;
    let contenu: string | null = null;
    if (src.st && src.st.isFile()) {
      contenu = await this.#lire(src.abs);
      avant = etagDe(contenu);
    }
    if (m.revision !== undefined && normEtag(m.revision) !== avant) {
      throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", { etag: avant, contenu });
    }
    const t = horodatageIso(new Date(), this.cfg.fuseau);
    const intention: Intention = {
      type: "intention", id: crypto.randomUUID(), t, principal, action: m.action, chemin, ...(m.vers ? { vers: m.vers } : {}),
      avant, apres: m.action === "supprimer" ? null : avant, requete: req?.requete ?? null, mouvement: true,
      ...(req ? { cleRequete: req.cle, empreinteRequete: req.empreinte } : {}),
    };
    await this.#intentions.noter(intention);
    let r: { resultat: T; vers: string | null };
    try {
      r = await faire();
    } catch (e) {
      await this.#intentions.valider(intention.id, t, "abandonnee").catch(() => {});
      throw e;
    }
    if (r.vers !== chemin) {
      await this.journal.ajouter({
        t, principal, client: null, action: m.action, chemin, ...(r.vers ? { vers: r.vers } : {}), avant, apres: intention.apres, requete: intention.requete,
      });
    }
    if (req) await this.#requetes.enregistrer({ cle: req.cle, empreinte: req.empreinte, t: Date.now(), resultat: r.resultat as unknown as ResultatEcriture });
    await this.#intentions.valider(intention.id, horodatageIso(new Date(), this.cfg.fuseau));
    await this.#entretien();
    return r.resultat;
  }

  /**
   * Crée une page sous un nom LIBRE du dossier : « base.md », puis « base (2).md »… (ou `nommer`), création exclusive
   * (jamais d'écrasement, même face à un écrivain externe). Le dossier « base/ » homonyme doit aussi être libre.
   */
  async creerUniqueSousVerrou(d: DemandeCreationUnique, principal: string): Promise<ResultatEcriture> {
    const base = nomDeFichier(d.base);
    const req = await this.#idempotence(d.requete, principal, { action: d.action, dossier: d.dossier.join("/"), base, operation: d.operation ?? null });
    if (req && "rejeu" in req) return req.rejeu;
    const nommer = d.nommer ?? ((b: string, k: number) => `${b} (${k})`);
    for (let k = 1; k <= 1000; k++) {
      const nom = k === 1 ? base : nommer(base, k);
      const segs = [...d.dossier, nom + ".md"];
      exigerZoneAutorisee(this.cfg, segs);
      if (zoneInterdite(this.cfg, [...d.dossier, nom])) continue;
      const md = await verifierEcriture(this.cfg, segs);
      const dir = await verifierEcriture(this.cfg, [...d.dossier, nom]);
      if (md.st || dir.st) continue;
      try {
        return await this.#executer({ ...d, chemin: segs, revision: null }, principal, req);
      } catch (e) {
        if (e instanceof ErreurHttp && e.statut === 412 && e.raison === "existe") continue;
        throw e;
      }
    }
    throw new ErreurHttp(409, "Trop de pages portent déjà ce nom.", "conflit_nom");
  }

  async #idempotence(requete: string | undefined, principal: string, objet: unknown): Promise<{ cle: string; empreinte: string; requete: string } | { rejeu: ResultatEcriture } | null> {
    if (requete === undefined) return null;
    if (typeof requete !== "string" || !RE_REQUETE.test(requete)) {
      throw new ErreurHttp(400, "Identifiant de requête invalide (en-tête X-Carnet-Requete : 8 à 100 caractères A-Z, a-z, 0-9, « - », « _ »).", "requete_invalide");
    }
    const cle = RegistreRequetes.cle(principal, requete);
    const empreinte = sha256(jsonCanonique(objet));
    const deja = await this.#requetes.trouver(cle);
    if (deja) {
      if (deja.empreinte !== empreinte) throw new ErreurHttp(409, "Cet identifiant de requête a déjà servi pour une autre opération.", "requete_reutilisee");
      return { rejeu: { ...deja.resultat, rejoue: true } };
    }
    return { cle, empreinte, requete };
  }

  async #lire(abs: string): Promise<string> {
    try {
      return (await lireConfine(this.cfg, abs, MAX_LECTURE)).contenu;
    } catch (e) {
      if (e instanceof ErreurHttp && e.statut === 404) throw new ErreurHttp(412, "La page n'existe plus.", "page_absente", { etag: null, contenu: null });
      throw new ErreurHttp(409, "Page illisible.", "illisible");
    }
  }

  async #actuel(abs: string): Promise<{ etag: string | null; contenu: string | null }> {
    try {
      const c = (await lireConfine(this.cfg, abs, MAX_LECTURE)).contenu;
      return { etag: etagDe(c), contenu: c };
    } catch {
      return { etag: null, contenu: null };
    }
  }

  async #executer(d: DemandeEcriture, principal: string, req: { cle: string; empreinte: string; requete: string } | null): Promise<ResultatEcriture> {
    const segs = d.chemin;
    const chemin = segs.join("/");
    if (d.ecraser) {
      if (d.action !== "page") throw new ErreurHttp(400, "Écraser n'est permis que pour l'enregistrement d'une page.", "ecraser_interdit");
      if (d.revision === null || d.revision === REVISION_EXISTANTE) {
        throw new ErreurHttp(400, "Écraser exige la révision reçue dans le conflit (412).", "ecraser_sans_revision");
      }
    }
    const { abs, st } = await verifierEcriture(this.cfg, segs);
    let avant: string | null = null;
    if (st) {
      if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas un fichier.", "pas_un_fichier");
      avant = await this.#lire(abs);
    }
    const etagAvant = avant === null ? null : etagDe(avant);
    // révision attendue
    if (d.revision === null) {
      if (avant !== null) throw new ErreurHttp(412, "La page existe déjà.", "existe", { etag: etagAvant, contenu: avant });
    } else if (d.revision === REVISION_EXISTANTE) {
      if (avant === null) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
    } else {
      if (avant === null) throw new ErreurHttp(412, "La page n'existe plus.", "page_absente", { etag: null, contenu: null });
      if (normEtag(d.revision) !== etagAvant) {
        throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", { etag: etagAvant, contenu: avant });
      }
    }
    // lot 6 : page verrouillée (drapeau anti-fausse manipulation, pas une ACL)
    if (avant !== null && !d.deverrouiller && ACTIONS_VERROUILLEES.has(d.action) && contenuVerrouille(avant)) {
      throw new ErreurHttp(423, "Page verrouillée contre les fausses manipulations : déverrouille-la d'abord (les agents peuvent toujours écrire le fichier).", "page_verrouillee", { raison: "page_verrouillee", etag: etagAvant });
    }
    // transformation (la validation)
    let apres: string;
    try {
      apres = d.transformer(avant);
    } catch (e) {
      if (e instanceof ErreurFormat) throw new ErreurHttp(422, e.message, e.raison);
      throw e;
    }
    if (typeof apres !== "string") throw new Error("Ecrivain : le transformer doit renvoyer du texte");
    if (Buffer.byteLength(apres) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
    if (avant !== null && apres === avant) {
      const res: ResultatEcriture = { etag: etagAvant!, mtime: Math.floor(st!.mtimeMs), inchange: true, rejoue: false, chemin };
      if (req) await this.#requetes.enregistrer({ cle: req.cle, empreinte: req.empreinte, t: Date.now(), resultat: res });
      return res;
    }
    let attestation: Attestation | undefined;
    if (d.attester) {
      try {
        attestation = this.attestations.preparer(d.attester, principal, chemin);
      } catch (e) {
        throw new ErreurHttp(400, `Attestation refusée : ${(e as Error).message}.`, "attestation_invalide");
      }
    }
    let instantane: string | undefined;
    if (d.ecraser && avant !== null) await this.instantanes.creer(segs, avant, false, "ecrasee");
    // Lot 5 : version remplacée gardée (retour à la version vue : « version annulée conservée »)
    else if (d.instantaneAvant && avant !== null) instantane = (await this.instantanes.creer(segs, avant, d.instantaneAvant)).id;
    // Lot 4 (versions automatiques, branchées ici à l'intégration) : au premier enregistrement par Carnet après une
    // pause de travail sur la page (CARNET_PAUSE_VERSIONS minutes), la version d'AVANT est gardée en instantané
    // « -seance ». Jamais bloquant (une erreur est journalisée par Instantanes.seance).
    else if (avant !== null && ACTIONS_SEANCE.has(d.action)) await this.instantanes.seance(segs, avant, st!.mtimeMs, this.cfg.pauseVersions * 60_000);

    const etagApres = etagDe(apres);
    const t = horodatageIso(new Date(), this.cfg.fuseau);
    const auteur = lireChampSimple(decouper(apres).yaml, "maj_par");
    const intention: Intention = {
      type: "intention", id: crypto.randomUUID(), t, principal, action: d.action, chemin, avant: etagAvant, apres: etagApres,
      requete: req?.requete ?? null, ...(req ? { cleRequete: req.cle, empreinteRequete: req.empreinte } : {}),
      ...(attestation ? { attestation } : {}), ...(auteur ? { auteur_declare: auteur.slice(0, 200) } : {}),
      ...(instantane ? { instantane } : {}),
    };
    await this.#intentions.noter(intention);
    let stN: fs.Stats;
    try {
      if (avant === null) {
        await creerDossiers(this.cfg, path.dirname(abs));
        stN = await ecrireAtomique(abs, apres, { exclusif: true, avantRenommage: async () => this.#panne("avant-rename", chemin) });
      } else {
        stN = await ecrireAtomique(abs, apres, {
          avantRenommage: async () => {
            const a = await this.#actuel(abs);
            if (a.etag !== etagAvant) throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", a);
            this.#panne("avant-rename", chemin);
          },
        });
      }
      this.#panne("apres-rename", chemin);
    } catch (e) {
      await this.#intentions.valider(intention.id, t, "abandonnee").catch(() => {});
      if (e instanceof ErreurHttp && e.raison === "existe") {
        throw new ErreurHttp(412, "La page existe déjà.", "existe", await this.#actuel(abs));
      }
      throw e;
    }
    this.publier(await this.espace.majPage(segs, apres, stN));
    const res = await this.#terminer(intention, Math.floor(stN.mtimeMs));
    return res;
  }

  /** Après l'écriture (ou à la reprise) : journal, attestation, requête mémorisée, validation. */
  async #terminer(i: Intention, mtime: number, reprise = false): Promise<ResultatEcriture> {
    // Reprise : l'entrée n'est sautée que si CETTE écriture est déjà au journal (arrêt entre le journal et la validation :
    // même horodatage d'intention, même version, même requête). Lot 5 : avant, un contenu identique écrit plus tôt à ce
    // chemin suffisait à la sauter (deux gestes au même contenu = une seule entrée, renvoi idempotent introuvable).
    const dejaJournalisee = reprise && this.journal.dernieres(i.chemin, 50)
      .some((e) => e.t === i.t && e.apres === i.apres && (e.requete ?? null) === (i.requete ?? null));
    if (!dejaJournalisee) {
      await this.journal.ajouter({
        t: i.t, principal: i.principal, client: null, action: i.action, chemin: i.chemin, ...(i.vers ? { vers: i.vers } : {}),
        avant: i.avant, apres: i.apres, requete: i.requete, ...(i.auteur_declare ? { auteur_declare: i.auteur_declare } : {}),
        ...(reprise ? { reprise: true as const } : {}),
      });
    }
    const attestation = i.attestation as Attestation | undefined;
    if (attestation && !(await this.attestations.parId(attestation.id))) await this.attestations.ajouter(attestation);
    const res: ResultatEcriture = {
      etag: i.apres ?? "", mtime, inchange: false, rejoue: false, chemin: i.vers ?? i.chemin, ...(attestation ? { attestation } : {}),
      ...(typeof i.instantane === "string" ? { instantane: i.instantane } : {}),
    };
    if (i.cleRequete && i.empreinteRequete) {
      await this.#requetes.enregistrer({ cle: i.cleRequete, empreinte: i.empreinteRequete, t: Date.now(), resultat: sansRejoue(res) });
    }
    await this.#intentions.valider(i.id, horodatageIso(new Date(), this.cfg.fuseau));
    await this.#entretien();
    return res;
  }

  #validations = 0;
  /** Toutes les 500 écritures (sous verrou) : intentions vidées si rien n'est en attente, requêtes de plus de 7 jours retirées. */
  async #entretien(): Promise<void> {
    if (++this.#validations % 500 !== 0) return;
    await this.#intentions.compacter().catch(() => {});
    await this.#requetes.compacter().catch(() => {});
  }

  /** Mouvement interrompu : source partie et destination présente = fait ; source encore là = abandonné ; sinon indéterminé. */
  async #etatMouvement(i: Intention): Promise<"faite" | "abandonnee" | "indeterminee"> {
    const source = await pagePresente(this.cfg, i.chemin);
    if (i.action === "supprimer") return source ? "abandonnee" : "faite";
    const dest = i.vers ? await pagePresente(this.cfg, i.vers) : false;
    if (dest && !source) return "faite";
    if (source && !dest) return "abandonnee";
    return "indeterminee";
  }

  /**
   * Reprise au démarrage, sous verrou : pour chaque intention sans validation, si l'etag du fichier = `apres`,
   * l'écriture est complétée (journal, attestation, requête) ; si = `avant`, elle est abandonnée ; sinon « indéterminée »
   * (journal du serveur + `indeterminees`). Puis le fichier d'intentions est vidé s'il ne reste rien en attente.
   */
  async reprendre(): Promise<{ faites: number; abandonnees: number; indeterminees: number }> {
    await this.journal.charger();
    await this.#requetes.charger();
    await this.#chargerIndeterminees();
    const avantReprise = this.indeterminees.length;
    const bilan = { faites: 0, abandonnees: 0, indeterminees: 0 };
    for (const i of await this.#intentions.enAttente()) {
      const t = horodatageIso(new Date(), this.cfg.fuseau);
      if (!i.mouvement) await this.#nettoyerTemporaires(i.vers ?? i.chemin);
      if (i.mouvement) {
        const etat = await this.#etatMouvement(i);
        if (etat === "faite") {
          await this.journal.ajouter({
            t: i.t, principal: i.principal, client: null, action: i.action, chemin: i.chemin, ...(i.vers ? { vers: i.vers } : {}),
            avant: i.avant, apres: i.apres, requete: i.requete, reprise: true,
          });
        }
        if (etat === "indeterminee") {
          this.indeterminees.push({ chemin: i.chemin, action: i.action, t: i.t, id: i.id, ...(i.vers ? { vers: i.vers } : {}), avant: i.avant, apres: i.apres });
          journalStdout({ niveau: "avertissement", quoi: "reprise_indeterminee", chemin: i.chemin, action: i.action, intention: i.id });
        }
        await this.#intentions.valider(i.id, t, etat);
        bilan[etat === "faite" ? "faites" : etat === "abandonnee" ? "abandonnees" : "indeterminees"]++;
        continue;
      }
      let etag: string | null = null;
      let mtime = 0;
      try {
        const segs = (i.vers ?? i.chemin).split("/");
        const abs = await resoudre(this.cfg, segs);
        const st = await lstatOuNull(abs);
        if (st && st.isFile()) {
          etag = etagDe((await lireConfine(this.cfg, abs, MAX_LECTURE)).contenu);
          mtime = Math.floor(st.mtimeMs);
        }
      } catch { /* illisible : indéterminée */ }
      if (etag !== null && etag === i.apres) {
        await this.#terminer(i, mtime, true);
        bilan.faites++;
      } else if (etag === i.avant) {
        await this.#intentions.valider(i.id, t, "abandonnee");
        bilan.abandonnees++;
      } else {
        await this.#intentions.valider(i.id, t, "indeterminee");
        this.indeterminees.push({ chemin: i.chemin, action: i.action, t: i.t, id: i.id, ...(i.vers ? { vers: i.vers } : {}), avant: i.avant, apres: i.apres });
        bilan.indeterminees++;
        journalStdout({ niveau: "avertissement", quoi: "reprise_indeterminee", chemin: i.chemin, action: i.action, intention: i.id });
      }
    }
    if (this.indeterminees.length !== avantReprise) await this.#sauverIndeterminees();
    await this.#intentions.compacter().catch(() => {});
    if (bilan.faites || bilan.abandonnees || bilan.indeterminees) journalStdout({ niveau: "info", quoi: "reprise_ecritures", ...bilan });
    if (this.cfg.panneEssai?.length) {
      const l = this.cfg.panneEssai.map((p) => `${p.point}:${p.motif}`).join(",");
      journalStdout({ niveau: "avertissement", quoi: "panne_essai", message: `CARNET_PANNE_ESSAI actif (${l}) : réservé aux recettes, jamais en production.` });
    }
    return bilan;
  }

  // ---------- Lot 5 : écritures indéterminées persistées ----------

  async #chargerIndeterminees(): Promise<void> {
    try {
      const v = JSON.parse(await fsp.readFile(this.#fichierIndeterminees, "utf8")) as { elements?: unknown };
      const l = Array.isArray(v?.elements) ? v.elements : [];
      const connus = new Set(this.indeterminees.map((x) => x.id));
      for (const x of l) {
        if (!x || typeof x !== "object") continue;
        const o = x as Record<string, unknown>;
        if (typeof o.id !== "string" || typeof o.chemin !== "string" || typeof o.action !== "string" || typeof o.t !== "string" || connus.has(o.id)) continue;
        connus.add(o.id);
        this.indeterminees.push({
          id: o.id, chemin: o.chemin, action: o.action, t: o.t, ...(typeof o.vers === "string" ? { vers: o.vers } : {}),
          avant: typeof o.avant === "string" ? o.avant : null, apres: typeof o.apres === "string" ? o.apres : null,
        });
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") journalStdout({ niveau: "avertissement", quoi: "indeterminees_illisibles", erreur: String((e as Error).message).slice(0, 200) });
    }
  }

  async #sauverIndeterminees(): Promise<void> {
    await fsp.mkdir(path.dirname(this.#fichierIndeterminees), { recursive: true, mode: 0o700 });
    await ecrireAtomique(this.#fichierIndeterminees, JSON.stringify({ version: 1, elements: this.indeterminees }) + "\n", { mode: 0o600 });
  }

  /** Écritures indéterminées, avec l'état actuel du fichier (etag ou absent). Chemins masqués exclus. */
  async listerIndeterminees(): Promise<Array<Indeterminee & { vers: string | null; avant: string | null; apres: string | null; actuel: string | null; existe: boolean }>> {
    const res = [];
    for (const x of this.indeterminees) {
      const cible = x.vers ?? x.chemin;
      const segs = cible.split("/");
      if (zoneInterdite(this.cfg, segs) || zoneInterdite(this.cfg, x.chemin.split("/"))) continue;
      let actuel: string | null = null;
      let existe = false;
      try {
        const abs = await resoudre(this.cfg, segs);
        const st = await lstatOuNull(abs);
        if (st && st.isFile()) {
          existe = true;
          actuel = etagDe((await lireConfine(this.cfg, abs, MAX_LECTURE)).contenu);
        }
      } catch { /* illisible : actuel inconnu */ }
      res.push({ ...x, vers: x.vers ?? null, avant: x.avant ?? null, apres: x.apres ?? null, actuel, existe });
    }
    return res;
  }

  /** Retire une écriture indéterminée (la personne a vérifié la page). Renvoie le nombre restant ; 404 si inconnue. */
  traiterIndeterminee(id: unknown): Promise<number> {
    return this.verrou.executer(async () => {
      const i = typeof id === "string" ? this.indeterminees.findIndex((x) => x.id === id) : -1;
      if (i === -1) throw new ErreurHttp(404, "Écriture indéterminée inconnue.", "introuvable");
      this.indeterminees.splice(i, 1);
      await this.#sauverIndeterminees();
      return this.indeterminees.length;
    });
  }

  /**
   * Temporaires orphelins d'une écriture interrompue (`.<nom>.carnet-<aléa>.tmp`, cachés : jamais lus comme pages),
   * dans le dossier de la page dont l'intention est restée en attente. Seul ce motif exact est retiré.
   */
  async #nettoyerTemporaires(chemin: string): Promise<void> {
    try {
      const abs = await resoudre(this.cfg, chemin.split("/"));
      const dossier = path.dirname(abs);
      const prefixe = `.${path.basename(abs).slice(0, 200)}.carnet-`;
      for (const n of await fsp.readdir(dossier)) {
        if (!n.startsWith(prefixe) || !/^[0-9a-f]{12}\.tmp$/.test(n.slice(prefixe.length))) continue;
        const f = path.join(dossier, n);
        const st = await lstatOuNull(f);
        if (st && st.isFile()) await fsp.unlink(f).catch(() => {});
      }
    } catch { /* dossier absent : rien à nettoyer */ }
  }

  /**
   * POINT DE PANNE D'ESSAI (recettes seulement) : `CARNET_PANNE_ESSAI="avant-rename:<sous-chaîne>"` et/ou
   * `"apres-rename:<sous-chaîne>"` (plusieurs points séparés par des virgules). Quand une écriture dont le chemin contient la sous-chaîne atteint ce point, le serveur
   * crée `CARNET_ETAT/panne-essai-<point>.faite` (création exclusive : UNE seule panne par fichier) puis se tue (SIGKILL),
   * comme une coupure de courant : rien n'est terminé proprement. Inactif sans la variable (jamais en production).
   */
  #panne(point: "avant-rename" | "apres-rename", chemin: string): void {
    if (!this.cfg.panneEssai?.some((p) => p.point === point && chemin.includes(p.motif))) return;
    try {
      fs.mkdirSync(this.cfg.etat, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(this.cfg.etat, `panne-essai-${point}.faite`), horodatageIso(new Date(), this.cfg.fuseau) + " " + chemin + "\n", { flag: "wx", mode: 0o600 });
    } catch {
      return; // déjà faite (ou état illisible) : pas de seconde panne
    }
    process.kill(process.pid, "SIGKILL");
  }
}

/** Page (fichier .md ou dossier homonyme) présente à ce chemin logique ? */
async function pagePresente(cfg: Config, chemin: string): Promise<boolean> {
  const segs = chemin.split("/");
  if (await lstatOuNull(await resoudre(cfg, segs))) return true;
  const dossier = [...segs.slice(0, -1), segs[segs.length - 1].replace(/\.md$/, "")];
  return (await lstatOuNull(await resoudre(cfg, dossier))) !== null;
}

/**
 * Premier nom libre du dossier (« base.md », « base (2).md »…), sans rien créer : indicatif seulement (un autre écrivain
 * peut le prendre aussitôt). Pour créer, utiliser Ecrivain.creerUnique (création exclusive).
 */
export async function nomUnique(cfg: Config, dossier: string[], base: string): Promise<string[]> {
  const b = nomDeFichier(base);
  for (let k = 1; k <= 1000; k++) {
    const nom = k === 1 ? b : `${b} (${k})`;
    if (zoneInterdite(cfg, [...dossier, nom]) || zoneInterdite(cfg, [...dossier, nom + ".md"])) continue;
    const md = await verifierEcriture(cfg, [...dossier, nom + ".md"]);
    const dir = await verifierEcriture(cfg, [...dossier, nom]);
    if (!md.st && !dir.st) return [...dossier, nom + ".md"];
  }
  throw new ErreurHttp(409, "Trop de pages portent déjà ce nom.", "conflit_nom");
}
