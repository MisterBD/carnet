// Carnet · lot 3 : demandes de décision : liste, lecture (proposition, empreinte, preuve, historique vérifié), geste
// humain (Approuver · Demander une correction · Refuser), création d'une demande depuis le modèle.
// Le Markdown d'une décision est une DÉCLARATION ; seule une attestation signée hors de l'espace (et, si une clé d'accès
// est enregistrée, signée aussi par l'appareil de la personne) prouve le geste. Format : shared/decision.ts et
// docs/format-agents.md. Toute écriture passe par la porte unique du socle (Ecrivain), attestation comprise.
import crypto from "node:crypto";
import {
  ajouterEnregistrement, analyserDemande, formaterEnregistrement, jsonCanonique, lireEnregistrements, maillonDeclare, METHODE_EMPREINTE,
  modeleDemande, normaliserCommentaire, porteeBase, porteeChainee, porteeDe, RESULTATS, STATUT_ATTENTE, STATUT_DE, TYPE_DECISION,
} from "../../shared/decision.ts";
import type { Demande, EnregistrementLu, Geste, ResultatDecision } from "../../shared/decision.ts";
import { horodatageIso, nouvelIdentifiant } from "../../shared/identifiants.ts";
import { decouper, feuille } from "../../shared/page.ts";
import { poserPropriete } from "../../shared/proprietes.ts";
import type { Attestation } from "./attestations.ts";
import type { Cles } from "./cles.ts";
import type { Config } from "./config.ts";
import { definirCalculDecision, preuveDecision } from "./decisions.ts";
import type { PreuveDecision } from "./decisions.ts";
import { etagDe, lireConfine, lstatOuNull, resoudre } from "./disque.ts";
import type { Ecrivain } from "./ecriture.ts";
import { lireFrontmatter } from "./espace.ts";
import type { Espace, Page } from "./espace.ts";
import { chaine, ErreurHttp } from "./http.ts";
import { cheminPage, exigerZoneAutorisee } from "./securite.ts";

export function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

export function empreinteDe(entree: string): string {
  return "sha256:" + sha256Hex(entree);
}

export const RE_EMPREINTE = /^sha256:[0-9a-f]{64}$/;

/** Empreinte d'un commentaire (null s'il est vide), telle qu'elle entre dans la portée de l'attestation. */
export function empreinteCommentaire(c: string): string | null {
  const n = normaliserCommentaire(c);
  return n ? "sha256:" + sha256Hex(n) : null;
}

/** Analyse complète d'une page (frontmatter lu par l'index du serveur, YAML 1.2). */
export function analyserContenu(contenu: string, fm?: Record<string, unknown> | null): { d: Demande; empreinte: string | null } {
  const f = fm === undefined ? lireFrontmatter(decouper(contenu).yaml) : fm;
  const d = analyserDemande(contenu, f);
  return { d, empreinte: d.entree !== null ? empreinteDe(d.entree) : null };
}

// La preuve renvoyée par GET /api/page (socle) utilise la MÊME méthode d'empreinte que les gestes du lot 3.
definirCalculDecision(METHODE_EMPREINTE, (contenu) => {
  const { d, empreinte } = analyserContenu(contenu);
  return { demande: d.id, empreinte, statut: d.statut };
});

/** Maillon de chaînage d'une attestation : `sha256:` du JSON canonique de la ligne entière (signature comprise). */
export function maillonDe(a: Attestation): string {
  return "sha256:" + sha256Hex(jsonCanonique(a));
}

/**
 * Coupures du journal : indices (dans la liste des attestations VALIDES, ordre du fichier) des attestations chaînées
 * dont le maillon ne correspond pas à l'attestation précédente : une ligne a disparu juste avant.
 */
export function coupuresJournal(valides: Attestation[]): number[] {
  const c: number[] = [];
  for (let i = 0; i < valides.length; i++) {
    const m = maillonDeclare(valides[i].portee);
    if (m === null) continue; // attestation non chaînée (antérieure au lot 3) : rien à vérifier
    if (m !== (i === 0 ? "aucune" : maillonDe(valides[i - 1]))) c.push(i);
  }
  return c;
}

