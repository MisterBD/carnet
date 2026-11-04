// Carnet · routes de l'API JSON (/api/*).
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { nomSuitLeTitre, titreDe } from "../../shared/navigation.ts";
import { dateDuJour } from "../../shared/identifiants.ts";
import { decouper, dossierDe, feuille, nomDeFichier, plier, poserChamp, remplacerTexteH1 } from "../../shared/page.ts";
import { lireProprietes, poserPropriete } from "../../shared/proprietes.ts";
import type { TypePropriete, ValeurPropriete } from "../../shared/proprietes.ts";
import { analyserTache, modifierTache } from "../../shared/taches.ts";
import type { ChangementsTache, Priorite } from "../../shared/taches.ts";
import { Agents } from "./agents.ts";
import { listerArtefacts } from "./art.ts";
import {
  assurerCorbeille, cheminElement, compterPages, decrireElement, effacerElement, FICHIER_META, lireTexteDans, listerCorbeille,
  nouvelId, racineCorbeille, verifierSansLien,
} from "./corbeille.ts";
import type { MetaCorbeille } from "./corbeille.ts";
import type { Config, Correspondance } from "./config.ts";
import {
  creerDossiers, ecrireAtomique, etagDe, fsyncDossier, horodatage, lireConfine, lstatOuNull, ouvrirConfine, resoudre, verifierEcriture,
} from "./disque.ts";
import type { Verrou } from "./disque.ts";
import { collateur, contenuVerrouille, lireFrontmatter, texte } from "./espace.ts";
import type { Changements, Espace, Page } from "./espace.ts";
import { Ecrivain, REVISION_EXISTANTE } from "./ecriture.ts";
import type { DemandeEcriture } from "./ecriture.ts";
import { sha256 } from "./journal-ecritures.ts";
import { chaine, envoyerJson, ErreurHttp, journal, lireCorps, lireJson, normEtag } from "./http.ts";
import { Instantanes, RE_HASH, RE_INSTANTANE } from "./historique.ts";
import type { Git } from "./historique.ts";
import { retroliens, texteApercu } from "./liens.ts";
import { routesMissions } from "./missions.ts"; // lot 10
import { deplacement, marquerCode, reecrireLiens } from "./markdown.ts";
import {
  cheminAutorise, cheminPage, CSP_FICHIER, EXT_IMAGES, EXT_TELECHARGEMENT, exigerZoneAutorisee, extension, MIME_IMAGE, reelAutorise, typeImage,
  zoneInterdite,
} from "./securite.ts";
import type { Diffuseur } from "./sse.ts";
import { routesAujourdhui } from "./routes-aujourdhui.ts";
import { routesPages } from "./pages.ts";
// V3 lot 2 « Bases »
import { Bases, erreurBase, lireChangement, lireSource, lireVue, typeSocle } from "./bases.ts";
import { CLES_PROVENANCE, lireDeclaration, validerSaisie } from "../../shared/bases.ts";
import type { DeclarationPropriete, ErreurBase, ValeurSaisie } from "../../shared/bases.ts";
import { changerVues, estChangementDeVues, etatVue, lireDefinition, poserAujourdhui, reecrireVue } from "./bases-yaml.ts";
import { estTechnique } from "../../shared/techniques.ts";
// V3 lot 5 « Fiabilité »
import { barriereRestauration, Fiabilite } from "./fiabilite.ts";
import { Preparations } from "./preparation.ts"; // lot 11 « Dossier de rendez-vous »

const MAX_PAGE = 2 * 1024 * 1024;
const MAX_LECTURE = 5 * 1024 * 1024;
const MAX_IMAGE = 10 * 1024 * 1024;
const MAX_COPIE_ENTREES = 2000;
const MAX_COPIE_OCTETS = 200 * 1024 * 1024;
const JOUR_MS = 24 * 3600 * 1000;

export interface Ctx {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  corr: Correspondance;
  login: string;
  nom: string;
  route: string;
  raison?: string;
}

type Gestionnaire = (ctx: Ctx) => Promise<void>;

function json(ctx: Ctx, statut: number, objet: unknown, entetes: Record<string, string> = {}): void {
  envoyerJson(ctx.req, ctx.res, statut, objet, entetes);
}

/** Identifiant d'idempotence envoyé par le client (en-tête X-Carnet-Requete, UUID par geste), validé par Ecrivain. */
function requeteDe(ctx: Ctx): string | undefined {
  const v = ctx.req.headers["x-carnet-requete"];
  return typeof v === "string" ? v.trim() : undefined;
}

/** Révision de la source (If-Match, facultatif) et idempotence d'un renommage / déplacement / suppression. */
function mouvementDe(ctx: Ctx): { revision?: string; requete?: string } {
  const ifMatch = ctx.req.headers["if-match"];
  const requete = requeteDe(ctx);
  return {
    ...(ifMatch !== undefined && ifMatch.trim() !== "*" ? { revision: normEtag(ifMatch.split(",")[0]) } : {}),
    ...(requete !== undefined ? { requete } : {}),
  };
}

/** Segments du dossier « X/ » associé à la page « X.md ». */
function dossierDePage(segs: string[]): string[] {
  return [...segs.slice(0, -1), segs[segs.length - 1].slice(0, -3)];
}

const RE_CLE_META = /^[A-Za-z_][\w-]{0,63}$/;
/** Lot 6 : drapeaux de page portés par l'en-tête (`verrou: true`, `archive: true`). */
const CLES_PAGES = new Set(["verrou", "archive"]);

export class Api {
  cfg: Config;
  espace: Espace;
  diffuseur: Diffuseur;
  verrou: Verrou;
  git: Git;
  instantanes: Instantanes;
  /** Porte d'écriture unique des pages (server/src/ecriture.ts). */
  ecrivain: Ecrivain;
  /** Dossier de rendez-vous (lot 11, server/src/preparation.ts). */
  preparations: Preparations;
  routes: Map<string, Gestionnaire>;
  bases: Bases;
  /** Lot 3 : décisions, nouveautés, fichiers des agents, clés d'accès. */
  agents: Agents;
  #minuteurPurge: ReturnType<typeof setInterval> | null = null;
  /** Renommages réussis récents : une requête rejouée (Entrée puis perte de focus) reçoit la même réponse. */
  #renommages: { t: number; source: string; nom?: string; titre?: string; cible: string }[] = [];

  constructor(cfg: Config, espace: Espace, diffuseur: Diffuseur, verrou: Verrou, git: Git) {
    this.cfg = cfg;
    this.espace = espace;
    this.diffuseur = diffuseur;
    this.verrou = verrou;
    this.git = git;
    this.ecrivain = new Ecrivain(cfg, espace, verrou, (ch) => this.#publier(ch));
    this.instantanes = this.ecrivain.instantanes;
    this.bases = new Bases(cfg, espace);
    this.preparations = new Preparations(cfg, espace, this.ecrivain);
    this.routes = new Map<string, Gestionnaire>([
      ["GET /api/config", (c) => this.config(c)],
      ["GET /api/arbre", (c) => this.arbre(c)],
      ["GET /api/page", (c) => this.lirePage(c)],
      ["PUT /api/page", (c) => this.ecrirePage(c)],
      ["POST /api/page", (c) => this.creerPage(c)],
      ["POST /api/renommer", (c) => this.renommer(c)],
      ["POST /api/deplacer", (c) => this.deplacer(c)],
      ["POST /api/supprimer", (c) => this.supprimer(c)],
      ["GET /api/recherche", (c) => this.recherche(c)],
      ["POST /api/images", (c) => this.images(c)],
      ["GET /api/fichier", (c) => this.fichier(c)],
      ["GET /api/evenements", (c) => this.evenements(c)],
      ["GET /api/accueil", (c) => this.accueil(c)],
      ["POST /api/tache", (c) => this.tache(c)],
      ["GET /api/projets", (c) => this.projets(c)],
      ...routesMissions(this), // lot 10 « Missions vivantes » (lecture seule)
      ["POST /api/meta", (c) => this.meta(c)],
      ["GET /api/favoris", (c) => this.lireFavoris(c)],
      ["PUT /api/favoris", (c) => this.ecrireFavoris(c)],
      ["GET /api/artefacts", (c) => this.artefacts(c)],
      ["GET /api/corbeille", (c) => this.corbeille(c)],
      ["POST /api/corbeille/restaurer", (c) => this.restaurerCorbeille(c)],
      ["POST /api/corbeille/effacer", (c) => this.effacerCorbeille(c)],
      ["GET /api/corbeille/apercu", (c) => this.apercuCorbeille(c)],
      ["POST /api/placer", (c) => this.placer(c)],
      ["POST /api/dupliquer", (c) => this.dupliquer(c)],
      ["GET /api/historique", (c) => this.historique(c)],
      ["GET /api/version", (c) => this.version(c)],
      ["POST /api/instantane", (c) => this.instantane(c)],
      ["POST /api/restaurer-version", (c) => this.restaurerVersion(c)],
      ["GET /api/retroliens", (c) => this.retroliens(c)],
      ["GET /api/apercu", (c) => this.apercu(c)],
      ["GET /api/couvertures", (c) => this.couvertures(c)],
      ["GET /api/attestations", (c) => this.listerAttestations(c)],
      ...routesAujourdhui(this), // lot 1 « Aujourd'hui »
      ...routesPages(this), // lot 6 « Pages » : modèles, journal du jour
      // V3 lot 2 « Bases »
      ["GET /api/base", (c) => this.lireBase(c)],
      ["POST /api/base/evaluer", (c) => this.evaluerBase(c)],
      ["POST /api/base/reecrire", (c) => this.reecrireBase(c)],
      ["POST /api/base/dossier", (c) => this.dossierBase(c)],
      ["GET /api/bases/destinations", (c) => this.destinationsBases(c)], // K10-01
      ["GET /api/proprietes", (c) => this.lireProprietes(c)],
      ["POST /api/propriete", (c) => this.ecrirePropriete(c)],
      ["POST /api/base/entree", (c) => this.entreeBase(c)],
      // lot 11 « Dossier de rendez-vous »
      ["GET /api/preparation", (c) => this.preparations.apercu(c)],
      ["GET /api/preparation/etat", (c) => this.preparations.etat(c)],
      ["POST /api/preparation/conserver", (c) => this.preparations.conserver(c)],
    ]);
    this.agents = new Agents(cfg, espace, this.ecrivain);
    // Intégration lots 3 et 11 : un fichier des agents est « non accessible » pour le dossier de rendez-vous.
    this.preparations.technique = (c) => estTechnique(cfg.techniques, c);
    for (const [cle, g] of this.agents.routes()) this.routes.set(cle, g);
    // Lot 5 : copie de conflit, retour à la version marquée vue, écritures indéterminées
    for (const [cle, g] of new Fiabilite(cfg, espace, this.ecrivain, this.agents.nouveautes).routes()) this.routes.set(cle, g);
  }

  async gerer(ctx: Ctx): Promise<void> {
    const methode = ctx.req.method === "HEAD" ? "GET" : (ctx.req.method ?? "");
    const g = this.routes.get(`${methode} ${ctx.url.pathname}`);
    if (!g) {
      const existe = [...this.routes.keys()].some((k) => k.endsWith(" " + ctx.url.pathname));
      if (existe) throw new ErreurHttp(405, "Méthode non autorisée.", "methode");
      throw new ErreurHttp(404, "Route inconnue.", "route_inconnue");
    }
    await g(ctx);
  }

  #publier(ch: Changements): void {
    this.espace.appliquer(ch);
  }

