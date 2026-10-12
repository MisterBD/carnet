// Carnet · lot 3 « Agents » : routes des décisions, des nouveautés, des fichiers des agents et des clés d'accès.
// Branché dans Api par deux lignes (construction + routes). Toutes les écritures dans l'espace passent par la porte
// unique du socle (Ecrivain : révision, idempotence, intention durable, journal, attestation) ; l'état « vu », les
// clés d'accès et les attestations vivent hors de l'espace (CARNET_ETAT).
import { texteTechniques } from "../../shared/techniques.ts";
import type { Ctx } from "./api.ts";
import { Cles, rpIdDe } from "./cles.ts";
import type { Config } from "./config.ts";
import { estDecision } from "./decisions.ts";
import type { PreuveDecision } from "./decisions.ts";
import { Demandes } from "./demandes.ts";
import type { Ecrivain } from "./ecriture.ts";
import type { Changements, Espace } from "./espace.ts";
import { envoyerJson, ErreurHttp, lireJson } from "./http.ts";
import { Nouveautes } from "./nouveautes.ts";
import type { PorteProvenance } from "./nouveautes.ts";
import { cheminPage, zoneInterdite } from "./securite.ts";

type Gestionnaire = (ctx: Ctx) => Promise<void>;

function json(ctx: Ctx, statut: number, objet: unknown): void {
  envoyerJson(ctx.req, ctx.res, statut, objet);
}

function requeteDe(ctx: Ctx): string | undefined {
  const v = ctx.req.headers["x-carnet-requete"];
  return typeof v === "string" ? v.trim() : undefined;
}

const MOUVEMENTS = new Set(["renommer", "deplacer", "supprimer"]);

/** Provenance des versions d'après le journal d'attribution du socle (jamais une preuve d'humain). */
export function provenanceDuJournal(ecrivain: Ecrivain, espace: Espace): PorteProvenance {
  return {
    auteurCarnet: (chemin, etag) => {
      const d = ecrivain.journal.dernieres(chemin, 1)[0];
      return d && d.apres === etag ? d.principal : null;
    },
    mouvement: (chemin) => {
      const l = ecrivain.journal.dernieres(chemin, 50);
      for (let i = l.length - 1; i >= 0; i--) {
        const e = l[i];
        if (e.chemin === chemin && MOUVEMENTS.has(e.action) && (e.vers ?? null) !== chemin) {
          return { vers: e.action === "supprimer" ? null : e.vers ?? null, principal: e.principal, t: Date.parse(e.t) || 0 };
        }
      }
      return null;
    },
    apresEcritures: (f) => espace.verrou.executer(f),
  };
}

export class Agents {
  cfg: Config;
  espace: Espace;
  ecrivain: Ecrivain;
  cles: Cles;
  demandes: Demandes;
  nouveautes: Nouveautes;

  constructor(cfg: Config, espace: Espace, ecrivain: Ecrivain) {
    this.cfg = cfg;
    this.espace = espace;
    this.ecrivain = ecrivain;
    this.cles = new Cles(cfg);
    this.demandes = new Demandes(cfg, espace, ecrivain, this.cles);
    this.nouveautes = new Nouveautes(cfg, espace, provenanceDuJournal(ecrivain, espace));
    // Écritures de Carnet : la version écrite devient la référence « vue » de son auteur (s'il a un état).
    const precedent = espace.surChangement;
    espace.surChangement = (ch: Changements, version: number) => {
      precedent(ch, version);
      this.nouveautes.observer(ch);
    };
  }

  /**
   * `preuveDecision` de GET /api/page : celle du socle (attestations, même méthode d'empreinte), plus la date de
   * l'attestation qui fait foi et le contrôle du chaînage du journal (`journalCoupe` -> « indeterminee »).
   */
  async preuvePage(chemin: string, contenu: string): Promise<(PreuveDecision & { t: string | null; journalCoupe: boolean }) | null> {
    if (!estDecision(contenu)) return null;
    return (await this.demandes.analyser(chemin, contenu)).preuve;
  }

