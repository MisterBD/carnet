// Carnet · routes de l'API JSON (/api/*).
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import { nomSuitLeTitre, titreDe } from "../../shared/navigation.ts";
import { decouper, dossierDe, feuille, nomDeFichier, plier, poserChamp, remplacerTexteH1 } from "../../shared/page.ts";
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
import { collateur, lireFrontmatter, texte } from "./espace.ts";
import type { Changements, Espace, Page } from "./espace.ts";
import { chaine, envoyerJson, ErreurHttp, journal, lireCorps, lireJson, normEtag } from "./http.ts";
import { Instantanes, RE_HASH, RE_INSTANTANE } from "./historique.ts";
import type { Git } from "./historique.ts";
import { retroliens, texteApercu } from "./liens.ts";
import { deplacement, marquerCode, reecrireLiens, RE_TACHE } from "./markdown.ts";
import {
  cheminAutorise, cheminPage, CSP_FICHIER, EXT_IMAGES, EXT_TELECHARGEMENT, exigerZoneAutorisee, extension, MIME_IMAGE, reelAutorise, typeImage,
  zoneInterdite,
} from "./securite.ts";
import type { Diffuseur } from "./sse.ts";

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

/** Segments du dossier « X/ » associé à la page « X.md ». */
function dossierDePage(segs: string[]): string[] {
  return [...segs.slice(0, -1), segs[segs.length - 1].slice(0, -3)];
}

const RE_CLE_META = /^[A-Za-z_][\w-]{0,63}$/;

export class Api {
  cfg: Config;
  espace: Espace;
  diffuseur: Diffuseur;
  verrou: Verrou;
  git: Git;
  instantanes: Instantanes;
  routes: Map<string, Gestionnaire>;
  #minuteurPurge: ReturnType<typeof setInterval> | null = null;
  /** Renommages réussis récents : une requête rejouée (Entrée puis perte de focus) reçoit la même réponse. */
  #renommages: { t: number; source: string; nom?: string; titre?: string; cible: string }[] = [];

