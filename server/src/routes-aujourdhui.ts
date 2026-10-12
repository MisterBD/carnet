// Carnet V3 · lot 1 « Aujourd'hui » : routes de l'écran Aujourd'hui, de la boîte de réception et des captures.
// Branchées par une seule ligne dans api.ts (`...routesAujourdhui(this)`).
//   GET  /api/aujourdhui      tâches ouvertes classées (fuseau du carnet), à relire (avec critère), récents, nombre de captures
//   GET  /api/boite           captures du dossier CARNET_INBOX (enfants directs), les plus récentes d'abord
//   POST /api/capture         {texte, lien?, titre?} + X-Carnet-Requete : une page par capture dans CARNET_INBOX
// Les lectures n'écrivent rien. La capture passe par la porte d'écriture du socle (Ecrivain.creerUnique : nom unique,
// création exclusive, idempotence durable : une réponse perdue puis un renvoi ne crée jamais de seconde capture).
// Clôture, échéance et priorité d'une tâche : route POST /api/tache du socle (rien ici).
import { estTechnique } from "../../shared/techniques.ts";
import { dateDuJour, horodatageIso, nouvelIdentifiant } from "../../shared/identifiants.ts";
import { dossierDe, plier } from "../../shared/page.ts";
import type { Api, Ctx } from "./api.ts";
import {
  baseNomCapture, champTexte, classer, contenuCapture, lienValide, MAX_LIEN_CAPTURE, MAX_TEXTE_CAPTURE, tacheDeFiche, tachesOuvertes, titreUneLigne,
  type TacheJour,
} from "./aujourdhui.ts";
import { MAX_PAGE } from "./ecriture.ts";
import { chaine, envoyerJson, ErreurHttp, lireJson, normEtag } from "./http.ts";
import { cheminPage } from "./securite.ts";
import { typeSocle } from "./bases.ts";
import { poserPropriete } from "../../shared/proprietes.ts";
import { sha256 } from "./journal-ecritures.ts";
import type { Page } from "./espace.ts";

type Gestionnaire = (ctx: Ctx) => Promise<void>;

const MAX_TACHES_SECTION = 300;

/** Relevé des tâches par page, recalculé seulement quand la page change (etag). */
const cacheTaches = new WeakMap<Api, Map<string, { etag: string; taches: TacheJour[] }>>();

function tachesDe(api: Api, p: Page): TacheJour[] {
  let cache = cacheTaches.get(api);
  if (!cache) { cache = new Map(); cacheTaches.set(api, cache); }
  const c = cache.get(p.chemin);
  if (c && c.etag === p.etag) {
    // titre et icône peuvent changer sans que les tâches changent : on les reprend de l'index
    return c.taches.map((t) => (t.titre === p.titre && t.icone === p.icone ? t : { ...t, titre: p.titre, icone: p.icone }));
  }
  const taches = tachesOuvertes(p);
  cache.set(p.chemin, { etag: p.etag, taches });
  return taches;
}

export function dossierInbox(api: Api): string {
  return api.cfg.inbox.join("/");
}

/** Pages de la boîte de réception : enfants directs du dossier (casse respectée). */
export function pagesBoite(api: Api): Page[] {
  const d = dossierInbox(api);
  return api.espace.pagesCourantes().filter((p) => dossierDe(p.chemin) === d); // lot 6 : capture archivée = triée
}

/** Identifiant d'idempotence (en-tête X-Carnet-Requete, UUID par geste) ; validé par l'Ecrivain. */
function requeteDe(ctx: Ctx): string | undefined {
  const v = ctx.req.headers["x-carnet-requete"];
  return typeof v === "string" ? v.trim() : undefined;
}

/** Champ texte facultatif (absent ou null = ""). */
function texteFacultatif(v: unknown, nom: string, max: number): string {
  return v === undefined || v === null ? "" : chaine(v, nom, max);
}