  routes(): Array<[string, Gestionnaire]> {
    return [
      ["GET /api/decisions", async (c) => {
        const statut = c.url.searchParams.get("statut");
        json(c, 200, { decisions: await this.demandes.lister(statut && statut.trim() ? statut.trim().normalize("NFC") : null) });
      }],
      ["POST /api/decisions", async (c) => {
        json(c, 201, await this.demandes.creer(await lireJson(c.req, 64 * 1024), c.login, requeteDe(c)));
      }],
      ["GET /api/decision", async (c) => {
        const v = await this.demandes.lire(cheminPage(this.cfg, c.url.searchParams.get("chemin")));
        const cles = await this.cles.lister();
        const ici = rpIdDe(c.corr.appli);
        json(c, 200, { ...v, cles: { nombre: cles.length, pourCetteAdresse: cles.filter((k) => k.rpId === ici).length } });
      }],
      ["POST /api/decision/defi", async (c) => {
        json(c, 200, await this.demandes.defi(await lireJson(c.req, 64 * 1024), c.corr.appli, c.login));
      }],
      ["POST /api/decision", async (c) => {
        json(c, 200, await this.demandes.geste(await lireJson(c.req, 256 * 1024), { principal: c.login, nom: c.nom, origine: c.corr.appli, requete: requeteDe(c) }));
      }],
      // Remplace la route du socle par une version plus complète (même forme : chemin, attestations[].valide ; en plus :
      // chaîne de la demande même après renommage, statut de chaque attestation, preuve calculée, rappel).
      ["GET /api/attestations", async (c) => {
        const segs = cheminPage(this.cfg, c.url.searchParams.get("chemin"));
        const chemin = segs.join("/");
        let v: Awaited<ReturnType<Demandes["lire"]>> | null = null;
        try { v = await this.demandes.lire(segs); } catch (e) { if (!(e instanceof ErreurHttp && e.statut === 404)) throw e; }
        const demande = c.url.searchParams.get("demande") ?? v?.id ?? null;
        const parChemin = await this.ecrivain.attestations.lister({ chemin });
        const parDemande = demande ? await this.ecrivain.attestations.lister({ demande }) : [];
        const vus = new Set<string>();
        const toutes = [...parDemande, ...parChemin]
          .filter((x) => !demande || x.attestation.demande === demande)
          // jamais le chemin d'une page devenue masquée (zone interdite) par le détour d'un identifiant de demande
          .filter((x) => typeof x.attestation.chemin === "string" && x.attestation.chemin !== "" && zoneInterdite(this.cfg, x.attestation.chemin.split("/")) === null)
          .filter((x) => !vus.has(x.attestation.id) && vus.add(x.attestation.id) !== undefined)
          .sort((a, b) => (Date.parse(a.attestation.t) || 0) - (Date.parse(b.attestation.t) || 0));
        const chaine = toutes.filter((x) => x.valide).map((x) => x.attestation);
        const derniere = chaine[chaine.length - 1];
        const journal = await this.demandes.journal();
        json(c, 200, {
          chemin, demande, empreinte_actuelle: v?.empreinte ?? null, methode: v?.methode ?? null, preuveDecision: v?.estDecision ? v.preuve : null,
          attestations: toutes.map((x) => ({
            ...x.attestation, valide: x.valide,
            statut: !x.valide ? "invalide" : x.attestation !== derniere ? "remplacee" : v && x.attestation.empreinte === v.empreinte ? "active" : "perimee",
          })),
          journal: {
            attestations: journal.valides.length, coupures: journal.coupures.length,
            note: "Chaînage : une ligne supprimée au milieu du journal est détectée (preuve « indeterminee ») ; une troncature de la fin ne l'est pas.",
          },
          rappel: "Une attestation de décision n'est PAS une autorisation d'exécution : l'outil qui agit vérifie lui-même la preuve au moment d'agir.",
        });
      }],
      ["GET /api/nouveautes", async (c) => {
        const compte = c.url.searchParams.get("compte") === "1";
        const r = await this.nouveautes.lister(c.login, { techniques: c.url.searchParams.get("techniques") === "1", compte });
        json(c, 200, compte ? { depart: r.depart, nombre: r.pages.length, pages: [], techniques_masquees: r.techniques_masquees } : r);
      }],
      ["GET /api/nouveaute", async (c) => {
        const segs = cheminPage(this.cfg, c.url.searchParams.get("chemin"));
        json(c, 200, await this.nouveautes.detail(c.login, segs.join("/")));
      }],
      ["POST /api/nouveautes/vu", async (c) => {
        json(c, 200, await this.nouveautes.marquer(c.login, await lireJson(c.req, 6 * 1024 * 1024)));
      }],
      ["GET /api/techniques", async (c) => {
        json(c, 200, { regles: texteTechniques(this.cfg.techniques) });
      }],
      ["GET /api/cles", async (c) => {
        const cles = await this.cles.lister();
        const rpId = rpIdDe(c.corr.appli);
        json(c, 200, {
          rpId,
          cles: cles.map((k) => ({ id: k.id.slice(0, 12), nom: k.nom, rpId: k.rpId, cree: k.cree, utilisee: k.utilisee, ici: k.rpId === rpId })),
          enrolement: await this.cles.enrolementEnAttente(),
        });
      }],
      ["POST /api/cles/defi", async (c) => {
        const corps = await lireJson(c.req, 16 * 1024);
        json(c, 200, await this.cles.defiEnregistrement(corps.code, c.corr.appli, c.login, c.nom));
      }],
      ["POST /api/cles", async (c) => {
        const k = await this.cles.enregistrer(await lireJson(c.req, 512 * 1024), c.corr.appli, c.login);
        json(c, 201, { id: k.id.slice(0, 12), nom: k.nom, rpId: k.rpId, cree: k.cree });
      }],
    ];
  }
}
