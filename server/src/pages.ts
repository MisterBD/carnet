// Carnet V3 · lot 6 « Pages » : modèles (dossier « Modèles/ ») et journal du jour (« Journal/AAAA-MM-JJ.md »).
// Verrou et archive sont des PROPRIÉTÉS (`verrou: true`, `archive: true`) posées par POST /api/propriete ; leurs effets
// vivent dans server/src/ecriture.ts (423 sur les écritures de contenu d'une page verrouillée) et server/src/espace.ts
// (`estArchivee`, `pagesCourantes`, recherche `archives=1`).
//
//   GET  /api/modeles          → {dossier, modeles: [{chemin, titre, icone}]}
//   POST /api/page/modele      {modele, titre, parent?} + X-Carnet-Requete → 201 {chemin, etag} (200 + rejoue)
//   POST /api/journal          {} + X-Carnet-Requete → 201 {chemin, date, cree: true, etag} | 200 {…, cree: false}
import "./analyseur-yaml.ts";
import { horodatageIso, nouvelIdentifiant, RE_IDENTIFIANT } from "../../shared/identifiants.ts";
import { appliquerModele, heureDe } from "../../shared/modeles.ts";
import { ErreurFormat, lireProprietes, poserPropriete } from "../../shared/proprietes.ts";
import type { Api, Ctx } from "./api.ts";
import { lireConfine, lstatOuNull, resoudre } from "./disque.ts";
import { collateur, DOSSIER_MODELES, estArchivee, estModele } from "./espace.ts";
import { chaine, envoyerJson, ErreurHttp, lireJson } from "./http.ts";
import { sha256 } from "./journal-ecritures.ts";
import { cheminPage } from "./securite.ts";

type Gestionnaire = (ctx: Ctx) => Promise<void>;

const MAX_MODELE = 2 * 1024 * 1024;
/** Dossier des journaux du jour, à la racine de l'espace. */
export const DOSSIER_JOURNAL = "Journal";
/** Modèle du journal du jour (facultatif). */
export const MODELE_JOURNAL = `${DOSSIER_MODELES}/Journal.md`;

function requeteDe(ctx: Ctx): string | undefined {
  const v = ctx.req.headers["x-carnet-requete"];
  return typeof v === "string" ? v.trim() : undefined;
}

/** Contenu d'un modèle, ou null s'il n'existe pas. */
async function lireModele(api: Api, segs: string[]): Promise<string | null> {
  try {
    return (await lireConfine(api.cfg, await resoudre(api.cfg, segs), MAX_MODELE)).contenu;
  } catch (e) {
    if (e instanceof ErreurHttp && e.statut === 404) return null;
    throw e;
  }
}

/** Applique un modèle ; une erreur de format devient un 422 explicite (rien n'est créé). */
function appliquer(source: string, vars: { date: string; heure: string; titre: string }): string {
  try {
    return appliquerModele(source, vars);
  } catch (e) {
    if (e instanceof ErreurFormat) throw new ErreurHttp(422, `Modèle inutilisable : ${e.message}`, "modele_invalide", { raison: "modele_invalide" });
    throw e;
  }
}

/**
 * Une demande de décision (lot 3) a besoin d'un identifiant unique : un modèle `type: decision` reçoit un `id` neuf
 * (format `dec-AAAAMMJJ-HHMM-xxxx`), et `cree` / `demandee_par` s'ils sont vides, comme le fait « /decision ».
 * Aucune autre propriété n'est inventée.
 */
function completerDecision(api: Api, contenu: string, iso: string, principal: string): string {
  const lp = lireProprietes(contenu);
  if (lp.valeurs.type !== "decision" || !lp.modifiable) return contenu;
  let c = contenu;
  const id = lp.valeurs.id;
  if (typeof id !== "string" || !RE_IDENTIFIANT.test(id)) {
    const pris = new Set(api.espace.pagesVisibles().map((p) => (p.fm && typeof p.fm.id === "string" ? p.fm.id : "")));
    let n = nouvelIdentifiant("dec", api.cfg.fuseau);
    for (let k = 0; pris.has(n) && k < 20; k++) n = nouvelIdentifiant("dec", api.cfg.fuseau);
    c = poserPropriete(c, "id", n);
  }
  const vide = (v: unknown) => v === undefined || v === null || v === "";
  if (vide(lp.valeurs.cree)) c = poserPropriete(c, "cree", iso);
  if (vide(lp.valeurs.demandee_par)) c = poserPropriete(c, "demandee_par", principal);
  return c;
}

/** Segments du dossier « X/ » associé à la page « X.md ». */
function dossierDePage(segs: string[]): string[] {
  return [...segs.slice(0, -1), segs[segs.length - 1].slice(0, -3)];
}

/** Nom donné par POST /api/page/conflit : « <Titre> (conflit AAAA-MM-JJ HHhMM).md », éventuellement suivi de « (2) »… */
const RE_NOM_CONFLIT = / \(conflit \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)(?: \(\d+\))?\.md$/;

/**
 * Copie de conflit : frontmatter `conflit_de:` non vide (provenance posée par la copie de conflit, lot 5), OU nom de
 * copie de conflit : un modèle a souvent un en-tête que la porte des propriétés ne sait pas réécrire (`cree: {{date}}`
 * est une table YAML), sa copie est alors gardée telle quelle, sans `conflit_de` (voir `contenuDeConflit`).
 */
function estCopieDeConflit(p: { chemin: string; fm: Record<string, unknown> | null }): boolean {
  const v = p.fm?.conflit_de;
  return (typeof v === "string" && v.trim() !== "") || RE_NOM_CONFLIT.test(p.chemin);
}