async function capturer(api: Api, ctx: Ctx): Promise<void> {
  const corps = await lireJson(ctx.req, MAX_TEXTE_CAPTURE * 4 + 64 * 1024);
  const texte = texteFacultatif(corps.texte, "texte", MAX_TEXTE_CAPTURE);
  const lienBrut = texteFacultatif(corps.lien, "lien", MAX_LIEN_CAPTURE + 64);
  const titre = titreUneLigne(texteFacultatif(corps.titre, "titre", 2000));
  const source = lienBrut.trim() ? lienValide(lienBrut) : null;
  if (lienBrut.trim() && !source) throw new ErreurHttp(400, "Lien refusé : une adresse web http(s), sans espace, est attendue.", "lien_invalide");
  if (!texte.trim() && !source) throw new ErreurHttp(400, "Capture vide : écris un texte ou colle un lien.", "capture_vide");
  const maintenant = new Date();
  const id = nouvelIdentifiant("cap", api.cfg.fuseau, maintenant);
  const contenu = contenuCapture({ id, cree: horodatageIso(maintenant, api.cfg.fuseau), texte, source, titre });
  if (Buffer.byteLength(contenu) > MAX_PAGE) throw new ErreurHttp(413, "Capture trop volumineuse (maximum 2 Mo).", "trop_gros");
  const r = await api.ecrivain.creerUnique({
    dossier: api.cfg.inbox,
    base: baseNomCapture({ titre, texte, source }),
    action: "capture",
    // création seulement : jamais d'écrasement (le socle essaie « base (2) », « base (3) »… si le nom est pris)
    transformer: (avant) => {
      if (avant !== null) throw new ErreurHttp(412, "La page existe déjà.", "existe");
      return contenu;
    },
    requete: requeteDe(ctx),
    // empreinte de l'opération (sans l'identifiant ni l'heure, tirés à chaque appel) : un renvoi du même geste est reconnu
    operation: { texte: sha256(texte), lien: source, titre },
  }, ctx.login);
  const page = api.espace.pages.get(r.chemin);
  const idFichier = r.rejoue ? champTexte(page?.fm?.id) : id;
  envoyerJson(ctx.req, ctx.res, r.rejoue ? 200 : 201, { chemin: r.chemin, id: idFichier, etag: r.etag, ...(r.rejoue ? { rejoue: true } : {}) });
}

/**
 * Échéances (11/10/2026) · POST /api/aujourdhui/fiche { chemin, fait: true } ou { chemin, fait: false, avant | absente }
 * + If-Match (révision lue) + X-Carnet-Requete. Cocher pose la valeur « fait » DÉCLARÉE par la base (`carnet.aujourdhui`)
 * dans le frontmatter de la fiche, par l'Ecrivain (une seule propriété, le reste à l'octet) ; « Annuler » remet la
 * valeur d'avant (ou retire la clé si elle était absente). Sans déclaration : 422, rien n'est écrit. Fichier changé
 * depuis la lecture : 412 + version actuelle (rien n'est écrasé).
 */
async function cocherFiche(api: Api, ctx: Ctx): Promise<void> {
  const corps = await lireJson(ctx.req, 16 * 1024);
  const segs = cheminPage(api.cfg, corps.chemin);
  const chemin = segs.join("/");
  if (typeof corps.fait !== "boolean") throw new ErreurHttp(400, "Champ « fait » (true ou false) attendu.", "champ_invalide");
  const ifMatch = ctx.req.headers["if-match"];
  if (ifMatch === undefined || ifMatch.trim() === "" || ifMatch.trim() === "*") {
    throw new ErreurHttp(428, "En-tête If-Match obligatoire : la révision lue de la fiche.", "if_match_absent");
  }
  const t = api.bases.declarationDeFiche(chemin);
  if (!t) {
    throw new ErreurHttp(422, "Cette page n'est pas une fiche d'une base affichée dans Aujourd'hui : rien n'est écrit.", "sans_declaration", { raison: "sans_declaration" });
  }
  const cle = t.decl.fait.propriete;
  let valeur: string | boolean | null | undefined;
  if (corps.fait) valeur = t.decl.fait.valeur;
  else if (corps.absente === true) valeur = undefined; // la clé n'existait pas : on la retire
  else if (corps.avant === null || typeof corps.avant === "boolean") valeur = corps.avant;
  else valeur = chaine(corps.avant, "avant", 500);
  const decl = t.def.declarations.get(cle) ?? null;
  const r = await api.ecrivain.ecrire({
    chemin: segs, revision: normEtag(ifMatch.split(",")[0]), action: "propriete", requete: requeteDe(ctx),
    operation: { fiche: true, cle, valeur: valeur === undefined ? null : valeur, retirer: valeur === undefined },
    transformer: (avant) => poserPropriete(avant ?? "", cle, valeur, { type: typeof valeur === "boolean" ? "case" : typeSocle(decl) }),
  }, ctx.login);
  envoyerJson(ctx.req, ctx.res, 200, {
    etag: r.etag, cle, valeur: valeur === undefined ? null : valeur, ...(r.inchange ? { inchange: true } : {}), ...(r.rejoue ? { rejoue: true } : {}),
  }, { ETag: r.etag });
}