  // -------------------------------------------------------------------------------------------

  async config(ctx: Ctx): Promise<void> {
    json(ctx, 200, {
      utilisateur: { login: ctx.login, nom: ctx.nom, prenom: this.cfg.prenom || null }, artBase: ctx.corr.art, espace: this.cfg.nomEspace, dev: this.cfg.dev,
      historique: { git: this.git.actif }, corbeille: { jours: this.cfg.corbeilleJours },
      // Mentions qui placent une page dans « À relire » ; réseau et contact cités par les écrans hors ligne et d'erreur.
      mentions: this.cfg.mentions, reseau: this.cfg.reseau || null, contact: this.cfg.contact || null,
      inbox: this.cfg.inbox.join("/"), fuseau: this.cfg.fuseau, // lot 1
    });
  }

  /** Dernière vérification de `.carnet/ordre.json` à la demande de l'arbre (au plus toutes les 2 s). */
  #ordreVerifie = 0;

  async arbre(ctx: Ctx): Promise<void> {
    // `.carnet/` n'est pas surveillé (dossier caché) : un ordre changé hors de Carnet (git, agent) est relu ici,
    // sans attendre le rebalayage de sécurité (60 s).
    if (Date.now() - this.#ordreVerifie > 2000) {
      this.#ordreVerifie = Date.now();
      await this.verrou.executer(async () => {
        if (await this.espace.ordres.rafraichir()) this.#publier({ modifs: new Map(), arbre: true });
      }).catch((e) => journal({ niveau: "avertissement", quoi: "ordre", erreur: String((e as Error).message) }));
    }
    json(ctx, 200, this.espace.arbreJson());
  }

  async lirePage(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    try {
      const { contenu, st } = await lireConfine(this.cfg, await resoudre(this.cfg, segs), MAX_LECTURE);
      const etag = etagDe(contenu);
      // page `type: decision` : preuve calculée par le serveur, hors du Markdown
      // (lot 3 : même preuve que le socle, plus la date et le contrôle du chaînage du journal des attestations)
      const preuve = await this.agents.preuvePage(segs.join("/"), contenu);
      // page `type: preparation` (lot 11) : « à rafraîchir » calculé (révisions des sources), hors du Markdown
      const preparation = await this.preparations.etatDePage(segs.join("/"));
      json(ctx, 200, {
        chemin: segs.join("/"), contenu, etag, mtime: Math.floor(st.mtimeMs), ...(preuve ? { preuveDecision: preuve } : {}), ...(preparation ? { preparation } : {}),
      }, { ETag: etag });
    } catch (e) {
      if (e instanceof ErreurHttp && e.statut === 404) {
        const d = await lstatOuNull(await resoudre(this.cfg, dossierDePage(segs)));
        if (d && d.isDirectory()) throw new ErreurHttp(404, "Cette page n'existe pas encore (dossier sans page).", "page_dossier", { dossier: true });
        throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      }
      throw e;
    }
  }