async function lister(api: Api, ctx: Ctx): Promise<void> {
  const modeles = api.espace.pagesVisibles()
    // Finale V3 : une copie de conflit d'un modèle (`conflit_de:` posé par POST /api/page/conflit) reste une page du
    // dossier « Modèles/ », visible dans l'arbre, mais n'est PAS proposée comme modèle (deux « Compte rendu » au menu).
    .filter((p) => estModele(p.chemin) && !estArchivee(p) && !estCopieDeConflit(p))
    .map((p) => ({ chemin: p.chemin, titre: p.titre, icone: p.icone }))
    .sort((a, b) => collateur.compare(a.titre, b.titre) || (a.chemin < b.chemin ? -1 : 1));
  envoyerJson(ctx.req, ctx.res, 200, { dossier: DOSSIER_MODELES, modeles });
}

async function creerDepuisModele(api: Api, ctx: Ctx): Promise<void> {
  const corps = await lireJson(ctx.req, 64 * 1024);
  const modele = cheminPage(api.cfg, corps.modele);
  const cheminModele = modele.join("/");
  if (!estModele(cheminModele)) throw new ErreurHttp(400, `Le modèle doit être une page du dossier « ${DOSSIER_MODELES} ».`, "pas_un_modele");
  const titre = chaine(corps.titre, "titre", 500).replace(/\s*[\r\n]+\s*/g, " ").trim();
  if (!titre) throw new ErreurHttp(400, "Titre vide.", "titre_vide");
  const parent = corps.parent === undefined || corps.parent === null ? "" : chaine(corps.parent, "parent", 1024);
  const dossier = parent !== "" ? dossierDePage(cheminPage(api.cfg, parent)) : [];
  await api.verrou.executer(async () => {
    if (parent !== "") {
      const pMd = await lstatOuNull(await resoudre(api.cfg, [...dossier.slice(0, -1), dossier[dossier.length - 1] + ".md"]));
      const pDir = await lstatOuNull(await resoudre(api.cfg, dossier));
      if (!pMd && !pDir) throw new ErreurHttp(404, "Page parente introuvable.", "parent_introuvable");
    }
    const source = await lireModele(api, modele);
    if (source === null) throw new ErreurHttp(404, "Modèle introuvable.", "modele_introuvable");
    const iso = horodatageIso(new Date(), api.cfg.fuseau);
    const contenu = completerDecision(api, appliquer(source, { date: iso.slice(0, 10), heure: heureDe(iso), titre }), iso, ctx.login);
    const r = await api.ecrivain.creerUniqueSousVerrou({
      dossier, base: titre, action: "modele", transformer: () => contenu,
      // l'heure change à chaque essai : l'empreinte d'idempotence porte sur la demande, pas sur le contenu produit
      requete: requeteDe(ctx), operation: { modele: cheminModele, titre, parent },
    }, ctx.login);
    envoyerJson(ctx.req, ctx.res, r.rejoue ? 200 : 201, { chemin: r.chemin, etag: r.etag, modele: cheminModele, ...(r.rejoue ? { rejoue: true } : {}) }, { ETag: r.etag });
  });
}

/**
 * Journal du jour, IDEMPOTENT : `Journal/AAAA-MM-JJ.md` (date dans CARNET_FUSEAU) est créé une seule fois, depuis
 * `Modèles/Journal.md` s'il existe (sinon « # AAAA-MM-JJ ») ; s'il existe déjà, il est renvoyé tel quel (rien n'est
 * réappliqué ni écrasé). Création exclusive : un fichier apparu entre-temps (agent, Obsidian) gagne.
 */
async function journalDuJour(api: Api, ctx: Ctx): Promise<void> {
  await lireJson(ctx.req, 1024).catch(() => ({}));
  const iso = horodatageIso(new Date(), api.cfg.fuseau);
  const date = iso.slice(0, 10);
  const segs = [DOSSIER_JOURNAL, `${date}.md`];
  const chemin = segs.join("/");
  await api.verrou.executer(async () => {
    const st = await lstatOuNull(await resoudre(api.cfg, segs));
    if (st) {
      if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
      envoyerJson(ctx.req, ctx.res, 200, { chemin, date, cree: false });
      return;
    }
    const source = await lireModele(api, MODELE_JOURNAL.split("/"));
    const contenu = source === null ? `# ${date}\n\n` : appliquer(source, { date, heure: heureDe(iso), titre: date });
    try {
      const r = await api.ecrivain.ecrireSousVerrou({
        chemin: segs, revision: null, action: "journal", transformer: () => contenu,
        requete: requeteDe(ctx), operation: { date, modele: source === null ? null : sha256(source) },
      }, ctx.login);
      envoyerJson(ctx.req, ctx.res, r.rejoue ? 200 : 201, { chemin, date, cree: !r.rejoue, etag: r.etag }, { ETag: r.etag });
    } catch (e) {
      // apparu entre la vérification et la création exclusive : c'est l'existant qui fait foi
      if (e instanceof ErreurHttp && e.statut === 412 && e.raison === "existe") {
        envoyerJson(ctx.req, ctx.res, 200, { chemin, date, cree: false });
        return;
      }
      throw e;
    }
  });
}

export function routesPages(api: Api): [string, Gestionnaire][] {
  return [
    ["GET /api/modeles", (ctx) => lister(api, ctx)],
    ["POST /api/page/modele", (ctx) => creerDepuisModele(api, ctx)],
    ["POST /api/journal", (ctx) => journalDuJour(api, ctx)],
  ];
}