export function routesAujourdhui(api: Api): [string, Gestionnaire][] {
  return [
    ["POST /api/capture", (ctx) => capturer(api, ctx)],
    ["POST /api/aujourdhui/fiche", (ctx) => cocherFiche(api, ctx)],
    ["GET /api/aujourdhui", async (ctx) => {
      // Intégration lot 3 : les fichiers des agents (AGENTS.md, log.md, raw/…) restent hors des parcours quotidiens,
      // comme l'ancien accueil ; ils restent ouvrables et trouvables par une recherche explicite.
      // Lot 6 : ni pages archivées ni modèles (un modèle porte des tâches à {{date}}, une page archivée est rangée).
      const pages = api.espace.pagesCourantes().filter((p) => !estTechnique(api.cfg.techniques, p.chemin));
      const mtimes = new Map(pages.map((p) => [p.chemin, p.mtime] as const));
      const toutes: TacheJour[] = [];
      for (const p of pages) toutes.push(...tachesDe(api, p));
      // Échéances (11/10/2026) : fiches non faites et datées des bases qui le déclarent (carnet.aujourdhui),
      // classées avec les tâches (une fiche = une ligne, jamais deux fois)
      const techniques = (c: string) => estTechnique(api.cfg.techniques, c);
      for (const f of api.bases.fichesDatees()) if (!techniques(f.chemin)) toutes.push(tacheDeFiche(f));
      const jour = dateDuJour(api.cfg.fuseau);
      const c = classer(toutes, jour, mtimes);
      const borne = (l: TacheJour[]) => l.slice(0, MAX_TACHES_SECTION);
      const parDate = [...pages].sort((a, b) => b.mtime - a.mtime);
      const resume = (p: Page) => ({ chemin: p.chemin, titre: p.titre, icone: p.icone, mtime: p.mtime, resume: api.espace.resume(p) });
      const aRelire: unknown[] = [];
      for (const p of parDate) {
        const raisons: string[] = [];
        if (p.statut !== null && plier(p.statut).trim() === "a relire") raisons.push("statut");
        if (p.mention) raisons.push("mention");
        if (raisons.length) aRelire.push({ ...resume(p), raisons });
        if (aRelire.length >= 100) break;
      }
      envoyerJson(ctx.req, ctx.res, 200, {
        date: jour, fuseau: api.cfg.fuseau,
        enRetard: borne(c.enRetard), aujourdhui: borne(c.aujourdhui), semaine: borne(c.semaine), plusTard: borne(c.plusTard), sansDate: borne(c.sansDate),
        aRelire: { critere: { statut: "à relire", mentions: api.cfg.mentions }, pages: aRelire },
        recents: parDate.slice(0, 12).map(resume),
        boite: pagesBoite(api).length,
        // lot 12 : vues « À relancer » des bases de l'espace (absent si aucune)
        ...(() => { const v = api.bases.vuesARelancer(); return v.length ? { aRelancer: v } : {}; })(),
        // API des autres lots présentes (l'écran ne les interroge que si elles existent : pas de 404 dans la console)
        modules: { decisions: api.routes.has("GET /api/decisions"), nouveautes: api.routes.has("GET /api/nouveautes") },
      });
    }],
    ["GET /api/boite", async (ctx) => {
      const captures = pagesBoite(api).map((p) => {
        const fm = p.fm ?? {};
        const cree = champTexte(fm.cree);
        const source = champTexte(fm.source);
        const id = champTexte(fm.id);
        return {
          chemin: p.chemin, titre: p.titre, id, cree,
          // contenu non fiable : seul un lien http(s) est renvoyé (jamais « javascript: » ni autre schéma)
          source: source ? lienValide(source) : null,
          extrait: api.espace.resume(p), mtime: p.mtime,
        };
      });
      const t = (c: { cree: string | null; mtime: number }) => {
        const d = c.cree ? Date.parse(c.cree) : NaN;
        return Number.isFinite(d) ? d : c.mtime;
      };
      captures.sort((a, b) => t(b) - t(a) || b.chemin.localeCompare(a.chemin));
      envoyerJson(ctx.req, ctx.res, 200, { dossier: dossierInbox(api), captures });
    }],
  ];
}