  /** Contenu actuel d'une page pour un 412 (null si absente ou illisible). */
  async #actuel(abs: string): Promise<{ contenu: string; etag: string } | null> {
    try {
      const { contenu } = await lireConfine(this.cfg, abs, MAX_LECTURE);
      return { contenu, etag: etagDe(contenu) };
    } catch {
      return null;
    }
  }

  async ecrirePage(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const corps = await lireJson(ctx.req, MAX_PAGE + 64 * 1024);
    const contenu = chaine(corps.contenu, "contenu", Infinity);
    if (Buffer.byteLength(contenu) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
    if (corps.ecraser !== undefined && typeof corps.ecraser !== "boolean") throw new ErreurHttp(400, "Champ « ecraser » invalide.", "champ_invalide");
    const ecraser = corps.ecraser === true;
    const ifMatch = ctx.req.headers["if-match"];
    const ifNone = ctx.req.headers["if-none-match"];
    const demande: Omit<DemandeEcriture, "revision"> = {
      chemin: segs, action: "page", transformer: () => contenu, requete: requeteDe(ctx), operation: { contenu: sha256(contenu), ecraser }, ecraser,
    };
    await this.verrou.executer(async () => {
      let revision: string | null;
      if (ifNone !== undefined && ifNone.trim() === "*") revision = null;
      else if (ifMatch !== undefined && ifMatch.trim() !== "*") {
        // « If-Match: * » (écrasement aveugle) n'est plus accepté : révision exacte, ou `ecraser` avec l'etag du 412
        const liste = ifMatch.split(",").map(normEtag);
        revision = liste[0];
        if (liste.length > 1) {
          const a = await this.#actuel(await resoudre(this.cfg, segs));
          if (a && liste.includes(a.etag)) revision = a.etag;
        }
      } else {
        const rejeu = await this.ecrivain.rejeuSousVerrou(demande, ctx.login);
        if (rejeu) {
          json(ctx, 200, { etag: rejeu.etag, mtime: rejeu.mtime, rejoue: true }, { ETag: rejeu.etag });
          return;
        }
        const { abs, st } = await verifierEcriture(this.cfg, segs);
        if (st) {
          if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas un fichier.", "pas_un_fichier");
          const a = await this.#actuel(abs);
          if (!a) throw new ErreurHttp(409, "Page illisible.", "illisible");
          throw new ErreurHttp(412, "En-tête If-Match obligatoire pour modifier une page existante.", "if_match_absent", { etag: a.etag, contenu: a.contenu });
        }
        throw new ErreurHttp(428, "En-tête If-None-Match: * obligatoire pour créer une page.", "if_none_match_absent");
      }
      const r = await this.ecrivain.ecrireSousVerrou({ ...demande, revision }, ctx.login);
      json(ctx, 200, { etag: r.etag, mtime: r.mtime, ...(r.rejoue ? { rejoue: true } : {}) }, { ETag: r.etag });
    });
  }

  async creerPage(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, MAX_PAGE + 64 * 1024);
    const parent = corps.parent === undefined || corps.parent === null ? "" : chaine(corps.parent, "parent", 1024);
    const titreBrut = chaine(corps.titre, "titre", 500).replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!titreBrut) throw new ErreurHttp(400, "Titre vide.", "titre_vide");
    const contenuFourni = corps.contenu === undefined || corps.contenu === null ? null : chaine(corps.contenu, "contenu", Infinity);
    let dossier: string[] = [];
    if (parent !== "") {
      const p = cheminPage(this.cfg, parent);
      dossier = dossierDePage(p);
    }
    const contenu = contenuFourni ?? `# ${titreBrut}\n\n`;
    if (Buffer.byteLength(contenu) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
    const base = nomDeFichier(titreBrut);
    await this.verrou.executer(async () => {
      if (parent !== "") {
        const pMd = await lstatOuNull(await resoudre(this.cfg, [...dossier.slice(0, -1), dossier[dossier.length - 1] + ".md"]));
        const pDir = await lstatOuNull(await resoudre(this.cfg, dossier));
        if (!pMd && !pDir) throw new ErreurHttp(404, "Page parente introuvable.", "parent_introuvable");
      }
      const r = await this.ecrivain.creerUniqueSousVerrou({
        dossier, base, nommer: (b, k) => `${b} ${k}`, action: "creation", transformer: () => contenu,
        requete: requeteDe(ctx), operation: { parent, titre: titreBrut, contenu: sha256(contenu) },
      }, ctx.login);
      json(ctx, 201, { chemin: r.chemin, etag: r.etag, ...(r.rejoue ? { rejoue: true } : {}) }, { ETag: r.etag });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Renommer / déplacer / supprimer
  // -------------------------------------------------------------------------------------------

  async renommer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const source = cheminPage(this.cfg, corps.chemin);
    if (corps.titre !== undefined) {
      json(ctx, 200, await this.#renommerTitre(source, chaine(corps.titre, "titre", 500), ctx.login));
      return;
    }
    const nom = nomDeFichier(chaine(corps.nom, "nom", 500));
    const r = await this.verrou.executer(async () => {
      const rejeu = await this.#rejeu(source, { nom });
      if (rejeu) return rejeu;
      const x = await this.#deplacer(source, source.slice(0, -1), nom, ctx.login, "renommer", mouvementDe(ctx));
      if (x.chemin !== source.join("/")) this.#noterRenommage(source.join("/"), x.chemin, { nom });
      return x;
    });
    json(ctx, 200, r);
  }

  #noterRenommage(source: string, cible: string, demande: { nom?: string; titre?: string }): void {
    const t = Date.now();
    this.#renommages = this.#renommages.filter((r) => t - r.t < 15_000 && r.source !== source);
    this.#renommages.push({ t, source, cible, ...demande });
  }

  /**
   * Requête de renommage rejouée : la source n'existe plus et un renommage réussi il y a moins de 15 s portait la
   * même demande (même nom visé, ou même titre) : on renvoie le même résultat sans rien toucher.
   */
  async #rejeu(source: string[], demande: { nom?: string; titre?: string }): Promise<{ chemin: string; liensMisAJour: number; renomme: true; rejoue: true; etag?: string | null } | null> {
    const chemin = source.join("/");
    const t = Date.now();
    const r = this.#renommages.find((x) => x.source === chemin && t - x.t < 15_000
      && (demande.nom !== undefined ? x.nom === demande.nom : x.titre === demande.titre));
    if (!r) return null;
    const md = await lstatOuNull(await resoudre(this.cfg, source));
    const dir = await lstatOuNull(await resoudre(this.cfg, dossierDePage(source)));
    if (md || dir) return null; // la source existe de nouveau : vraie demande
    const res: { chemin: string; liensMisAJour: number; renomme: true; rejoue: true; etag?: string | null } = {
      chemin: r.cible, liensMisAJour: 0, renomme: true, rejoue: true,
    };
    if (demande.titre !== undefined) {
      const a = await this.#actuel(await resoudre(this.cfg, r.cible.split("/")));
      res.etag = a?.etag ?? null;
    }
    return res;
  }

  /**
   * Renommer = changer le TITRE (une seule notion pour l'utilisateur) : `title:` s'il existe, sinon la ligne `# …` si elle
   * existe ; le fichier est renommé aussi quand son nom suivait le titre (shared/navigation.ts : nomSuitLeTitre).
   */
  async #renommerTitre(source: string[], brut: string, principal: string): Promise<{ chemin: string; liensMisAJour: number; etag: string | null; renomme: boolean }> {
    const titre = brut.replace(/\s*[\r\n]+\s*/g, " ").trim();
    if (!titre) throw new ErreurHttp(400, "Titre vide.", "titre_vide");
    return this.verrou.executer(async () => {
      const chemin = source.join("/");
      const rejeu = await this.#rejeu(source, { titre });
      if (rejeu) return rejeu as { chemin: string; liensMisAJour: number; etag: string | null; renomme: boolean };
      const md = await verifierEcriture(this.cfg, source);
      const dir = await verifierEcriture(this.cfg, dossierDePage(source));
      if (md.st && !md.st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
      if (!md.st && !(dir.st && dir.st.isDirectory())) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      let contenu = "";
      let etag: string | null = null;
      if (md.st) {
        contenu = (await lireConfine(this.cfg, md.abs, MAX_LECTURE)).contenu;
        etag = etagDe(contenu);
        // lot 6 : le titre d'une page verrouillée ne change pas (même quand seul le nom du fichier le porte)
        if (contenuVerrouille(contenu)) {
          throw new ErreurHttp(423, "Page verrouillée contre les fausses manipulations : déverrouille-la d'abord (les agents peuvent toujours écrire le fichier).", "page_verrouillee", { raison: "page_verrouillee", etag });
        }
      }
      const { titre: ancien, source: origine } = titreDe(chemin, contenu);
      const suit = nomSuitLeTitre(chemin, contenu);
      if (titre === ancien) return { chemin, liensMisAJour: 0, etag, renomme: false };
      if (md.st && origine !== "nom") {
        const d = decouper(contenu);
        const nouveau = origine === "fm"
          ? poserChamp(d.frontmatter, "title", titre) + contenu.slice(d.frontmatter.length)
          : d.frontmatter + remplacerTexteH1(d.blocTitre, titre) + d.corps;
        if (nouveau !== contenu) {
          const r = await this.ecrivain.ecrireSousVerrou({ chemin: source, revision: etag, action: "titre", transformer: () => nouveau }, principal);
          contenu = nouveau;
          etag = r.etag;
        }
      }
      if (!suit) return { chemin, liensMisAJour: 0, etag, renomme: false };
      const nom = nomDeFichier(titre);
      if (nom === feuille(chemin)) return { chemin, liensMisAJour: 0, etag, renomme: false };
      const cible = [...source.slice(0, -1), nom + ".md"];
      const cibleDir = [...source.slice(0, -1), nom];
      if (zoneInterdite(this.cfg, cible) || zoneInterdite(this.cfg, cibleDir)) return { chemin, liensMisAJour: 0, etag, renomme: false };
      const dMd = await verifierEcriture(this.cfg, cible);
      const dDir = await verifierEcriture(this.cfg, cibleDir);
      // nom déjà pris : seul le titre change (pas d'erreur, pas de suffixe surprenant)
      if (dMd.st || dDir.st) return { chemin, liensMisAJour: 0, etag, renomme: false };
      const r = await this.#deplacer(source, source.slice(0, -1), nom, principal, "renommer");
      if (r.chemin !== chemin) this.#noterRenommage(chemin, r.chemin, { titre });
      return { chemin: r.chemin, liensMisAJour: r.liensMisAJour, etag, renomme: r.chemin !== chemin };
    });
  }

  async deplacer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const source = cheminPage(this.cfg, corps.chemin);
    const parent = corps.parent === undefined || corps.parent === null ? "" : chaine(corps.parent, "parent", 1024);
    let dest: string[] = [];
    if (parent !== "") {
      const p = cheminPage(this.cfg, parent);
      dest = dossierDePage(p);
      const ancienNom = source.join("/").slice(0, -3);
      const nomParent = dest.join("/");
      if (nomParent === ancienNom || nomParent.startsWith(ancienNom + "/")) {
        throw new ErreurHttp(400, "Impossible de déplacer une page dans elle-même ou dans une de ses sous-pages.", "deplacement_circulaire");
      }
    }
    const r = await this.verrou.executer(async () => {
      if (parent !== "") {
        const pMd = await lstatOuNull(await resoudre(this.cfg, [...dest.slice(0, -1), dest[dest.length - 1] + ".md"]));
        const pDir = await lstatOuNull(await resoudre(this.cfg, dest));
        if (!pMd && !pDir) throw new ErreurHttp(404, "Page parente introuvable.", "parent_introuvable");
      }
      return this.#deplacer(source, dest, feuille(source.join("/")), ctx.login, "deplacer", mouvementDe(ctx));
    });
    json(ctx, 200, r);
  }

  /**
   * Déplace / renomme X.md et X/ vers <destDossier>/<nom>.md et <destDossier>/<nom>/, puis met à jour les liens.
   * Par la porte d'écriture : révision de la source (facultative), intention, journal, destination exclusive.
   */
  async #deplacer(
    source: string[], destDossier: string[], nom: string, principal: string, action: "renommer" | "deplacer",
    m: { revision?: string; requete?: string } = {},
  ): Promise<{ chemin: string; liensMisAJour: number }> {
    const ancienNom = source.join("/").slice(0, -3);
    const cible = [...destDossier, nom + ".md"];
    const cibleDir = [...destDossier, nom];
    exigerZoneAutorisee(this.cfg, cible);
    exigerZoneAutorisee(this.cfg, cibleDir);
    const nouveauNom = cibleDir.join("/");
    if (nouveauNom === ancienNom) return { chemin: source.join("/"), liensMisAJour: 0 };
    return this.ecrivain.mouvementSousVerrou(
      { action, chemin: source, vers: cible.join("/"), ...m, operation: { vers: cible.join("/") } }, principal,
      async () => ({ resultat: await this.#deplacerFait(source, destDossier, nom, principal), vers: cible.join("/") }),
    );
  }

  async #deplacerFait(source: string[], destDossier: string[], nom: string, principal: string): Promise<{ chemin: string; liensMisAJour: number }> {
    const ancienNom = source.join("/").slice(0, -3);
    const cible = [...destDossier, nom + ".md"];
    const cibleDir = [...destDossier, nom];
    const nouveauNom = cibleDir.join("/");
    const srcMd = await verifierEcriture(this.cfg, source);
    const srcDir = await verifierEcriture(this.cfg, dossierDePage(source));
    const aMd = !!srcMd.st;
    const aDir = !!(srcDir.st && srcDir.st.isDirectory());
    if (!aMd && !aDir) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
    if (srcMd.st && !srcMd.st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
    const dstMd = await verifierEcriture(this.cfg, cible);
    const dstDir = await verifierEcriture(this.cfg, cibleDir);
    if (dstMd.st || dstDir.st) throw new ErreurHttp(409, "Une page porte déjà ce nom à cet endroit.", "conflit_nom");
    await creerDossiers(this.cfg, path.dirname(dstMd.abs));
    const faits: [string, string][] = [];
    try {
      if (aMd) {
        await fsp.link(srcMd.abs, dstMd.abs); // jamais d'écrasement
        await fsp.unlink(srcMd.abs);
        faits.push([srcMd.abs, dstMd.abs]);
      }
      if (aDir) {
        await fsp.rename(srcDir.abs, dstDir.abs);
        faits.push([srcDir.abs, dstDir.abs]);
      }
    } catch (e) {
      for (const [a, b] of faits.reverse()) await fsp.rename(b, a).catch(() => {});
      if ((e as NodeJS.ErrnoException).code === "EEXIST" || (e as NodeJS.ErrnoException).code === "ENOTEMPTY") {
        throw new ErreurHttp(409, "Une page porte déjà ce nom à cet endroit.", "conflit_nom");
      }
      throw e;
    }
    await fsyncDossier(path.dirname(srcMd.abs));
    await fsyncDossier(path.dirname(dstMd.abs));

    // Liens : wikiliens vers l'ancien nom, liens Markdown relatifs des pages déplacées et vers elles.
    const dep = deplacement(ancienNom, nouveauNom);
    let n = 0;
    const touchees: string[] = [];
    for (const p of [...this.espace.pages.values()]) {
      if (p.lien) continue;
      const nouveauChemin = dep.chemin(p.chemin) ?? p.chemin;
      const avant = dossierDe(p.chemin);
      const apres = dossierDe(nouveauChemin);
      if (reecrireLiens(p.contenu, avant, apres, dep).n === 0) continue; // tri rapide sur l'index
      try {
        const segsN = nouveauChemin.split("/");
        const v = await verifierEcriture(this.cfg, segsN);
        if (!v.st || !v.st.isFile()) continue;
        const lu = await lireConfine(this.cfg, v.abs, MAX_LECTURE);
        const r = reecrireLiens(lu.contenu, avant, apres, dep);
        if (r.n === 0 || r.contenu === lu.contenu) continue;
        await this.ecrivain.ecrireSousVerrou({ chemin: segsN, revision: etagDe(lu.contenu), action: "liens", transformer: () => r.contenu }, principal);
        n += r.n;
        touchees.push(nouveauChemin);
      } catch (e) {
        journal({ niveau: "avertissement", quoi: "liens", erreur: String((e as Error).message) });
      }
    }
    // Ordre manuel : le nom change dans son dossier (renommage) ou quitte l'ancien dossier (déplacement) ; les ordres
    // des sous-dossiers suivent. Les instantanés de l'historique suivent aussi.
    const dossierAvant = dossierDe(source.join("/"));
    const dossierApres = destDossier.join("/");
    let ordre = dossierAvant === dossierApres
      ? this.espace.ordres.renommerNom(dossierAvant, feuille(source.join("/")), nom)
      : this.espace.ordres.retirer(dossierAvant, feuille(source.join("/")));
    ordre = this.espace.ordres.renommerPrefixe(ancienNom, nouveauNom) || ordre;
    if (ordre) await this.espace.ordres.enregistrer().catch((e) => journal({ niveau: "avertissement", quoi: "ordre", erreur: String((e as Error).message) }));
    await this.instantanes.deplacer(ancienNom, nouveauNom);
    this.git.oublier();
    const ch = await this.espace.traiter([source.join("/"), ancienNom, cible.join("/"), nouveauNom, ...touchees]);
    if (ordre) ch.arbre = true;
    this.#publier(ch);
    await this.#majFavoris((c) => dep.chemin(c) ?? c);
    return { chemin: cible.join("/"), liensMisAJour: n };
  }

  async supprimer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const chemin = segs.join("/");
    const r = await this.verrou.executer(async () => {
      // rejeu d'abord (la page n'existe plus après une suppression réussie)
      const m = mouvementDe(ctx);
      const rejeu = await this.ecrivain.rejeuSousVerrou({ chemin: segs, action: "supprimer", requete: m.requete }, ctx.login);
      if (rejeu) return rejeu as unknown as { id: string; corbeille: string; chemin: string; titre: string };
      const md = await verifierEcriture(this.cfg, segs);
      const dir = await verifierEcriture(this.cfg, dossierDePage(segs));
      const aMd = !!(md.st && md.st.isFile());
      const aDir = !!(dir.st && dir.st.isDirectory());
      if (!aMd && !aDir) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      return this.ecrivain.mouvementSousVerrou({ action: "supprimer", chemin: segs, vers: null, ...m }, ctx.login, async () => {
        const x = await this.#supprimerFait(ctx, segs, md, dir, aMd, aDir);
        return { resultat: x, vers: x.corbeille };
      });
    });
    json(ctx, 200, r);
  }

  async #supprimerFait(
    ctx: Ctx, segs: string[], md: { abs: string }, dir: { abs: string }, aMd: boolean, aDir: boolean,
  ): Promise<{ id: string; corbeille: string; chemin: string; titre: string }> {
    const chemin = segs.join("/");
    const racine = await assurerCorbeille(this.cfg);
    const page = this.espace.pages.get(chemin);
    const titre = page?.titre ?? feuille(chemin);
    const icone = page?.icone ?? null;
    const sousPages = aDir ? await compterPages(dir.abs) : 0;
    for (let k = 0; k < 20; k++) {
      const id = nouvelId();
      const element = path.join(racine, id);
      try {
        await fsp.mkdir(element, { mode: 0o755 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") continue;
        throw e;
      }
      const destMd = path.join(element, ...segs);
      const destDir = path.join(element, ...dossierDePage(segs));
      const faits: [string, string][] = [];
      try {
        await creerDossiers(this.cfg, path.dirname(destMd));
        if (aMd) { await fsp.rename(md.abs, destMd); faits.push([md.abs, destMd]); }
        if (aDir) { await fsp.rename(dir.abs, destDir); faits.push([dir.abs, destDir]); }
      } catch (e) {
        for (const [a, b] of faits.reverse()) await fsp.rename(b, a).catch(() => {});
        await fsp.rm(element, { recursive: true, force: true }).catch(() => {});
        throw e;
      }
      await fsyncDossier(path.dirname(md.abs));
      const meta: MetaCorbeille = { version: 1, chemin, titre, icone, date: new Date().toISOString(), sousPages, login: ctx.login };
      await ecrireAtomique(path.join(element, FICHIER_META), JSON.stringify(meta, null, 1) + "\n", { exclusif: true })
        .catch((e) => journal({ niveau: "avertissement", quoi: "corbeille_meta", erreur: String((e as Error).message) }));
      const nomPage = chemin.slice(0, -3);
      this.#publier(await this.espace.traiter([chemin, nomPage]));
      await this.#majFavoris((c) => (c === chemin || c === nomPage || c.startsWith(nomPage + "/") ? null : c));
      return { id, corbeille: [".corbeille", id, ...(aMd ? segs : dossierDePage(segs))].join("/"), chemin, titre };
    }
    throw new ErreurHttp(409, "Corbeille encombrée, réessaie.", "corbeille");
  }

  // -------------------------------------------------------------------------------------------
  // Corbeille : liste, restauration, suppression définitive, aperçu, purge
  // -------------------------------------------------------------------------------------------

  #existe(chemin: string): boolean {
    return this.espace.pages.has(chemin) || this.espace.dossiers.has(chemin.replace(/\.md$/, ""));
  }

  async corbeille(ctx: Ctx): Promise<void> {
    const elements = (await listerCorbeille(this.cfg)).map((e) => ({
      id: e.id, chemin: e.chemin, titre: e.titre, icone: e.icone, date: e.date, sousPages: e.sousPages,
      existe: e.chemin ? this.#existe(e.chemin) : false,
    }));
    json(ctx, 200, { elements, jours: this.cfg.corbeilleJours });
  }

  async restaurerCorbeille(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const r = await this.verrou.executer(async () => {
      // Lot 5 : par la porte d'écriture (mouvement « restaurer » : idempotence, intention durable, journal).
      // Source = l'élément de corbeille `.corbeille/<id>` (dossier), destination = le chemin d'origine (ou « (restaurée) »).
      const requete = requeteDe(ctx);
      const idEl = typeof corps.id === "string" ? corps.id : "";
      const mvt = { action: "restaurer" as const, chemin: [".corbeille", idEl], requete, operation: { id: idEl } };
      if (requete !== undefined && idEl) {
        const rejeu = await this.ecrivain.rejeuSousVerrou(mvt, ctx.login);
        if (rejeu) return rejeu as unknown as { chemin: string; renomme: boolean };
      }
      const abs = await cheminElement(this.cfg, corps.id);
      const el = await decrireElement(this.cfg, corps.id as string, abs);
      if (!el.segs) throw el.erreur ?? new ErreurHttp(404, "Contenu de l'élément introuvable.", "element_vide");
      const segs = el.segs;
      await verifierSansLien(abs, segs);
      const srcMd = path.join(abs, ...segs);
      const srcDir = path.join(abs, ...dossierDePage(segs));
      const stMd = await lstatOuNull(srcMd);
      const stDir = await lstatOuNull(srcDir);
      if (stMd && !stMd.isFile()) throw new ErreurHttp(409, "Contenu inattendu dans la corbeille.", "contenu_inattendu");
      if (stDir && (stDir.isSymbolicLink() || !stDir.isDirectory())) throw new ErreurHttp(409, "Contenu inattendu dans la corbeille.", "contenu_inattendu");
      if (!stMd && !stDir) throw new ErreurHttp(404, "Contenu de l'élément introuvable.", "element_vide");
      const dossier = segs.slice(0, -1);
      const base = feuille(segs.join("/"));
      return this.ecrivain.mouvementSousVerrou({ ...mvt, vers: segs.join("/") }, ctx.login, async () => {
      for (let k = 0; k < 100; k++) {
        const nom = k === 0 ? base : k === 1 ? `${base} (restaurée)` : `${base} (restaurée ${k})`;
        const cible = [...dossier, nom + ".md"];
        const cibleDir = [...dossier, nom];
        if (zoneInterdite(this.cfg, cible) || zoneInterdite(this.cfg, cibleDir)) throw new ErreurHttp(403, "Chemin interdit.", "zone_interdite");
        const dMd = await verifierEcriture(this.cfg, cible);
        const dDir = await verifierEcriture(this.cfg, cibleDir);
        if (dMd.st || dDir.st) continue;
        await creerDossiers(this.cfg, path.dirname(dMd.abs));
        const faits: [string, string][] = [];
        try {
          if (stMd) {
            await fsp.link(srcMd, dMd.abs); // jamais d'écrasement
            await fsp.unlink(srcMd);
            faits.push([srcMd, dMd.abs]);
          }
          if (stDir) {
            await fsp.rename(srcDir, dDir.abs);
            faits.push([srcDir, dDir.abs]);
          }
        } catch (e) {
          for (const [a, b] of faits.reverse()) await fsp.rename(b, a).catch(() => {});
          const code = (e as NodeJS.ErrnoException).code;
          if (code === "EEXIST" || code === "ENOTEMPTY") continue;
          throw e;
        }
        await fsyncDossier(path.dirname(dMd.abs));
        await effacerElement(abs).catch((e) => journal({ niveau: "avertissement", quoi: "corbeille", erreur: String((e as Error).message) }));
        this.#publier(await this.espace.traiter([cible.join("/"), cibleDir.join("/")]));
        return { resultat: { chemin: cible.join("/"), renomme: k > 0 }, vers: cible.join("/") };
      }
      throw new ErreurHttp(409, "Impossible de trouver un nom libre pour restaurer.", "conflit_nom");
      });
    });
    json(ctx, 200, r);
  }

  async effacerCorbeille(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const r = await this.verrou.executer(async () => {
      if (corps.tout === true) {
        let n = 0;
        const racine = racineCorbeille(this.cfg);
        for (const e of await listerCorbeille(this.cfg)) {
          await effacerElement(path.join(racine, e.id));
          n++;
        }
        return { effaces: n };
      }
      const abs = await cheminElement(this.cfg, corps.id);
      await effacerElement(abs);
      return { effaces: 1 };
    });
    json(ctx, 200, r);
  }

  async apercuCorbeille(ctx: Ctx): Promise<void> {
    const id = ctx.url.searchParams.get("id");
    const abs = await cheminElement(this.cfg, id);
    const el = await decrireElement(this.cfg, id as string, abs);
    if (!el.segs) throw el.erreur ?? new ErreurHttp(404, "Contenu de l'élément introuvable.", "element_vide");
    await verifierSansLien(abs, el.segs);
    let contenu = "";
    try {
      contenu = await lireTexteDans(abs, path.join(abs, ...el.segs), MAX_PAGE);
    } catch (e) {
      if (!(e instanceof ErreurHttp && e.statut === 404)) throw e;
    }
    json(ctx, 200, { id: el.id, chemin: el.chemin, titre: el.titre, contenu });
  }

  /** Supprime définitivement les éléments plus vieux que CARNET_CORBEILLE_JOURS. Renvoie leur nombre. */
  async purgerCorbeille(maintenant = Date.now()): Promise<number> {
    const jours = this.cfg.corbeilleJours;
    if (jours <= 0) return 0;
    return this.verrou.executer(async () => {
      const limite = maintenant - jours * JOUR_MS;
      const racine = racineCorbeille(this.cfg);
      let n = 0;
      for (const e of await listerCorbeille(this.cfg)) {
        if (e.date >= limite) continue;
        try {
          await effacerElement(path.join(racine, e.id));
          n++;
        } catch (err) {
          journal({ niveau: "avertissement", quoi: "purge_corbeille", id: e.id, erreur: String((err as Error).message) });
        }
      }
      if (n) journal({ niveau: "info", quoi: "purge_corbeille", n });
      return n;
    });
  }

  demarrerPurge(): void {
    const purger = () => { this.purgerCorbeille().catch((e) => journal({ niveau: "erreur", quoi: "purge_corbeille", erreur: String((e as Error).message) })); };
    purger();
    this.#minuteurPurge = setInterval(purger, JOUR_MS);
    this.#minuteurPurge.unref();
  }

  arreterPurge(): void {
    if (this.#minuteurPurge) clearInterval(this.#minuteurPurge);
    this.#minuteurPurge = null;
  }

  // -------------------------------------------------------------------------------------------
  // Ordre manuel (glisser-déposer) et duplication
  // -------------------------------------------------------------------------------------------

  async placer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const position = corps.position;
    if (position !== "avant" && position !== "apres" && position !== "dans") {
      throw new ErreurHttp(400, "Champ « position » invalide (avant, apres ou dans).", "champ_invalide");
    }
    const brut = chaine(corps.chemin, "chemin", 1024);
    const estPage = brut.normalize("NFC").endsWith(".md");
    const source = estPage ? cheminPage(this.cfg, brut) : cheminAutorise(this.cfg, brut);
    const sourceChemin = source.join("/");
    const cibleBrute = corps.cible === undefined || corps.cible === null ? "" : chaine(corps.cible, "cible", 1024);
    let cible: string[] | null = null;
    let destDossier: string[];
    if (position === "dans") {
      if (cibleBrute === "") destDossier = [];
      else {
        cible = cheminPage(this.cfg, cibleBrute);
        destDossier = dossierDePage(cible);
      }
    } else {
      if (cibleBrute === "") throw new ErreurHttp(400, "Cible manquante.", "cible_absente");
      cible = cibleBrute.normalize("NFC").endsWith(".md") ? cheminPage(this.cfg, cibleBrute) : cheminAutorise(this.cfg, cibleBrute);
      destDossier = cible.slice(0, -1);
    }
    if (cible && cible.join("/") === sourceChemin) throw new ErreurHttp(400, "Une page ne se place pas par rapport à elle-même.", "cible_identique");
    const dest = destDossier.join("/");
    const ancienNom = estPage ? sourceChemin.slice(0, -3) : sourceChemin;
    if (estPage && (dest === ancienNom || dest.startsWith(ancienNom + "/"))) {
      throw new ErreurHttp(400, "Impossible de déplacer une page dans elle-même ou dans une de ses sous-pages.", "deplacement_circulaire");
    }
    if (!estPage && (position === "dans" || dest !== dossierDe(sourceChemin))) {
      throw new ErreurHttp(400, "Un fichier se range seulement parmi ses voisins.", "fichier_deplace");
    }
    const r = await this.verrou.executer(async () => {
      const nomSource = estPage ? feuille(sourceChemin) : source[source.length - 1];
      if (cible) {
        const cc = cible.join("/");
        const existe = cc.endsWith(".md") ? this.#existe(cc) : this.espace.fichiers.has(cc);
        if (!existe) throw new ErreurHttp(404, "Cible introuvable.", "cible_introuvable");
      }
      let chemin = sourceChemin;
      let liensMisAJour = 0;
      if (!estPage) {
        if (!this.espace.fichiers.has(sourceChemin)) throw new ErreurHttp(404, "Fichier introuvable.", "introuvable");
      } else if (dossierDe(sourceChemin) !== dest) {
        const x = await this.#deplacer(source, destDossier, nomSource, ctx.login, "deplacer", mouvementDe(ctx));
        chemin = x.chemin;
        liensMisAJour = x.liensMisAJour;
      } else if (!this.#existe(sourceChemin)) {
        throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      }
      const noms = this.espace.enfantsOrdonnes(dest).filter((n) => n !== nomSource);
      if (position === "dans" || !cible) noms.push(nomSource);
      else {
        const cc = cible.join("/");
        const nomCible = cc.endsWith(".md") ? feuille(cc) : cible[cible.length - 1];
        const i = noms.indexOf(nomCible);
        if (i === -1) noms.push(nomSource);
        else noms.splice(position === "avant" ? i : i + 1, 0, nomSource);
      }
      this.espace.ordres.poser(dest, noms);
      await this.espace.ordres.enregistrer();
      this.#publier(this.espace.arbreModifie());
      return { chemin, liensMisAJour };
    });
    json(ctx, 200, r);
  }

  /** Inventaire d'un dossier à copier (sans liens symboliques ni fichiers cachés), borné. */
  async #inventorier(abs: string): Promise<{ dossiers: string[]; fichiers: string[] }> {
    const dossiers: string[] = [];
    const fichiers: string[] = [];
    let octets = 0;
    const trop = () => new ErreurHttp(413, "Trop de contenu pour dupliquer cette page (2000 éléments ou 200 Mo au plus).", "trop_gros");
    const parcourir = async (rel: string, prof: number): Promise<void> => {
      if (prof > 32) throw trop();
      const entrees = await fsp.readdir(path.join(abs, rel), { withFileTypes: true });
      for (const d of entrees) {
        if (d.name.startsWith(".")) continue;
        const r = rel ? path.join(rel, d.name) : d.name;
        if (d.isDirectory()) {
          dossiers.push(r);
          if (dossiers.length + fichiers.length > MAX_COPIE_ENTREES) throw trop();
          await parcourir(r, prof + 1);
        } else if (d.isFile()) {
          fichiers.push(r);
          octets += (await fsp.lstat(path.join(abs, r))).size;
          if (dossiers.length + fichiers.length > MAX_COPIE_ENTREES || octets > MAX_COPIE_OCTETS) throw trop();
        }
      }
    };
    await parcourir("", 0);
    return { dossiers, fichiers };
  }

  async dupliquer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const source = cheminPage(this.cfg, corps.chemin);
    const chemin = source.join("/");
    const r = await this.verrou.executer(async () => {
      const md = await verifierEcriture(this.cfg, source);
      const dir = await verifierEcriture(this.cfg, dossierDePage(source));
      if (md.st && !md.st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
      const aMd = !!md.st;
      const aDir = !!(dir.st && dir.st.isDirectory());
      if (!aMd && !aDir) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      const inventaire = aDir ? await this.#inventorier(dir.abs) : { dossiers: [], fichiers: [] };
      const contenu = aMd ? (await lireConfine(this.cfg, md.abs, MAX_LECTURE)).contenu : "";
      const dossier = source.slice(0, -1);
      let base = feuille(chemin);
      if (Buffer.byteLength(base) > 220) base = base.slice(0, 100).trim();
      for (let k = 1; k <= 100; k++) {
        const suffixe = k === 1 ? " (copie)" : ` (copie ${k})`;
        const nom = base + suffixe;
        const cible = [...dossier, nom + ".md"];
        const cibleDir = [...dossier, nom];
        if (zoneInterdite(this.cfg, cible) || zoneInterdite(this.cfg, cibleDir)) continue;
        const dMd = await verifierEcriture(this.cfg, cible);
        const dDir = await verifierEcriture(this.cfg, cibleDir);
        if (dMd.st || dDir.st) continue;
        let dirCree = false;
        try {
          // Lot 5 : sous-pages copiées d'abord, puis la page elle-même PAR LA PORTE (création exclusive, intention
          // durable, journal « dupliquer ») : l'écriture journalisée est la dernière, rien à défaire après elle.
          if (aDir) {
            await fsp.mkdir(dDir.abs, { mode: 0o755 });
            dirCree = true;
            for (const d of inventaire.dossiers) await fsp.mkdir(path.join(dDir.abs, d), { mode: 0o755 });
            for (const f of inventaire.fichiers) {
              const st = await fsp.lstat(path.join(dir.abs, f));
              if (!st.isFile()) continue; // devenu un lien entre-temps : ignoré
              await fsp.copyFile(path.join(dir.abs, f), path.join(dDir.abs, f), fs.constants.COPYFILE_EXCL);
            }
          }
          if (aMd) {
            await this.ecrivain.ecrireSousVerrou({
              chemin: cible, revision: null, action: "dupliquer", transformer: () => titreDeCopie(chemin, contenu, suffixe), operation: { source: chemin },
            }, ctx.login);
          }
        } catch (e) {
          if (dirCree) await fsp.rm(dDir.abs, { recursive: true, force: true }).catch(() => {});
          if (e instanceof ErreurHttp && e.raison === "existe") continue;
          if ((e as NodeJS.ErrnoException).code === "EEXIST" && !dirCree) continue;
          throw e;
        }
        const ordre = this.espace.ordres.insererApres(dossier.join("/"), feuille(chemin), nom);
        if (ordre) await this.espace.ordres.enregistrer().catch((e) => journal({ niveau: "avertissement", quoi: "ordre", erreur: String((e as Error).message) }));
        const ch = await this.espace.traiter([cible.join("/"), cibleDir.join("/")]);
        if (ordre) ch.arbre = true;
        this.#publier(ch);
        return { chemin: cible.join("/") };
      }
      throw new ErreurHttp(409, "Trop de copies portent déjà ce nom.", "conflit_nom");
    });
    json(ctx, 201, r);
  }

  // -------------------------------------------------------------------------------------------
  // Historique des versions (git en lecture seule + instantanés)
  // -------------------------------------------------------------------------------------------

  /**
   * Version automatique de séance (lot 4 « Corrections ») : appelée sous le verrou, juste avant qu'une écriture de
   * Carnet remplace une page EXISTANTE (PUT /api/page, /api/tache, /api/meta). Voir Instantanes.seance.
   */
  async historique(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const chemin = segs.join("/");
    const commits = await this.git.historique(chemin, true);
    const instantanes = await this.instantanes.lister(segs);
    const versions: Array<Record<string, unknown> & { date: number }> = [
      ...commits.map((c) => ({ id: `git:${c.hash}`, date: c.date, source: "git", auteur: c.auteur, message: c.message })),
      ...instantanes.map((i) => ({ id: i.id, date: i.date, source: "instantane", auto: i.auto, genre: i.genre, ...(i.ecrasee ? { ecrasee: true } : {}) })),
    ];
    versions.sort((a, b) => b.date - a.date);
    json(ctx, 200, { git: this.git.actif, versions, pauseVersions: this.cfg.pauseVersions });
  }

  /** Contenu d'une version : `git:<hash>` (commit de l'historique de CETTE page, chemin dans l'espace) ou `inst:<stamp>`. */
  async #version(segs: string[], id: unknown): Promise<{ id: string; date: number; contenu: string }> {
    if (typeof id !== "string" || id.length > 200) throw new ErreurHttp(400, "Version invalide.", "version_invalide");
    if (id.startsWith("git:")) {
      const hash = id.slice(4);
      if (!RE_HASH.test(hash)) throw new ErreurHttp(400, "Version invalide.", "version_invalide");
      if (!this.git.actif) throw new ErreurHttp(404, "Historique git indisponible.", "git_absent");
      const chemin = segs.join("/");
      let c = (await this.git.historique(chemin)).find((x) => x.hash === hash);
      if (!c) c = (await this.git.historique(chemin, true)).find((x) => x.hash === hash);
      if (!c) throw new ErreurHttp(404, "Version introuvable pour cette page.", "version_introuvable");
      // Un ancien nom hors de l'espace (renommage suivi par git) n'est jamais lu.
      if (!c.chemin.startsWith(this.git.prefixe)) throw new ErreurHttp(403, "Version hors de l'espace.", "hors_espace");
      try {
        cheminPage(this.cfg, c.chemin.slice(this.git.prefixe.length));
      } catch {
        throw new ErreurHttp(403, "Version hors de l'espace.", "hors_espace");
      }
      return { id, date: c.date, contenu: await this.git.lire(hash, c.chemin) };
    }
    if (id.startsWith("inst:")) {
      const stamp = id.slice(5);
      if (!RE_INSTANTANE.test(stamp)) throw new ErreurHttp(400, "Version invalide.", "version_invalide");
      const x = await this.instantanes.lire(segs, stamp);
      return { id, date: x.date, contenu: x.contenu };
    }
    throw new ErreurHttp(400, "Version invalide.", "version_invalide");
  }

  async version(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    json(ctx, 200, await this.#version(segs, ctx.url.searchParams.get("id")));
  }

  async instantane(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const r = await this.verrou.executer(async () => {
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      if (!st || !st.isFile()) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      const { contenu } = await lireConfine(this.cfg, abs, MAX_LECTURE);
      const x = await this.instantanes.creer(segs, contenu, false);
      return { id: x.id, date: x.date, identique: x.identique };
    });
    json(ctx, 201, r);
  }

  async restaurerVersion(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const v = await this.#version(segs, corps.id);
    if (Buffer.byteLength(v.contenu) > MAX_PAGE) throw new ErreurHttp(413, "Version trop volumineuse (maximum 2 Mo).", "trop_gros");
    const ifMatch = ctx.req.headers["if-match"];
    const r = await this.verrou.executer(async () => {
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      if (st) {
        if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
        const a = await this.#actuel(abs);
        if (!a) throw new ErreurHttp(409, "Page illisible.", "illisible");
        if (ifMatch !== undefined && ifMatch.trim() !== "*" && !ifMatch.split(",").some((x) => normEtag(x) === a.etag)) {
          throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", { etag: a.etag, contenu: a.contenu });
        }
        const inst = await this.instantanes.creer(segs, a.contenu, true);
        if (a.contenu === v.contenu) return { etag: a.etag, instantane: inst.id };
        // Lot 5 : une ancienne attestation de décision ne redevient jamais valide par une restauration (barrière).
        const attester = await barriereRestauration(this.cfg, this.ecrivain, v.contenu, "restauration");
        const r = await this.ecrivain.ecrireSousVerrou({ chemin: segs, revision: a.etag, action: "restauration", transformer: () => v.contenu, ...(attester ? { attester } : {}) }, ctx.login);
        return { etag: r.etag, instantane: inst.id };
      }
      const attester = await barriereRestauration(this.cfg, this.ecrivain, v.contenu, "restauration");
      const r = await this.ecrivain.ecrireSousVerrou({ chemin: segs, revision: null, action: "restauration", transformer: () => v.contenu, ...(attester ? { attester } : {}) }, ctx.login);
      return { etag: r.etag, instantane: null };
    });
    json(ctx, 200, r);
  }

  // -------------------------------------------------------------------------------------------
  // Rétroliens, aperçu, couvertures
  // -------------------------------------------------------------------------------------------

  async retroliens(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    json(ctx, 200, { pages: retroliens(this.espace, segs.join("/")) });
  }

  async apercu(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const chemin = segs.join("/");
    const p = this.espace.pages.get(chemin);
    if (!p) {
      const d = this.espace.dossiers.get(chemin.slice(0, -3));
      if (!d) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      json(ctx, 200, { chemin, titre: feuille(chemin), icone: null, resume: null, extrait: "", mtime: d.mtime, sousPages: this.espace.nbEnfants(chemin) });
      return;
    }
    json(ctx, 200, {
      chemin, titre: p.titre, icone: p.icone, resume: p.resume, extrait: texteApercu(p.contenu.slice(p.debutCorps)), mtime: p.mtime,
      sousPages: this.espace.nbEnfants(chemin),
    });
  }

  async couvertures(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("page"));
    const dossier = segs.slice(0, -1);
    const base = dossier.join("/");
    const vus = new Set<string>();
    const images: { chemin: string; relatif: string }[] = [];
    const ajouter = (c: string) => {
      if (vus.has(c) || images.length >= 200) return;
      vus.add(c);
      const rel = path.posix.relative(base ? "/" + base : "/", "/" + c);
      images.push({ chemin: c, relatif: rel.split("/").map((x) => (x === ".." ? x : encodeURIComponent(x))).join("/") });
    };
    for (let i = dossier.length; i >= 0 && images.length < 200; i--) {
      const d = [...dossier.slice(0, i), "_assets"];
      if (zoneInterdite(this.cfg, d)) continue;
      const abs = await resoudre(this.cfg, d);
      let reel: string;
      try {
        reel = await fsp.realpath(abs);
      } catch {
        continue;
      }
      if (!reelAutorise(this.cfg, reel)) continue;
      const st = await lstatOuNull(reel);
      if (!st || !st.isDirectory()) continue;
      let entrees: fs.Dirent[];
      try {
        entrees = await fsp.readdir(reel, { withFileTypes: true });
      } catch {
        continue;
      }
      entrees.sort((a, b) => collateur.compare(a.name, b.name));
      for (const e of entrees) {
        const nom = e.name.normalize("NFC");
        if (nom.startsWith(".") || !EXT_IMAGES.has(extension(nom))) continue;
        if (e.isSymbolicLink()) {
          try {
            const r = await fsp.realpath(path.join(reel, e.name));
            if (!reelAutorise(this.cfg, r) || !(await fsp.stat(r)).isFile()) continue;
          } catch {
            continue;
          }
        } else if (!e.isFile()) continue;
        ajouter([...d, nom].join("/"));
      }
    }
    for (const f of this.espace.fichiers.values()) if (EXT_IMAGES.has(f.ext)) ajouter(f.chemin);
    json(ctx, 200, { images });
  }

  // -------------------------------------------------------------------------------------------
  // Recherche, accueil, projets
  // -------------------------------------------------------------------------------------------

  async recherche(ctx: Ctx): Promise<void> {
    const q = (ctx.url.searchParams.get("q") ?? "").slice(0, 200);
    const l = Number.parseInt(ctx.url.searchParams.get("limite") ?? "30", 10);
    const limite = Number.isFinite(l) ? Math.min(100, Math.max(1, l)) : 30;
    // lot 6 : `archives=1` = filtre « Inclure les archives » (sinon les pages archivées ne sortent pas)
    json(ctx, 200, { resultats: this.espace.rechercher(q, limite, ctx.url.searchParams.get("archives") === "1") });
  }

  async accueil(ctx: Ctx): Promise<void> {
    // Fichiers des agents (lot 3) : exclus de l'accueil (toujours dans l'arbre et la recherche explicite).
    // lot 6 : ni pages archivées ni modèles (pagesCourantes)
    const pages = this.espace.pagesCourantes().filter((p) => !estTechnique(this.cfg.techniques, p.chemin)).sort((a, b) => b.mtime - a.mtime);
    const resume = (p: Page) => ({ chemin: p.chemin, titre: p.titre, icone: p.icone, mtime: p.mtime, resume: this.espace.resume(p) });
    const recents = pages.slice(0, 12).map(resume);
    const aRelire: unknown[] = [];
    for (const p of pages) {
      const raisons: string[] = [];
      if (p.statut !== null && plier(p.statut).trim() === "a relire") raisons.push("statut");
      if (p.mention) raisons.push("mention");
      if (raisons.length) aRelire.push({ ...resume(p), raisons });
      if (aRelire.length >= 100) break;
    }
    const taches: unknown[] = [];
    for (const p of pages) {
      for (const t of p.taches) {
        if (taches.length >= 300) break;
        taches.push({ chemin: p.chemin, titre: p.titre, ligne: t.ligne, texte: t.texte, libelle: t.libelle });
      }
      if (taches.length >= 300) break;
    }
    json(ctx, 200, { recents, aRelire, taches });
  }

  async projets(ctx: Ctx): Promise<void> {
    const dossier = ctx.url.searchParams.get("dossier");
    let liste: Page[];
    if (dossier !== null) {
      const d = cheminAutorise(this.cfg, dossier.replace(/\.md$/, ""), { vide: true }).join("/");
      liste = this.espace.pagesCourantes().filter((p) => dossierDe(p.chemin) === d); // lot 6 : sans archives ni modèles
    } else {
      liste = this.espace.pagesCourantes().filter((p) => p.tags.some((t) => plier(t) === "projet"));
    }
    liste.sort((a, b) => {
      if (a.ordre !== null && b.ordre !== null && a.ordre !== b.ordre) return a.ordre - b.ordre;
      if (a.ordre !== null && b.ordre === null) return -1;
      if (a.ordre === null && b.ordre !== null) return 1;
      return collateur.compare(a.titre, b.titre);
    });
    const pages = liste.map((p) => {
      const meta: Record<string, string> = {};
      for (const [k, v] of Object.entries(p.fm ?? {})) {
        if (Array.isArray(v)) {
          const t = v.map(texte);
          if (t.every((x) => x !== null)) meta[k] = t.join(", ");
        } else {
          const t = texte(v);
          if (t !== null) meta[k] = t;
        }
      }
      return { chemin: p.chemin, titre: p.titre, icone: p.icone, mtime: p.mtime, meta };
    });
    json(ctx, 200, { pages });
  }

  /**
   * Modifier UNE tâche (V2 : cocher/décocher ; V3 : échéance, priorité, date de clôture, via shared/taches.ts).
   * Corps : {chemin, ligne, texte (ligne attendue, sans \r), coche?, echeance? (AAAA-MM-JJ|null), priorite? (|null),
   * faite? (AAAA-MM-JJ|null|true = aujourd'hui dans CARNET_FUSEAU)}. 409 `tache_changee` si la ligne a changé.
   */
  async tache(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const ligne = corps.ligne;
    if (typeof ligne !== "number" || !Number.isInteger(ligne) || ligne < 0) throw new ErreurHttp(400, "Champ « ligne » invalide.", "champ_invalide");
    const texteAttendu = chaine(corps.texte, "texte", 100_000);
    const changements: Partial<ChangementsTache> = {};
    const invalide = (nom: string) => new ErreurHttp(400, `Champ « ${nom} » invalide.`, "champ_invalide");
    if (corps.coche !== undefined) {
      if (typeof corps.coche !== "boolean") throw invalide("coche");
      changements.coche = corps.coche;
    }
    if (corps.echeance !== undefined) {
      if (corps.echeance !== null && typeof corps.echeance !== "string") throw invalide("echeance");
      changements.echeance = corps.echeance as string | null;
    }
    if (corps.priorite !== undefined) {
      if (corps.priorite !== null && !["plus-haute", "haute", "moyenne", "basse", "plus-basse"].includes(corps.priorite as string)) throw invalide("priorite");
      changements.priorite = corps.priorite as Priorite | null;
    }
    if (corps.faite !== undefined) {
      if (corps.faite === true) changements.faite = dateDuJour(this.cfg.fuseau);
      else if (corps.faite === null || typeof corps.faite === "string") changements.faite = corps.faite as string | null;
      else throw invalide("faite");
    }
    if (!Object.keys(changements).length) throw invalide("coche");
    const ifMatch = ctx.req.headers["if-match"];
    let texteFinal = texteAttendu;
    const r = await this.ecrivain.ecrire({
      chemin: segs, revision: ifMatch !== undefined && ifMatch.trim() !== "*" ? normEtag(ifMatch.split(",")[0]) : REVISION_EXISTANTE,
      action: "tache", requete: requeteDe(ctx), operation: { ligne, texte: texteAttendu, changements },
      transformer: (avant) => {
        const lignes = (avant ?? "").split("\n");
        const conflit = () => new ErreurHttp(409, "La tâche a changé entre-temps : recharge la page.", "tache_changee");
        if (ligne >= lignes.length) throw conflit();
        const brute = lignes[ligne];
        const cr = brute.endsWith("\r") ? "\r" : "";
        const l = cr ? brute.slice(0, -1) : brute;
        if (l !== texteAttendu || marquerCode(lignes)[ligne] || !analyserTache(l)) throw conflit();
        texteFinal = modifierTache(l, changements);
        lignes[ligne] = texteFinal + cr;
        return lignes.join("\n");
      },
    }, ctx.login);
    json(ctx, 200, { etag: r.etag, texte: r.rejoue ? null : texteFinal, ...(r.rejoue ? { rejoue: true } : {}) });
  }

  /**
   * Propriétés (frontmatter), une ou plusieurs, chacune modifiée seule (shared/proprietes.ts : reste conservé à l'octet).
   * - `champs` (V2) : {cle: texte | nombre | booléen (écrits en texte) | null = RETIRER la clé} ;
   * - `proprietes` (V3) : {cle: texte | nombre | booléen | null (écrit `null`) | liste de textes}, `retirer: [cles]`,
   *   `types: {cle: "texte"|"nombre"|"case"|"date"|"liste"|"selection"}` (guide l'écriture, valide la valeur).
   * YAML actuel invalide ou syntaxe refusée (ancres, étiquettes, clés en double…) : 422 explicite, rien n'est écrit.
   */
  async meta(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const operations: { cle: string; valeur: ValeurPropriete | undefined; type?: TypePropriete }[] = [];
    if (corps.champs !== undefined) {
      const champs = corps.champs;
      if (!champs || typeof champs !== "object" || Array.isArray(champs)) throw new ErreurHttp(400, "Champ « champs » invalide.", "champ_invalide");
      const entrees = Object.entries(champs as Record<string, unknown>);
      if (!entrees.length || entrees.length > 50) throw new ErreurHttp(400, "Entre 1 et 50 champs.", "champ_invalide");
      for (const [k, v] of entrees) {
        if (!RE_CLE_META.test(k)) throw new ErreurHttp(400, `Clé invalide : ${k.slice(0, 64)}`, "cle_invalide");
        if (v === null) operations.push({ cle: k, valeur: undefined });
        else if (typeof v === "number" || typeof v === "boolean") operations.push({ cle: k, valeur: String(v) });
        else if (typeof v !== "string" || v.length > 10_000) throw new ErreurHttp(400, `Valeur invalide pour ${k}.`, "valeur_invalide");
        else operations.push({ cle: k, valeur: v });
      }
    }
    if (corps.proprietes !== undefined || corps.retirer !== undefined) {
      const p = corps.proprietes ?? {};
      const types = corps.types ?? {};
      if (!p || typeof p !== "object" || Array.isArray(p)) throw new ErreurHttp(400, "Champ « proprietes » invalide.", "champ_invalide");
      if (!types || typeof types !== "object" || Array.isArray(types)) throw new ErreurHttp(400, "Champ « types » invalide.", "champ_invalide");
      const retirer = corps.retirer ?? [];
      if (!Array.isArray(retirer) || retirer.some((k) => typeof k !== "string")) throw new ErreurHttp(400, "Champ « retirer » invalide.", "champ_invalide");
      for (const [k, v] of Object.entries(p as Record<string, unknown>)) {
        const type = (types as Record<string, unknown>)[k];
        if (type !== undefined && !["texte", "nombre", "case", "date", "liste", "selection"].includes(type as string)) throw new ErreurHttp(400, `Type invalide pour ${k.slice(0, 64)}.`, "champ_invalide");
        operations.push({ cle: k, valeur: v as ValeurPropriete, ...(type ? { type: type as TypePropriete } : {}) });
      }
      for (const k of retirer as string[]) operations.push({ cle: k, valeur: undefined });
    }
    if (!operations.length || operations.length > 50) throw new ErreurHttp(400, "Entre 1 et 50 champs.", "champ_invalide");
    const ifMatch = ctx.req.headers["if-match"];
    const r = await this.ecrivain.ecrire({
      chemin: segs, revision: ifMatch !== undefined && ifMatch.trim() !== "*" ? normEtag(ifMatch.split(",")[0]) : REVISION_EXISTANTE,
      action: "meta", requete: requeteDe(ctx), operation: operations,
      transformer: (avant) => {
        let c = avant ?? "";
        for (const o of operations) c = poserPropriete(c, o.cle, o.valeur, o.type ? { type: o.type } : {});
        return c;
      },
    }, ctx.login);
    json(ctx, 200, { etag: r.etag, ...(r.rejoue ? { rejoue: true } : {}) });
  }

  /** Attestations d'une page (lecture pour les agents) : chacune avec `valide` (signature vérifiée par le serveur). */
  async listerAttestations(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const demande = ctx.url.searchParams.get("demande");
    const l = await this.ecrivain.attestations.lister({ chemin: segs.join("/"), ...(demande ? { demande } : {}) });
    json(ctx, 200, { chemin: segs.join("/"), attestations: l.map((x) => ({ ...x.attestation, valide: x.valide })) });
  }

  // -------------------------------------------------------------------------------------------
  // Images et fichiers
  // -------------------------------------------------------------------------------------------

  async images(ctx: Ctx): Promise<void> {
    const segsPage = cheminPage(this.cfg, ctx.url.searchParams.get("page"));
    const ct = String(ctx.req.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase();
    const extParType: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
    const ext = extParType[ct];
    if (!ext) throw new ErreurHttp(415, "Type d'image non accepté (png, jpeg, webp ou gif).", "type_image");
    const donnees = await lireCorps(ctx.req, MAX_IMAGE);
    if (!donnees.length) throw new ErreurHttp(400, "Image vide.", "image_vide");
    const vrai = typeImage(donnees);
    if (vrai !== (ext === "jpg" ? "jpeg" : ext)) throw new ErreurHttp(415, "Le contenu ne correspond pas au type d'image annoncé.", "octets_magiques");
    let nomBrut = "image";
    const enTete = ctx.req.headers["x-nom-fichier"];
    if (typeof enTete === "string" && enTete) {
      try { nomBrut = decodeURIComponent(enTete); } catch { nomBrut = enTete; }
    }
    const slug = plier(nomBrut.replace(/\.[A-Za-z0-9]{1,5}$/, "")).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60).replace(/-+$/, "") || "image";
    const dossier = [...segsPage.slice(0, -1), "_assets"];
    exigerZoneAutorisee(this.cfg, dossier);
    const r = await this.verrou.executer(async () => {
      const stamp = horodatage();
      for (let k = 1; k <= 100; k++) {
        const nom = `${slug}-${stamp}${k === 1 ? "" : "-" + k}.${ext}`;
        const segs = [...dossier, nom];
        const v = await verifierEcriture(this.cfg, segs);
        if (v.st) continue;
        await creerDossiers(this.cfg, path.dirname(v.abs));
        try {
          await ecrireAtomique(v.abs, donnees, { exclusif: true });
        } catch (e) {
          if (e instanceof ErreurHttp && e.raison === "existe") continue;
          throw e;
        }
        return { chemin: segs.join("/"), relatif: `_assets/${encodeURIComponent(nom).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase())}` };
      }
      throw new ErreurHttp(409, "Impossible de nommer l'image.", "conflit_nom");
    });
    json(ctx, 201, r);
  }

  async fichier(ctx: Ctx): Promise<void> {
    const segs = cheminAutorise(this.cfg, ctx.url.searchParams.get("chemin"));
    const nom = segs[segs.length - 1];
    const ext = extension(nom);
    const enLigne = EXT_IMAGES.has(ext);
    if (!enLigne && !EXT_TELECHARGEMENT.has(ext)) throw new ErreurHttp(403, "Type de fichier non servi.", "type_interdit");
    const { fh, st } = await ouvrirConfine(this.cfg, await resoudre(this.cfg, segs));
    let transmis = false;
    try {
      if (!st.isFile()) throw new ErreurHttp(404, "Introuvable.", "pas_un_fichier");
      const res = ctx.res;
      if (enLigne) {
        const tete = Buffer.alloc(64);
        const { bytesRead } = await fh.read(tete, 0, 64, 0);
        const vrai = typeImage(tete.subarray(0, bytesRead));
        const attendu = ext === "jpg" ? "jpeg" : ext;
        if (vrai !== attendu) throw new ErreurHttp(403, "Contenu non conforme à l'extension.", "octets_magiques");
      }
      const etag = `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`;
      res.setHeader("Content-Security-Policy", CSP_FICHIER);
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, max-age=300");
      const inm = ctx.req.headers["if-none-match"];
      if (typeof inm === "string" && inm.split(",").some((v) => v.trim().replace(/^W\//, "") === etag)) {
        res.statusCode = 304;
        res.end();
        return;
      }
      if (enLigne) {
        res.setHeader("Content-Type", MIME_IMAGE[ext]);
      } else {
        res.setHeader("Content-Type", "application/octet-stream");
        const ascii = nom.normalize("NFKD").replace(/[^\x20-\x7e]/g, "").replace(/["\\]/g, "_") || "fichier";
        res.setHeader("Content-Disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(nom)}`);
      }
      res.setHeader("Content-Length", String(st.size));
      res.statusCode = 200;
      if (ctx.req.method === "HEAD") {
        res.end();
        return;
      }
      const flux = fh.createReadStream({ start: 0, end: Math.max(0, st.size - 1), autoClose: true });
      transmis = true;
      await new Promise<void>((ok) => {
        flux.on("error", () => { res.destroy(); ok(); });
        res.on("close", () => { flux.destroy(); ok(); });
        flux.on("end", () => ok());
        if (st.size === 0) { flux.destroy(); res.end(); ok(); return; }
        flux.pipe(res);
      });
    } finally {
      if (!transmis) await fh.close().catch(() => {});
    }
  }

  // -------------------------------------------------------------------------------------------
  // SSE, favoris, artefacts
  // -------------------------------------------------------------------------------------------

  async evenements(ctx: Ctx): Promise<void> {
    if (this.diffuseur.plein()) throw new ErreurHttp(503, "Trop de connexions en direct.", "sse_plein", undefined, { "Retry-After": "10" });
    await new Promise<void>((ok) => this.diffuseur.ouvrir(ctx.req, ctx.res, ok));
  }

  #fichierFavoris(): string {
    return path.join(this.cfg.etat, "favoris.json");
  }

  async #lireFavoris(): Promise<string[]> {
    try {
      const v: unknown = JSON.parse(await fsp.readFile(this.#fichierFavoris(), "utf8"));
      const l = v && typeof v === "object" && Array.isArray((v as { chemins?: unknown }).chemins) ? (v as { chemins: unknown[] }).chemins : [];
      return l.filter((c): c is string => typeof c === "string");
    } catch {
      return [];
    }
  }

  async #ecrireFavoris(chemins: string[]): Promise<void> {
    await fsp.mkdir(this.cfg.etat, { recursive: true, mode: 0o700 });
    await ecrireAtomique(this.#fichierFavoris(), JSON.stringify({ chemins }, null, 1) + "\n", { mode: 0o600 });
  }

  async #majFavoris(f: (c: string) => string | null): Promise<void> {
    const avant = await this.#lireFavoris();
    if (!avant.length) return;
    const apres = avant.map(f).filter((c): c is string => c !== null);
    if (apres.length !== avant.length || apres.some((c, i) => c !== avant[i])) {
      await this.#ecrireFavoris([...new Set(apres)]).catch((e) => journal({ niveau: "avertissement", quoi: "favoris", erreur: String((e as Error).message) }));
    }
  }

  async lireFavoris(ctx: Ctx): Promise<void> {
    json(ctx, 200, { chemins: await this.#lireFavoris() });
  }

  async ecrireFavoris(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 256 * 1024);
    const l = corps.chemins;
    if (!Array.isArray(l) || l.length > 500) throw new ErreurHttp(400, "Champ « chemins » invalide (500 au plus).", "champ_invalide");
    const chemins = [...new Set(l.map((c) => cheminAutorise(this.cfg, c).join("/")))];
    await this.verrou.executer(() => this.#ecrireFavoris(chemins));
    json(ctx, 200, { chemins });
  }

  async artefacts(ctx: Ctx): Promise<void> {
    json(ctx, 200, { artefacts: await listerArtefacts(this.cfg) });
  }
  // -------------------------------------------------------------------------------------------
  // V3 lot 2 « Bases » (lecture ; les écritures passent par l'Ecrivain)
  // -------------------------------------------------------------------------------------------

  /** GET /api/base?chemin=<page>&bloc=<n>&vue=<i> : le bloc ```base n° n de la page, tel qu'il est sur le disque. */
  async lireBase(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const bloc = lireVue(ctx.url.searchParams.get("bloc"));
    const vue = lireVue(ctx.url.searchParams.get("vue"));
    const { blocs } = await this.bases.blocsDePage(segs);
    const b = blocs[bloc];
    if (!b) throw new ErreurHttp(404, `Pas de bloc base n° ${bloc} dans cette page.`, "bloc_introuvable", { blocs: blocs.length });
    if (b.ligneFin === -1) throw erreurBase([{ ou: "bloc", message: "Bloc base non fermé (``` manquant)." }]);
    json(ctx, 200, { chemin: segs.join("/"), bloc, source: b.source, ...this.bases.evaluerSource(b.source, vue) });
  }

  /** POST /api/base/evaluer { chemin, source, vue } : évalue le YAML affiché par l'éditeur (rien n'est écrit). */
  async evaluerBase(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 128 * 1024);
    cheminPage(this.cfg, corps.chemin);
    json(ctx, 200, this.bases.evaluerSource(lireSource(corps.source), lireVue(corps.vue)));
  }

  /** POST /api/base/reecrire { source, vue, changement } : nouveau YAML du bloc (filtres, tri, vues : K14-01) ou 422 si non conservable. */
  async reecrireBase(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 128 * 1024);
    const source = lireSource(corps.source);
    const vue = lireVue(corps.vue);
    const { def, erreurs } = lireDefinition(source);
    if (!def) throw erreurBase(erreurs);
    const ch = lireChangement(corps.changement);
    // K14-01 : `avant` / `apres` = filtres et tri de la vue avant et après (l'interface retient l'état d'origine pour
    // « Enregistrer comme nouvelle vue… ») ; `vue` = vue à montrer ensuite (nouvelle, ou voisine d'une vue supprimée).
    const avant = etatVue(source, vue);
    // Échéances (11/10/2026) : « Afficher dans Aujourd'hui » ; la déclaration est relue (sinon 422 avec la raison)
    // et la réponse porte l'aperçu (fiches concernées) calculé sur le bloc réécrit. Rien n'est écrit sur le disque.
    if (ch.aujourdhui !== undefined) {
      const nouveau = poserAujourdhui(source, ch.aujourdhui);
      const lu = lireDefinition(nouveau);
      if (!lu.def) throw erreurBase(lu.erreurs);
      if (ch.aujourdhui && !lu.def.aujourdhui) {
        const raison = lu.def.avertissements.find((a) => a.startsWith("carnet.aujourdhui")) ?? "déclaration refusée.";
        throw new ErreurHttp(422, raison, "reecriture_refusee", { raison: "reecriture_refusee" });
      }
      const chemin = typeof corps.chemin === "string" ? cheminPage(this.cfg, corps.chemin).join("/") : null;
      const apercu = lu.def.aujourdhui && chemin ? this.bases.apercuAujourdhui(chemin, lu.def) : null;
      json(ctx, 200, { source: nouveau, vue, inchange: nouveau === source, avant, apres: etatVue(nouveau, vue), ...(apercu ? { apercu } : {}) });
      return;
    }
    const res = estChangementDeVues(ch) ? changerVues(source, vue, ch) : { source: reecrireVue(source, vue, ch), vue };
    json(ctx, 200, { ...res, inchange: res.source === source, avant, apres: etatVue(res.source, res.vue) });
  }

  /** POST /api/base/dossier { page, nom } : crée le dossier d'une nouvelle base sous la page (nom unique). */
  /**
   * K10-01 · GET /api/bases/destinations : « Ajouter à <base> » au rangement (Boîte, « Déplacer vers… »). Lecture
   * seule ; le rangement lui-même passe par POST /api/deplacer avec `parent` (porte d'écriture, journal, idempotence).
   */
  async destinationsBases(ctx: Ctx): Promise<void> {
    json(ctx, 200, { destinations: await this.bases.destinations() });
  }

  async dossierBase(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const nom = chaine(corps.nom, "nom", 120).replace(/\s+/g, " ").trim();
    if (!nom) throw new ErreurHttp(400, "Nom vide.", "nom_vide");
    const r = await this.verrou.executer(() => this.bases.creerDossier(chaine(corps.page, "page", 1024), nom));
    json(ctx, 201, r);
  }

  /**
   * POST /api/propriete { chemin, cle, valeur | retirer: true, type?, options? } + If-Match (révision affichée) +
   * X-Carnet-Requete : pose UNE propriété (cellule d'une base, panneau « Propriétés ») par l'Ecrivain. Le type vient
   * de la requête (colonne de la base affichée) ou, à défaut, de la base dont la page est une entrée. Saisie hors type
   * ou hors liste : 422 ; fichier changé depuis l'affichage : 412 + version actuelle (rien n'est écrasé).
   */
  async ecrirePropriete(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 64 * 1024);
    const segs = cheminPage(this.cfg, corps.chemin);
    const cle = chaine(corps.cle, "cle", 64);
    const retirer = corps.retirer === true;
    if (CLES_PROVENANCE.has(cle)) {
      throw new ErreurHttp(422, `« ${cle} » est une propriété de provenance : Carnet l'affiche sans jamais la réécrire.`, "provenance", { raison: "provenance" });
    }
    if (!retirer && !Object.hasOwn(corps, "valeur")) throw new ErreurHttp(400, "Champ « valeur » (ou « retirer ») manquant.", "champ_invalide");
    const ifMatch = ctx.req.headers["if-match"];
    if (ifMatch === undefined || ifMatch.trim() === "" || ifMatch.trim() === "*") {
      throw new ErreurHttp(428, "En-tête If-Match obligatoire : la révision affichée de la page.", "if_match_absent");
    }
    let decl: DeclarationPropriete | null = null;
    if (corps.type !== undefined && corps.type !== null) {
      const erreurs: ErreurBase[] = [];
      decl = lireDeclaration({ type: corps.type, options: corps.options ?? undefined }, "type", erreurs);
      if (!decl) throw new ErreurHttp(400, erreurs[0]?.message ?? "Type invalide.", "champ_invalide");
    } else {
      decl = this.bases.declarationPour(segs.join("/"), cle);
    }
    let valeur: ValeurSaisie | undefined;
    if (!retirer) {
      const v = validerSaisie(decl, corps.valeur);
      if (!v.ok) throw new ErreurHttp(422, `Valeur refusée pour « ${cle} » : ${v.message}`, "valeur_invalide", { raison: "valeur_invalide" });
      valeur = v.valeur;
    }
    let apres: string | null = null;
    const r = await this.ecrivain.ecrire({
      chemin: segs, revision: normEtag(ifMatch.split(",")[0]), action: "propriete", requete: requeteDe(ctx),
      operation: { cle, valeur: retirer ? null : valeur, retirer, type: decl?.type ?? null, options: decl?.options ?? null },
      transformer: (avant) => {
        // Intégration lots 2 et 3 : le statut d'une demande de décision ne s'écrit que par le geste attesté
        // (POST /api/decision) ; le panneau Propriétés l'affiche comme une déclaration, sans le modifier.
        if ((cle === "statut" || cle === "engage") && lireProprietes(avant ?? "").valeurs.type === "decision") {
          throw new ErreurHttp(422, `« ${cle} » d'une demande de décision ne se modifie pas ici : utilise la barre de décision (Approuver, Demander une correction, Refuser).`, "decision", { raison: "decision" });
        }
        let res = poserPropriete(avant ?? "", cle, valeur, { type: typeSocle(decl) });
        // Lot 6 : désarchiver / déverrouiller une page qui n'avait pas d'en-tête la rend à l'octet (en-tête vide retiré).
        if (retirer && CLES_PAGES.has(cle)) {
          const d = decouper(res);
          if (d.frontmatter && d.yaml.trim() === "") res = res.slice(d.frontmatter.length);
        }
        return (apres = res);
      },
      // Lot 6 : poser ou retirer `verrou` est la seule écriture admise sur une page verrouillée.
      ...(cle === "verrou" ? { deverrouiller: true } : {}),
    }, ctx.login);
    const contenu = apres ?? (await lireConfine(this.cfg, await resoudre(this.cfg, segs), MAX_LECTURE)).contenu;
    json(ctx, 200, { etag: r.etag, contenu, ...(r.inchange ? { inchange: true } : {}), ...(r.rejoue ? { rejoue: true } : {}) }, { ETag: r.etag });
  }

  /**
   * POST /api/base/entree { page, source, titre } + X-Carnet-Requete : nouvelle entrée de la base, page au nom unique
   * (« Titre.md », « Titre (2).md »…, création exclusive) dans `carnet.dossier`, avec les valeurs `carnet.nouvelle`.
   */
  async entreeBase(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 128 * 1024);
    cheminPage(this.cfg, corps.page);
    const source = lireSource(corps.source);
    const { def, erreurs } = lireDefinition(source);
    if (!def) throw erreurBase(erreurs);
    if (!def.dossier) throw new ErreurHttp(422, "Cette base ne déclare pas de dossier pour ses nouvelles entrées (carnet.dossier).", "sans_dossier", { raison: "sans_dossier" });
    const dossier = this.bases.dossierAutorise(def.dossier);
    const brut = corps.titre === undefined || corps.titre === null ? "" : chaine(corps.titre, "titre", 200);
    const titre = brut.replace(/\s*[\r\n]+\s*/g, " ").trim() || "Sans titre";
    const r = await this.ecrivain.creerUnique({
      dossier, base: titre, action: "base-entree", requete: requeteDe(ctx),
      operation: { dossier: dossier.join("/"), titre, nouvelle: def.nouvelle },
      transformer: () => {
        let contenu = `# ${titre}\n\n`;
        for (const [k, v] of Object.entries(def.nouvelle)) contenu = poserPropriete(contenu, k, v, { type: typeSocle(def.declarations.get(k)) });
        return contenu;
      },
    }, ctx.login);
    json(ctx, 201, { chemin: r.chemin, etag: r.etag, ...(r.rejoue ? { rejoue: true } : {}) }, { ETag: r.etag });
  }

  /** GET /api/proprietes?chemin=<page> : propriétés typées du frontmatter (panneau « Propriétés »). */
  async lireProprietes(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const p = this.espace.pages.get(segs.join("/"));
    // page pas (encore) dans l'index (dossier sans page, renommage en cours) : rien à montrer, sans erreur
    if (!p) {
      json(ctx, 200, { chemin: segs.join("/"), absente: true, etag: null, yamlInvalide: null, nonModifiable: null, proprietes: [], base: null, declarations: [] });
      return;
    }
    json(ctx, 200, { chemin: p.chemin, ...this.bases.proprietesDe(p) }, { ETag: p.etag });
  }

}


/** Contenu de la copie d'une page : « (copie) » ajouté au titre écrit (`title:`, sinon `# …`), sinon inchangé. */
function titreDeCopie(chemin: string, contenu: string, suffixe: string): string {
  const { titre, source } = titreDe(chemin, contenu);
  if (source === "nom") return contenu;
  const d = decouper(contenu);
  if (source === "fm") return poserChamp(d.frontmatter, "title", titre + suffixe) + contenu.slice(d.frontmatter.length);
  return d.frontmatter + remplacerTexteH1(d.blocTitre, titre + suffixe) + d.corps;
}
