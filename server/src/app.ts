// Carnet · application : serveur HTTP, chaîne de contrôles (Host, identité, CSRF), aiguillage.
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { Api } from "./api.ts";
import type { Ctx } from "./api.ts";
import { Cle, lienSigne } from "./art.ts";
import type { Config } from "./config.ts";
import { Verrou } from "./disque.ts";
import { Espace } from "./espace.ts";
import { Git } from "./historique.ts";
import { envoyerJson, envoyerTexte, ErreurHttp, journal } from "./http.ts";
import { poserEntetesSecurite, trouverOrigine, verifierIdentite, verifierLectureApi, verifierMutation } from "./securite.ts";
import { Diffuseur } from "./sse.ts";
import { Statique } from "./statique.ts";

export interface Application {
  cfg: Config;
  espace: Espace;
  api: Api;
  diffuseur: Diffuseur;
  serveur: http.Server;
  demarrer(): Promise<number>;
  arreter(): Promise<void>;
}

const METHODES = new Set(["GET", "HEAD", "POST", "PUT"]);

function versErreurHttp(e: unknown): ErreurHttp {
  if (e instanceof ErreurHttp) return e;
  const code = (e as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") return new ErreurHttp(404, "Introuvable.", "introuvable");
  if (code === "EACCES" || code === "EPERM") return new ErreurHttp(403, "Accès refusé par le système de fichiers.", "permission");
  if (code === "ENOSPC" || code === "EDQUOT") return new ErreurHttp(507, "Disque plein.", "disque_plein");
  if (code === "EROFS") return new ErreurHttp(503, "Espace en lecture seule.", "lecture_seule");
  if (code === "ENAMETOOLONG") return new ErreurHttp(400, "Nom trop long.", "nom_trop_long");
  journal({ niveau: "erreur", erreur: String((e as Error)?.message ?? e), nom: String((e as Error)?.name ?? "") });
  return new ErreurHttp(500, "Erreur interne.", "interne");
}

export async function creerApplication(cfg: Config, opts: { surveiller?: boolean } = {}): Promise<Application> {
  const verrou = new Verrou();
  const espace = new Espace(cfg, verrou);
  const diffuseur = new Diffuseur(cfg.maxSse, cfg.pingMs);
  espace.surChangement = (ch, version) => {
    for (const [chemin, etag] of ch.modifs) diffuseur.envoyer({ type: "modif", chemin, etag });
    if (ch.arbre) diffuseur.envoyer({ type: "arbre", version });
  };
  const cle = cfg.fichierCle ? new Cle(cfg.fichierCle) : null;
  const git = await Git.creer(cfg);
  const api = new Api(cfg, espace, diffuseur, verrou, git);
  const statique = new Statique(cfg.statique);
  await verrou.executer(async () => espace.appliquer(await espace.balayerTout()));

  async function traiter(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const t0 = performance.now();
    const methode = req.method ?? "?";
    let route = "?";
    let login: string | null = null;
    let raison: string | undefined;
    let journaliser = true;
    let enJson = false;
    res.on("close", () => {
      if (!journaliser) return;
      journal({ m: methode, route, statut: res.statusCode, ms: Math.round(performance.now() - t0), login, ...(raison ? { raison } : {}) });
    });
    try {
      const brut = req.url ?? "/";
      if (!brut.startsWith("/")) throw new ErreurHttp(400, "Requête invalide.", "url");
      // Chemin BRUT (non normalisé : le parseur d'URL résoudrait « .. » et « %2e%2e ») pour l'aiguillage.
      const chemin = brut.split("?")[0].split("#")[0];
      const url = new URL(brut, "http://carnet.invalid");
      enJson = chemin.startsWith("/api/");
      if (chemin === "/sante") {
        journaliser = false;
        poserEntetesSecurite(res, null);
        if (methode !== "GET" && methode !== "HEAD") throw new ErreurHttp(405, "Méthode non autorisée.", "methode", undefined, { Allow: "GET, HEAD" });
        envoyerTexte(res, 200, "ok\n");
        return;
      }
      const xfp = req.headers["x-forwarded-proto"];
      const o = trouverOrigine(cfg, req.headers.host, typeof xfp === "string" ? xfp : undefined);
      if (!o) {
        poserEntetesSecurite(res, null);
        throw new ErreurHttp(421, "Hôte inconnu.", "hote_inconnu");
      }
      if (o.ambigu) raison = `hote_ambigu:${String(req.headers.host).slice(0, 100)}`;
      poserEntetesSecurite(res, o.corr.art);
      if (!METHODES.has(methode)) throw new ErreurHttp(405, "Méthode non autorisée.", "methode", undefined, { Allow: "GET, HEAD, POST, PUT" });
      const id = verifierIdentite(cfg, req);
      login = id.login;
      const lecture = methode === "GET" || methode === "HEAD";
      if (!lecture) verifierMutation(req, o.corr);
      if (enJson) {
        route = chemin.length <= 40 ? chemin : "/api/?";
        if (lecture) verifierLectureApi(req);
        if (url.pathname !== chemin) throw new ErreurHttp(404, "Route inconnue.", "route_inconnue");
        const ctx: Ctx = { req, res, url, corr: o.corr, login: id.login, nom: id.nom, route };
        await api.gerer(ctx);
        return;
      }
      if (chemin.startsWith("/_art/")) {
        route = "/_art";
        if (!lecture) throw new ErreurHttp(405, "Méthode non autorisée.", "methode", undefined, { Allow: "GET, HEAD" });
        verifierLectureApi(req);
        if (!cle) throw new ErreurHttp(503, "Signature des artefacts indisponible.", "sans_cle");
        const r = await lienSigne(cfg, cle, o.corr.art, chemin.slice("/_art/".length));
        res.statusCode = 302;
        res.setHeader("Location", r.location);
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("Content-Length", "0");
        res.end();
        return;
      }
      if (!lecture) throw new ErreurHttp(405, "Méthode non autorisée.", "methode", undefined, { Allow: "GET, HEAD" });
      route = await statique.servir(req, res, url.pathname);
    } catch (e) {
      const err = versErreurHttp(e);
      if (err.raison) raison = raison ? `${raison} ${err.raison}` : err.raison;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      for (const [k, v] of Object.entries(err.entetes ?? {})) res.setHeader(k, v);
      if (enJson) envoyerJson(req, res, err.statut, { erreur: err.message, ...(err.extra ?? {}) });
      else envoyerTexte(res, err.statut, err.message + "\n");
    }
  }

  const serveur = http.createServer(
    { requestTimeout: 60_000, headersTimeout: 15_000, keepAliveTimeout: 5_000, maxHeaderSize: 16 * 1024 },
    (req, res) => { void traiter(req, res); },
  );
  serveur.maxConnections = 256;

  return {
    cfg,
    espace,
    api,
    diffuseur,
    serveur,
    async demarrer(): Promise<number> {
      await new Promise<void>((ok, ko) => {
        serveur.once("error", ko);
        serveur.listen(cfg.port, cfg.hote, () => { serveur.off("error", ko); ok(); });
      });
      if (opts.surveiller !== false) espace.demarrerSurveillance();
      api.demarrerPurge();
      return (serveur.address() as AddressInfo).port;
    },
    async arreter(): Promise<void> {
      api.arreterPurge();
      espace.arreter();
      diffuseur.fermer();
      await new Promise<void>((ok) => {
        serveur.close(() => ok());
        serveur.closeAllConnections();
      });
    },
  };
}