  constructor(cfg: Config, espace: Espace, diffuseur: Diffuseur, verrou: Verrou, git: Git) {
    this.cfg = cfg;
    this.espace = espace;
    this.diffuseur = diffuseur;
    this.verrou = verrou;
    this.git = git;
    this.instantanes = new Instantanes(cfg);
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
    ]);
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
      json(ctx, 200, { chemin: segs.join("/"), contenu, etag, mtime: Math.floor(st.mtimeMs) }, { ETag: etag });
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
    const ifMatch = ctx.req.headers["if-match"];
    const ifNone = ctx.req.headers["if-none-match"];
    await this.verrou.executer(async () => {
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      let stNouveau: fs.Stats;
      if (st) {
        if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas un fichier.", "pas_un_fichier");
        const a = await this.#actuel(abs);
        if (!a) throw new ErreurHttp(409, "Page illisible.", "illisible");
        if (ifNone !== undefined && ifNone.trim() === "*") throw new ErreurHttp(412, "La page existe déjà.", "existe", { etag: a.etag, contenu: a.contenu });
        if (ifMatch === undefined) throw new ErreurHttp(412, "En-tête If-Match obligatoire pour modifier une page existante.", "if_match_absent", { etag: a.etag, contenu: a.contenu });
        if (ifMatch.trim() !== "*" && !ifMatch.split(",").some((v) => normEtag(v) === a.etag)) {
          throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", { etag: a.etag, contenu: a.contenu });
        }
        if (a.contenu === contenu) {
          json(ctx, 200, { etag: a.etag, mtime: Math.floor(st.mtimeMs) }, { ETag: a.etag });
          return;
        }
        stNouveau = await ecrireAtomique(abs, contenu);
      } else {
        if (ifMatch !== undefined) throw new ErreurHttp(412, "La page n'existe plus.", "page_absente", { etag: null, contenu: null });
        if (ifNone === undefined || ifNone.trim() !== "*") throw new ErreurHttp(428, "En-tête If-None-Match: * obligatoire pour créer une page.", "if_none_match_absent");
        await creerDossiers(this.cfg, path.dirname(abs));
        try {
          stNouveau = await ecrireAtomique(abs, contenu, { exclusif: true });
        } catch (e) {
          if (e instanceof ErreurHttp && e.raison === "existe") {
            const a = await this.#actuel(abs);
            throw new ErreurHttp(412, "La page existe déjà.", "existe", { etag: a?.etag ?? null, contenu: a?.contenu ?? null });
          }
          throw e;
        }
      }
      const etag = etagDe(contenu);
      this.#publier(await this.espace.majPage(segs, contenu, stNouveau));
      json(ctx, 200, { etag, mtime: Math.floor(stNouveau.mtimeMs) }, { ETag: etag });
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
      for (let k = 1; k <= 1000; k++) {
        const nom = k === 1 ? base : `${base} ${k}`;
        const segs = [...dossier, nom + ".md"];
        exigerZoneAutorisee(this.cfg, segs);
        // « artefacts » ou un dossier masqué à la racine : le dossier homonyme serait une zone interdite -> suffixe
        if (zoneInterdite(this.cfg, [...dossier, nom])) continue;
        const md = await verifierEcriture(this.cfg, segs);
        const dir = await verifierEcriture(this.cfg, [...dossier, nom]);
        if (md.st || dir.st) continue;
        await creerDossiers(this.cfg, path.dirname(md.abs));
        let st: fs.Stats;
        try {
          st = await ecrireAtomique(md.abs, contenu, { exclusif: true });
        } catch (e) {
          if (e instanceof ErreurHttp && e.raison === "existe") continue;
          throw e;
        }
        const etag = etagDe(contenu);
        this.#publier(await this.espace.majPage(segs, contenu, st));
        json(ctx, 201, { chemin: segs.join("/"), etag }, { ETag: etag });
        return;
      }
      throw new ErreurHttp(409, "Trop de pages portent déjà ce nom.", "conflit_nom");
    });
  }

  // -------------------------------------------------------------------------------------------
  // Renommer / déplacer / supprimer
  // -------------------------------------------------------------------------------------------

  async renommer(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const source = cheminPage(this.cfg, corps.chemin);
    if (corps.titre !== undefined) {
      json(ctx, 200, await this.#renommerTitre(source, chaine(corps.titre, "titre", 500)));
      return;
    }
    const nom = nomDeFichier(chaine(corps.nom, "nom", 500));
    const r = await this.verrou.executer(async () => {
      const rejeu = await this.#rejeu(source, { nom });
      if (rejeu) return rejeu;
      const x = await this.#deplacer(source, source.slice(0, -1), nom);
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
  async #renommerTitre(source: string[], brut: string): Promise<{ chemin: string; liensMisAJour: number; etag: string | null; renomme: boolean }> {
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
          if (Buffer.byteLength(nouveau) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
          const st2 = await ecrireAtomique(md.abs, nouveau);
          contenu = nouveau;
          etag = etagDe(nouveau);
          this.#publier(await this.espace.majPage(source, nouveau, st2));
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
      const r = await this.#deplacer(source, source.slice(0, -1), nom);
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
      return this.#deplacer(source, dest, feuille(source.join("/")));
    });
    json(ctx, 200, r);
  }

  /** Déplace / renomme X.md et X/ vers <destDossier>/<nom>.md et <destDossier>/<nom>/, puis met à jour les liens. */
  async #deplacer(source: string[], destDossier: string[], nom: string): Promise<{ chemin: string; liensMisAJour: number }> {
    const ancienNom = source.join("/").slice(0, -3);
    const cible = [...destDossier, nom + ".md"];
    const cibleDir = [...destDossier, nom];
    exigerZoneAutorisee(this.cfg, cible);
    exigerZoneAutorisee(this.cfg, cibleDir);
    const nouveauNom = cibleDir.join("/");
    if (nouveauNom === ancienNom) return { chemin: source.join("/"), liensMisAJour: 0 };
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
        await ecrireAtomique(v.abs, r.contenu);
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
      const md = await verifierEcriture(this.cfg, segs);
      const dir = await verifierEcriture(this.cfg, dossierDePage(segs));
      const aMd = !!(md.st && md.st.isFile());
      const aDir = !!(dir.st && dir.st.isDirectory());
      if (!aMd && !aDir) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
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
    });
    json(ctx, 200, r);
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
        return { chemin: cible.join("/"), renomme: k > 0 };
      }
      throw new ErreurHttp(409, "Impossible de trouver un nom libre pour restaurer.", "conflit_nom");
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
        const x = await this.#deplacer(source, destDossier, nomSource);
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
        let mdCree = false;
        let dirCree = false;
        try {
          if (aMd) {
            await ecrireAtomique(dMd.abs, titreDeCopie(chemin, contenu, suffixe), { exclusif: true, mode: md.st!.mode & 0o777 });
            mdCree = true;
          }
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
        } catch (e) {
          if (mdCree) await fsp.unlink(dMd.abs).catch(() => {});
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

  async historique(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.cfg, ctx.url.searchParams.get("chemin"));
    const chemin = segs.join("/");
    const commits = await this.git.historique(chemin, true);
    const instantanes = await this.instantanes.lister(segs);
    const versions: Array<Record<string, unknown> & { date: number }> = [
      ...commits.map((c) => ({ id: `git:${c.hash}`, date: c.date, source: "git", auteur: c.auteur, message: c.message })),
      ...instantanes.map((i) => ({ id: i.id, date: i.date, source: "instantane", auto: i.auto })),
    ];
    versions.sort((a, b) => b.date - a.date);
    json(ctx, 200, { git: this.git.actif, versions });
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
        const st2 = await ecrireAtomique(abs, v.contenu);
        this.#publier(await this.espace.majPage(segs, v.contenu, st2));
        return { etag: etagDe(v.contenu), instantane: inst.id };
      }
      await creerDossiers(this.cfg, path.dirname(abs));
      const st2 = await ecrireAtomique(abs, v.contenu, { exclusif: true });
      this.#publier(await this.espace.majPage(segs, v.contenu, st2));
      return { etag: etagDe(v.contenu), instantane: null };
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
    json(ctx, 200, { resultats: this.espace.rechercher(q, limite) });
  }

  async accueil(ctx: Ctx): Promise<void> {
    const pages = this.espace.pagesVisibles().sort((a, b) => b.mtime - a.mtime);
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
      liste = this.espace.pagesVisibles().filter((p) => dossierDe(p.chemin) === d);
    } else {
      liste = this.espace.pagesVisibles().filter((p) => p.tags.some((t) => plier(t) === "projet"));
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

  async tache(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const ligne = corps.ligne;
    if (typeof ligne !== "number" || !Number.isInteger(ligne) || ligne < 0) throw new ErreurHttp(400, "Champ « ligne » invalide.", "champ_invalide");
    const texteAttendu = chaine(corps.texte, "texte", 100_000);
    if (typeof corps.coche !== "boolean") throw new ErreurHttp(400, "Champ « coche » invalide.", "champ_invalide");
    const coche = corps.coche;
    await this.verrou.executer(async () => {
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      if (!st || !st.isFile()) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      const { contenu } = await lireConfine(this.cfg, abs, MAX_LECTURE);
      const lignes = contenu.split("\n");
      const conflit = () => new ErreurHttp(409, "La tâche a changé entre-temps : recharge la page.", "tache_changee");
      if (ligne >= lignes.length) throw conflit();
      const brute = lignes[ligne];
      const cr = brute.endsWith("\r");
      const l = cr ? brute.slice(0, -1) : brute;
      if (l !== texteAttendu || marquerCode(lignes)[ligne]) throw conflit();
      const m = RE_TACHE.exec(l);
      if (!m) throw conflit();
      const nouvelle = m[1] + (coche ? "[x]" : "[ ]") + l.slice(m[1].length + 3);
      if (nouvelle === l) {
        json(ctx, 200, { etag: etagDe(contenu), texte: l });
        return;
      }
      lignes[ligne] = nouvelle + (cr ? "\r" : "");
      const nouveau = lignes.join("\n");
      const st2 = await ecrireAtomique(abs, nouveau);
      this.#publier(await this.espace.majPage(segs, nouveau, st2));
      json(ctx, 200, { etag: etagDe(nouveau), texte: nouvelle });
    });
  }

  async meta(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req);
    const segs = cheminPage(this.cfg, corps.chemin);
    const champs = corps.champs;
    if (!champs || typeof champs !== "object" || Array.isArray(champs)) throw new ErreurHttp(400, "Champ « champs » invalide.", "champ_invalide");
    const entrees = Object.entries(champs as Record<string, unknown>);
    if (!entrees.length || entrees.length > 50) throw new ErreurHttp(400, "Entre 1 et 50 champs.", "champ_invalide");
    const valeurs: [string, string | null][] = entrees.map(([k, v]) => {
      if (!RE_CLE_META.test(k)) throw new ErreurHttp(400, `Clé invalide : ${k.slice(0, 64)}`, "cle_invalide");
      if (v === null) return [k, null];
      if (typeof v === "number" || typeof v === "boolean") return [k, String(v)];
      if (typeof v !== "string" || v.length > 10_000) throw new ErreurHttp(400, `Valeur invalide pour ${k}.`, "valeur_invalide");
      return [k, v];
    });
    const ifMatch = ctx.req.headers["if-match"];
    await this.verrou.executer(async () => {
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      if (!st || !st.isFile()) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
      const { contenu } = await lireConfine(this.cfg, abs, MAX_LECTURE);
      const etagActuel = etagDe(contenu);
      if (ifMatch !== undefined && ifMatch.trim() !== "*" && !ifMatch.split(",").some((v) => normEtag(v) === etagActuel)) {
        throw new ErreurHttp(412, "La page a été modifiée ailleurs.", "etag_discordant", { etag: etagActuel, contenu });
      }
      const d = decouper(contenu);
      let fm = d.frontmatter;
      for (const [k, v] of valeurs) fm = poserChamp(fm, k, v);
      const nouveau = fm + contenu.slice(d.frontmatter.length);
      if (nouveau === contenu) {
        json(ctx, 200, { etag: etagActuel });
        return;
      }
      const yamlAvant = d.yaml.trim() === "" || lireFrontmatter(d.yaml) !== null;
      const yamlApres = decouper(nouveau).yaml;
      if (yamlAvant && yamlApres.trim() !== "" && lireFrontmatter(yamlApres) === null) {
        throw new ErreurHttp(422, "Modification refusée : elle rendrait l'en-tête YAML invalide.", "yaml_invalide");
      }
      const st2 = await ecrireAtomique(abs, nouveau);
      this.#publier(await this.espace.majPage(segs, nouveau, st2));
      json(ctx, 200, { etag: etagDe(nouveau) });
    });
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
}


/** Contenu de la copie d'une page : « (copie) » ajouté au titre écrit (`title:`, sinon `# …`), sinon inchangé. */
function titreDeCopie(chemin: string, contenu: string, suffixe: string): string {
  const { titre, source } = titreDe(chemin, contenu);
  if (source === "nom") return contenu;
  const d = decouper(contenu);
  if (source === "fm") return poserChamp(d.frontmatter, "title", titre + suffixe) + contenu.slice(d.frontmatter.length);
  return d.frontmatter + remplacerTexteH1(d.blocTitre, titre + suffixe) + d.corps;
}