/** Vérifie un enregistrement « ## Décision » lu dans le fichier contre la chaîne des attestations de sa demande. */
export function verifierEnregistrement(e: EnregistrementLu, chaineAtt: Attestation[]): { verification: "attestee" | "remplacee" | "non-attestee"; attestation: Attestation | null } {
  if (!e.decision || !e.demande || !e.empreinte || !e.resultat) return { verification: "non-attestee", attestation: null };
  const portee = porteeDe(e.decision, empreinteCommentaire(e.commentaire));
  const i = chaineAtt.findIndex((a) => a.demande === e.demande && a.empreinte === e.empreinte && a.resultat === e.resultat && porteeBase(a.portee) === portee);
  if (i === -1) return { verification: "non-attestee", attestation: null };
  return { verification: i === chaineAtt.length - 1 ? "attestee" : "remplacee", attestation: chaineAtt[i] };
}

export interface VueDecision {
  chemin: string;
  etag: string;
  titre: string;
  estDecision: boolean;
  id: string | null;
  statut_declare: string | null;
  demandee_par: string | null;
  echeance: string | null;
  cree: string | null;
  proposition: string | null;
  engage: Array<{ cle: string; presente: boolean; valeur: unknown }>;
  empreinte: string | null;
  methode: string;
  bloquants: string[];
  manques: string[];
  /** K10-04 : rubriques requises pour APPROUVER (objet, action demandée) absentes ou vides. */
  vides: string[];
  /** Une décision peut être prise maintenant sur la proposition actuelle. */
  decidable: boolean;
  /** K10-04 : « Approuver » possible (décidable ET objet et action renseignés) ; « à corriger » et « refuser » non concernés. */
  approuvable: boolean;
  /** Pourquoi on ne peut pas approuver (si décidable mais incomplète). */
  raison_approbation: string | null;
  /** Pourquoi elle ne peut pas l'être (déjà décidée, demande incomplète…). */
  raison: string | null;
  /** Preuve calculée par le socle (même objet que GET /api/page), plus la date de l'attestation qui fait foi. */
  preuve: PreuveDecision & { t: string | null; journalCoupe: boolean };
  enregistrements: Array<EnregistrementLu & { verification: "attestee" | "remplacee" | "non-attestee"; geste_atteste: string | null }>;
  attestations: Attestation[];
}

/** K10-04 : message lisible des rubriques requises manquantes. */
export function messageVides(vides: string[]): string {
  const noms = vides.map((v) => `«\u00a0${v}\u00a0»`).join(" et ");
  return `Proposition non renseignée\u00a0: ${noms} ${vides.length > 1 ? "sont vides" : "est vide"}. Complète la proposition avant d'approuver (tu peux demander une correction ou refuser).`;
}

function refuserSiVide(vides: string[]): void {
  if (vides.length) throw new ErreurHttp(422, messageVides(vides), "proposition_incomplete", { raison: "proposition_incomplete", vides });
}

export class Demandes {
  #cfg: Config;
  #espace: Espace;
  #ecrivain: Ecrivain;
  #cles: Cles;
  /** Gestes sérialisés : le maillon de chaînage et l'ajout de l'attestation ne s'entrelacent jamais. */
  #file: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config, espace: Espace, ecrivain: Ecrivain, cles: Cles) {
    this.#cfg = cfg;
    this.#espace = espace;
    this.#ecrivain = ecrivain;
    this.#cles = cles;
  }

  /** Journal entier : attestations valides (ordre du fichier) et coupures détectées par le chaînage. */
  async journal(): Promise<{ valides: Attestation[]; coupures: number[] }> {
    const valides = (await this.#ecrivain.attestations.lister()).filter((x) => x.valide).map((x) => x.attestation);
    return { valides, coupures: coupuresJournal(valides) };
  }

  /** Attestations VALIDES d'une demande, de la plus ancienne à la plus récente. */
  async chaine(demande: string): Promise<Attestation[]> {
    return (await this.#ecrivain.attestations.lister({ demande })).filter((x) => x.valide).map((x) => x.attestation);
  }

  async analyser(chemin: string, contenu: string, fm?: Record<string, unknown> | null, titre?: string): Promise<VueDecision> {
    const { d, empreinte } = analyserContenu(contenu, fm);
    const ch = d.id ? await this.chaine(d.id) : [];
    const enreg = lireEnregistrements(contenu);
    const vide: PreuveDecision = {
      etat: "absente", demande: d.id, empreinte, resultat: null, portee: null, attestationId: null, geste: null, declarationConforme: null, methode: METHODE_EMPREINTE,
    };
    let preuve = (await preuveDecision(this.#ecrivain.attestations, contenu)) ?? vide;
    if (d.id && this.#ecrivain.indeterminees.some((x) => x.chemin === chemin && x.action === "decision")) preuve = { ...preuve, etat: "indeterminee" };
    const tPreuve = preuve.attestationId ? ch.find((a) => a.id === preuve.attestationId)?.t ?? null : null;
    // Chaînage : une ligne disparue APRÈS la dernière attestation de cette demande a pu être une décision plus récente
    // (un refus effacé ferait redevenir « dernière » une approbation) : la preuve devient indéterminée.
    let journalCoupe = false;
    if (d.id) {
      const j = await this.journal();
      let derniere = -1;
      for (let i = j.valides.length - 1; i >= 0; i--) if (j.valides[i].demande === d.id) { derniere = i; break; }
      journalCoupe = derniere >= 0 && j.coupures.some((i) => i > derniere);
      if (journalCoupe) preuve = { ...preuve, etat: "indeterminee" };
    }
    let raison: string | null = null;
    if (!d.estDecision) raison = "Cette page n'est pas une demande de décision (type: decision).";
    else if (d.bloquants.length) raison = d.bloquants[0];
    else if (preuve.etat === "indeterminee") raison = "Une décision précédente n'a pas pu être confirmée : vérifie l'historique avant de décider à nouveau.";
    else if (empreinte && ch.some((a) => a.empreinte === empreinte)) {
      const a = [...ch].reverse().find((x) => x.empreinte === empreinte)!;
      raison = `Cette proposition a déjà reçu une décision (${a.resultat}). Une nouvelle proposition impose une nouvelle décision.`;
    }
    return {
      chemin, etag: etagDe(contenu), titre: titre ?? (decouper(contenu).titreH1 || feuille(chemin)),
      estDecision: d.estDecision, id: d.id, statut_declare: d.statut, demandee_par: d.demandeePar, echeance: d.echeance, cree: d.cree,
      proposition: d.proposition, engage: d.engage, empreinte, methode: METHODE_EMPREINTE, bloquants: d.bloquants, manques: d.manques,
      vides: d.vides, decidable: raison === null, raison, approuvable: raison === null && !d.vides.length,
      raison_approbation: d.vides.length ? messageVides(d.vides) : null,
      preuve: { ...preuve, t: tPreuve, journalCoupe },
      enregistrements: enreg.map((e) => {
        const v = verifierEnregistrement(e, ch);
        return { ...e, verification: v.verification, geste_atteste: v.attestation?.geste ?? null };
      }),
      attestations: ch,
    };
  }

  /** Statut EFFECTIF (calculé, jamais seulement déclaré) d'une demande. */
  static statutEffectif(v: VueDecision): string {
    if (v.decidable) return STATUT_ATTENTE;
    if (v.preuve.etat === "valide" && v.preuve.resultat) return v.preuve.resultat;
    if (v.preuve.etat === "indeterminee" && !v.bloquants.length) return "indéterminée";
    if (v.bloquants.length) return "incomplète";
    return v.preuve.resultat ?? "incomplète";
  }

  async lister(filtre: string | null): Promise<Array<Record<string, unknown>>> {
    // lot 6 : une demande archivée ou le modèle « Décision » (dossier Modèles/) ne sont pas des décisions à prendre
    const pages = this.#espace.pagesCourantes().filter((p: Page) => p.fm && p.fm.type === TYPE_DECISION);
    const res: Array<Record<string, unknown> & { _tri: [number, number, string] }> = [];
    for (const p of pages) {
      const v = await this.analyser(p.chemin, p.contenu, p.fm, p.titre);
      const statut = Demandes.statutEffectif(v);
      if (filtre && filtre !== statut) continue;
      const der = v.enregistrements.length ? v.enregistrements[v.enregistrements.length - 1] : null;
      const ech = v.echeance && /^\d{4}-\d{2}-\d{2}/.test(v.echeance) ? Date.parse(v.echeance.slice(0, 10)) : Number.POSITIVE_INFINITY;
      const derAtt = v.attestations.length ? v.attestations[v.attestations.length - 1] : null;
      res.push({
        chemin: p.chemin, titre: p.titre, icone: p.icone, id: v.id, statut, statut_declare: v.statut_declare, demandee_par: v.demandee_par,
        echeance: v.echeance, cree: v.cree ?? new Date(p.mtime).toISOString(), mtime: p.mtime,
        preuve: { etat: v.preuve.etat, resultat: v.preuve.resultat, geste: v.preuve.geste, t: derAtt?.t ?? null },
        derniere: der ? { resultat: der.resultat, le: der.le, verification: der.verification } : null,
        raison: v.raison,
        _tri: [statut === STATUT_ATTENTE ? 0 : 1, statut === STATUT_ATTENTE ? ech : -(Date.parse(derAtt?.t ?? "") || p.mtime), p.titre],
      });
    }
    res.sort((a, b) => a._tri[0] - b._tri[0] || a._tri[1] - b._tri[1] || a._tri[2].localeCompare(b._tri[2], "fr"));
    return res.map(({ _tri, ...r }) => { void _tri; return r; });
  }

  async lire(chemin: string[]): Promise<VueDecision> {
    const { contenu } = await lireConfine(this.#cfg, await resoudre(this.#cfg, chemin));
    const p = this.#espace.pages.get(chemin.join("/"));
    return this.analyser(chemin.join("/"), contenu, undefined, p?.titre);
  }

  #lireGeste(corps: Record<string, unknown>): { segs: string[]; resultat: ResultatDecision; empreinte: string; demande: string; commentaire: string } {
    const segs = cheminPage(this.#cfg, corps.chemin);
    const resultat = corps.resultat as ResultatDecision;
    if (!RESULTATS.includes(resultat)) throw new ErreurHttp(400, "Résultat invalide (approuvée, à corriger ou refusée).", "resultat_invalide");
    const empreinte = chaine(corps.empreinte, "empreinte", 80);
    if (!RE_EMPREINTE.test(empreinte)) throw new ErreurHttp(400, "Empreinte invalide.", "empreinte_invalide");
    const demande = chaine(corps.demande, "demande", 128);
    const commentaire = normaliserCommentaire(corps.commentaire === undefined || corps.commentaire === null ? "" : chaine(corps.commentaire, "commentaire", 10_000));
    return { segs, resultat, empreinte, demande, commentaire };
  }

  /**
   * Défi WebAuthn d'une décision (seulement si une clé d'accès est enregistrée). L'identifiant de la décision est fixé
   * ici : la portée signée par l'appareil lie la proposition (empreinte), le résultat, cette décision et le commentaire.
   */
  async defi(corps: Record<string, unknown>, origine: string, principal: string): Promise<Record<string, unknown>> {
    const g = this.#lireGeste(corps);
    // K10-04 : pas de défi (ni de signature par la clé d'accès) pour approuver une proposition non renseignée
    if (g.resultat === "approuvée") {
      const actuel = await this.#lireBrut(g.segs);
      if (actuel !== null) refuserSiVide(analyserContenu(actuel).d.vides);
    }
    const decision = nouvelIdentifiant("dcs", this.#cfg.fuseau);
    const portee = porteeDe(decision, empreinteCommentaire(g.commentaire));
    const o = await this.#cles.defiDecision({ chemin: g.segs.join("/"), demande: g.demande, empreinte: g.empreinte, resultat: g.resultat, portee, decision }, origine, principal);
    return { ...o, decisionId: decision };
  }

  /**
   * Geste humain. (1) Rejeu d'une même requête : même réponse, rien de refait. (2) Clé d'accès vérifiée si une clé
   * existe (sinon « identite-seule », geste non prouvé). (3) Écriture par la porte unique, SOUS VERROU : relecture,
   * recalcul de l'empreinte, comparaison avec celle présentée (sinon 409 et rien d'écrit), statut + section
   * « ## Décision », puis attestation signée (intention durable : reprise après panne par le socle).
   */
  async geste(corps: Record<string, unknown>, o: { principal: string; nom: string; origine: string; requete: string | undefined }): Promise<Record<string, unknown>> {
    const r = this.#file.then(() => this.#geste(corps, o));
    this.#file = r.then(() => undefined, () => undefined);
    return r;
  }

  async #geste(corps: Record<string, unknown>, o: { principal: string; nom: string; origine: string; requete: string | undefined }): Promise<Record<string, unknown>> {
    const { segs, resultat, empreinte, demande, commentaire } = this.#lireGeste(corps);
    const requete = o.requete;
    if (!requete || !/^[A-Za-z0-9_-]{8,100}$/.test(requete)) throw new ErreurHttp(400, "En-tête X-Carnet-Requete obligatoire (identifiant unique du geste).", "requete_absente");
    const chemin = segs.join("/");
    const operation = { chemin, demande, empreinte, resultat, commentaire };
    const reponse = (r: { etag: string; rejoue: boolean; attestation?: Attestation }, decision: string | null) => ({
      chemin, resultat, empreinte, etag: r.etag, decision: decision ?? decisionDePortee(r.attestation?.portee), attestation: r.attestation?.id ?? null,
      geste: r.attestation?.geste ?? null, le: r.attestation?.t ?? null, rejoue: r.rejoue,
    });
    const rejeu = await this.#espace.verrou.executer(() => this.#ecrivain.rejeuSousVerrou({ chemin: segs, action: "decision", requete, operation }, o.principal));
    if (rejeu) return reponse(rejeu, null);

    let geste: Geste = "identite-seule";
    let decision = nouvelIdentifiant("dcs", this.#cfg.fuseau);
    if ((await this.#cles.lister()).length) {
      const v = await this.#cles.verifierDecision(corps.assertion, {
        chemin, demande, empreinte, resultat, decision: typeof corps.decision === "string" ? corps.decision : "", portee: "",
      }, o.origine, o.principal, requete, (d) => porteeDe(d, empreinteCommentaire(commentaire)));
      geste = "cle-d-acces";
      decision = v.decision;
    }
    const base = porteeDe(decision, empreinteCommentaire(commentaire));
    const avantJournal = (await this.journal()).valides;
    const portee = porteeChainee(base, avantJournal.length ? maillonDe(avantJournal[avantJournal.length - 1]) : "aucune");
    const le = horodatageIso(new Date(), this.#cfg.fuseau);
    const par = o.nom && o.nom !== o.principal ? `${o.principal} (${o.nom.replace(/[()\n\r]/g, " ").trim()})` : o.principal;
    const chaineAvant = await this.chaine(demande);
    const transformer = (avant: string | null): string => {
      if (avant === null) throw new ErreurHttp(404, "La demande n'existe plus.", "introuvable");
      const { d, empreinte: actuelle } = analyserContenu(avant);
      if (!d.estDecision) throw new ErreurHttp(409, "Cette page n'est plus une demande de décision.", "pas_une_decision");
      if (d.id !== demande) throw new ErreurHttp(409, "L'identifiant de la demande a changé : relis-la avant de décider.", "demande_changee", { demande: d.id });
      if (d.bloquants.length || actuelle === null) throw new ErreurHttp(409, d.bloquants[0] ?? "Proposition invalide.", "demande_invalide", { bloquants: d.bloquants });
      if (actuelle !== empreinte) {
        throw new ErreurHttp(409, "La proposition a changé depuis son affichage : rien n'a été enregistré.", "proposition_changee", {
          empreinte: actuelle, proposition: d.proposition, engage: d.engage,
        });
      }
      if (chaineAvant.some((a) => a.empreinte === actuelle)) {
        throw new ErreurHttp(409, "Cette proposition a déjà reçu une décision. Une nouvelle proposition impose une nouvelle décision.", "deja_decidee");
      }
      // K10-04 : approuver exige l'objet et l'action ; « à corriger » et « refusée » restent possibles (rien d'écrit sinon)
      if (resultat === "approuvée") refuserSiVide(d.vides);
      const enreg = formaterEnregistrement({ demande, decision, resultat, par, le, geste, empreinte, commentaire, copie: d.proposition!, engage: d.engage });
      return ajouterEnregistrement(poserPropriete(avant, "statut", STATUT_DE[resultat]), enreg);
    };
    const ecrire = async () => {
      const actuel = await this.#lireBrut(segs);
      if (actuel === null) throw new ErreurHttp(404, "La demande n'existe plus.", "introuvable");
      return this.#ecrivain.ecrire({
        chemin: segs, revision: etagDe(actuel), action: "decision", transformer, requete, operation,
        attester: { demande, empreinte, resultat, portee, geste },
      }, o.principal);
    };
    let r: Awaited<ReturnType<Ecrivain["ecrire"]>>;
    try {
      r = await ecrire();
    } catch (e) {
      // Écriture extérieure entre la relecture et le verrou : on relit une fois (l'empreinte reste le seul juge).
      if (e instanceof ErreurHttp && e.statut === 412 && e.raison === "etag_discordant") r = await ecrire();
      else throw e;
    }
    return reponse(r, decision);
  }

  async #lireBrut(segs: string[]): Promise<string | null> {
    try {
      return (await lireConfine(this.#cfg, await resoudre(this.#cfg, segs))).contenu;
    } catch (e) {
      if (e instanceof ErreurHttp && e.statut === 404) return null;
      throw e;
    }
  }

  /** Nouvelle demande depuis le modèle : sous la page `parent` (comme une sous-page), sinon dans « Décisions/ ». */
  async creer(corps: Record<string, unknown>, principal: string, requete: string | undefined): Promise<{ chemin: string; etag: string; id: string }> {
    const titre = chaine(corps.titre, "titre", 300).replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!titre) throw new ErreurHttp(400, "Titre vide.", "titre_vide");
    let dossier: string[] = ["Décisions"];
    if (corps.parent !== undefined && corps.parent !== null && corps.parent !== "") {
      const p = cheminPage(this.#cfg, corps.parent);
      dossier = [...p.slice(0, -1), p[p.length - 1].slice(0, -3)];
      const pMd = await lstatOuNull(await resoudre(this.#cfg, p));
      const pDir = await lstatOuNull(await resoudre(this.#cfg, dossier));
      if (!pMd && !pDir) throw new ErreurHttp(404, "Page parente introuvable.", "parent_introuvable");
    }
    exigerZoneAutorisee(this.#cfg, dossier);
    // identifiant de demande unique dans l'espace (nouvelIdentifiant ne le garantit pas à lui seul)
    let id = nouvelIdentifiant("dec", this.#cfg.fuseau);
    const pris = new Set(this.#espace.pagesVisibles().map((p) => (p.fm && typeof p.fm.id === "string" ? p.fm.id : "")));
    for (let k = 0; pris.has(id) && k < 20; k++) id = nouvelIdentifiant("dec", this.#cfg.fuseau);
    const contenu = modeleDemande({ id, titre, demandeePar: principal, cree: horodatageIso(new Date(), this.#cfg.fuseau) });
    const r = await this.#ecrivain.creerUnique({
      dossier, base: titre, action: "decision-demande", transformer: () => contenu, requete, operation: { titre, dossier: dossier.join("/") },
    }, principal);
    const lu = await this.#lireBrut(r.chemin.split("/"));
    const idEcrit = lu ? analyserContenu(lu).d.id : null;
    return { chemin: r.chemin, etag: r.etag, id: idEcrit ?? id };
  }
}

function decisionDePortee(portee: string | undefined): string | null {
  const m = /\bdecision=(\S+)/.exec(portee ?? "");
  return m ? m[1] : null;
}

