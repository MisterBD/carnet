// Carnet · lot 5 « Fiabilité » (V3) : routes serveur de l'intégrité d'écriture démontrable.
//   - POST /api/page/conflit : copie de conflit à nom unique (`<Page> (conflit AAAA-MM-JJ HHhMM).md`), jamais d'écrasement ;
//   - GET/POST /api/nouveautes/retour : « Revenir à la version marquée vue » (aperçu, puis confirmation à la révision vue) ;
//   - GET /api/ecritures/indeterminees, POST /api/ecritures/indeterminees/traiter : écritures ni faites ni abandonnées ;
//   - barrière d'attestation : une restauration ne fait JAMAIS redevenir valide une ancienne attestation de décision.
// Toutes les écritures passent par la porte unique (Ecrivain : révision, idempotence, intention durable, journal).
import { bilan, differencesLignes } from "../../shared/diff.ts";
import { porteeChainee } from "../../shared/decision.ts";
import { horodatageIso } from "../../shared/identifiants.ts";
import { decouper, feuille, lireChampSimple } from "../../shared/page.ts";
import { ErreurFormat, poserPropriete } from "../../shared/proprietes.ts";
import type { DemandeAttestation } from "./attestations.ts";
import type { Ctx } from "./api.ts";
import type { Config } from "./config.ts";
import { elementsDecision, estDecision } from "./decisions.ts";
import { maillonDe } from "./demandes.ts";
import { etagDe, lireConfine, verifierEcriture } from "./disque.ts";
import { MAX_PAGE, RE_REQUETE } from "./ecriture.ts";
import type { Ecrivain } from "./ecriture.ts";
import type { Espace } from "./espace.ts";
import { contenuArchive, contenuVerrouille } from "./espace.ts";
import { chaine, envoyerJson, ErreurHttp, lireJson } from "./http.ts";
import { sha256 } from "./journal-ecritures.ts";
import type { EntreeJournal } from "./journal-ecritures.ts";
import type { Nouveautes } from "./nouveautes.ts";
import { cheminPage } from "./securite.ts";

type Gestionnaire = (ctx: Ctx) => Promise<void>;

const MAX_LECTURE = 5 * 1024 * 1024;
/** Écritures de Carnet qui ne changent pas le contenu d'une page (mouvements) : jamais comptées comme modifications. */
const MOUVEMENTS = new Set(["renommer", "deplacer", "supprimer"]);

function json(ctx: Ctx, statut: number, objet: unknown): void {
  envoyerJson(ctx.req, ctx.res, statut, objet);
}

function requeteDe(ctx: Ctx): string | undefined {
  const v = ctx.req.headers["x-carnet-requete"];
  return typeof v === "string" ? v.trim() : undefined;
}

/** « 2026-10-11 02h14 » dans le fuseau de l'espace (nom des copies de conflit). */
export function dateHeureConflit(fuseau: string, d = new Date()): string {
  const iso = horodatageIso(d, fuseau); // 2026-10-11T02:14:03+02:00
  return `${iso.slice(0, 10)} ${iso.slice(11, 13)}h${iso.slice(14, 16)}`;
}

/**
 * Contenu d'une copie de conflit : le texte reçu, avec `conflit_de: "<chemin d'origine>"` (provenance lisible par un
 * humain et un agent) ; une demande de décision devient `type: decision-conflit` (jamais une seconde demande au même
 * `id`). En-tête que la porte des propriétés refuse (ancres, YAML invalide…) : texte gardé tel quel, sans marque.
 */
/**
 * Lots 5 × 6 : une copie de conflit doit rester VISIBLE et MODIFIABLE : elle n'hérite ni de `archive: true` (elle
 * sortirait des listes) ni de `verrou: true` (on ne pourrait pas la reprendre). Les drapeaux retirés sont rendus à
 * l'interface, qui le dit (« copie non archivée, non verrouillée »).
 */
export function drapeauxDeConflit(contenu: string): { contenu: string; retires: Array<"archive" | "verrou"> } {
  const retires: Array<"archive" | "verrou"> = [];
  let c = contenu;
  try {
    if (contenuArchive(c)) { c = poserPropriete(c, "archive", undefined); retires.push("archive"); }
    if (contenuVerrouille(c)) { c = poserPropriete(c, "verrou", undefined); retires.push("verrou"); }
  } catch (e) {
    if (e instanceof ErreurFormat) return { contenu, retires: [] };
    throw e;
  }
  return { contenu: c, retires };
}

export function contenuDeConflit(contenu: string, origine: string, etiquette?: string): string {
  try {
    let c = poserPropriete(drapeauxDeConflit(contenu).contenu, "conflit_de", origine, { type: "texte" });
    // Lot 5 (recette) : une page titrée « # Conflit » donnait deux « Conflit » dans l'arbre ; la copie porte un
    // `title:` distinct (l'arbre lit `title:` d'abord), le corps et son « # Titre » restent intacts.
    if (etiquette) {
      const d = decouper(c);
      const titre = lireChampSimple(d.yaml, "title") ?? d.titreH1;
      if (titre) c = poserPropriete(c, "title", `${titre.trim()} (${etiquette})`, { type: "texte" });
    }
    if (estDecision(c)) c = poserPropriete(c, "type", "decision-conflit", { type: "texte" });
    return c;
  } catch (e) {
    if (e instanceof ErreurFormat) return contenu;
    throw e;
  }
}

/**
 * Barrière : si `contenuRestaure` est une demande de décision dont l'empreinte a DÉJÀ une attestation valide
 * dans la chaîne de sa demande, renvoie l'attestation « restauration » à ajouter par la même écriture. Son empreinte
 * n'est celle d'aucune proposition (sha256 de « carnet-restauration-v1 », demande, empreinte restaurée, horodatage) :
 * elle devient la DERNIÈRE de la chaîne, donc l'ancienne attestation passe « remplacée » et ne fait plus foi. Elle est
 * chaînée comme celles du lot 3 (precedente = maillon de la dernière attestation valide du journal).
 * À appeler SOUS le verrou des mutations (maillon lu juste avant l'écriture).
 */
export async function barriereRestauration(cfg: Config, ecrivain: Ecrivain, contenuRestaure: string, action: string): Promise<DemandeAttestation | null> {
  if (!estDecision(contenuRestaure)) return null;
  const e = elementsDecision(contenuRestaure);
  if (!e.demande || !e.empreinte) return null;
  const valides = (await ecrivain.attestations.lister()).filter((x) => x.valide).map((x) => x.attestation);
  if (!valides.some((a) => a.demande === e.demande && a.empreinte === e.empreinte)) return null;
  const t = horodatageIso(new Date(), cfg.fuseau);
  const maillon = valides.length ? maillonDe(valides[valides.length - 1]) : "aucune";
  return {
    demande: e.demande,
    empreinte: "sha256:" + sha256(`carnet-restauration-v1\n${e.demande}\n${e.empreinte}\n${t}`),
    resultat: "restauration",
    portee: porteeChainee(`restauration-v1 action=${action} n-autorise-rien`, maillon),
    geste: "identite-seule",
  };
}

/** La restauration de ce contenu poserait-elle une barrière ? (aperçu, sans rien écrire) */
async function barriereNecessaire(ecrivain: Ecrivain, contenu: string): Promise<boolean> {
  if (!estDecision(contenu)) return false;
  const e = elementsDecision(contenu);
  if (!e.demande || !e.empreinte) return false;
  return (await ecrivain.attestations.lister({ demande: e.demande })).some((x) => x.valide && x.attestation.empreinte === e.empreinte);
}

const MESSAGE_RETOUR_VERROU = "Page verrouillée : déverrouille-la d'abord pour revenir à la version vue (rien n'a été écrit).";

export class Fiabilite {
  #cfg: Config;
  #espace: Espace;
  #ecrivain: Ecrivain;
  #nouveautes: Nouveautes;

  constructor(cfg: Config, espace: Espace, ecrivain: Ecrivain, nouveautes: Nouveautes) {
    this.#cfg = cfg;
    this.#espace = espace;
    this.#ecrivain = ecrivain;
    this.#nouveautes = nouveautes;
  }

  routes(): Array<[string, Gestionnaire]> {
    return [
      ["POST /api/page/conflit", (c) => this.conflit(c)],
      ["GET /api/nouveautes/retour", (c) => this.apercuRetour(c)],
      ["POST /api/nouveautes/retour", (c) => this.retour(c)],
      ["GET /api/ecritures/indeterminees", async (c) => json(c, 200, { elements: await this.#ecrivain.listerIndeterminees() })],
      ["POST /api/ecritures/indeterminees/traiter", async (c) => {
        const corps = await lireJson(c.req, 16 * 1024);
        json(c, 200, { restantes: await this.#ecrivain.traiterIndeterminee(corps.id) });
      }],
    ];
  }

  // ---------- Copie de conflit ----------

  async conflit(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, MAX_PAGE + 64 * 1024);
    const segs = cheminPage(this.#cfg, corps.chemin);
    const contenu = chaine(corps.contenu, "contenu", Infinity);
    if (Buffer.byteLength(contenu) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
    const chemin = segs.join("/");
    let nom = feuille(chemin);
    if (Buffer.byteLength(nom) > 180) nom = nom.slice(0, 80).trim();
    const etiquette = `conflit ${dateHeureConflit(this.#cfg.fuseau)}`;
    const base = `${nom} (${etiquette})`;
    const copie = contenuDeConflit(contenu, chemin, etiquette);
    if (Buffer.byteLength(copie) > MAX_PAGE) throw new ErreurHttp(413, "Page trop volumineuse (maximum 2 Mo).", "trop_gros");
    const r = await this.#ecrivain.creerUnique({
      dossier: segs.slice(0, -1), base, action: "conflit", transformer: () => copie,
      requete: requeteDe(ctx), operation: { origine: chemin, contenu: sha256(contenu) },
    }, ctx.login);
    const { retires } = drapeauxDeConflit(contenu);
    json(ctx, 201, { chemin: r.chemin, etag: r.etag, ...(retires.length ? { retires } : {}), ...(r.rejoue ? { rejoue: true } : {}) });
  }

  // ---------- Retour à la version marquée vue ----------

  async #actuel(segs: string[]): Promise<{ etag: string; contenu: string } | null> {
    const { abs, st } = await verifierEcriture(this.#cfg, segs);
    if (!st) return null;
    if (!st.isFile()) throw new ErreurHttp(409, "Ce chemin n'est pas une page.", "pas_un_fichier");
    const { contenu } = await lireConfine(this.#cfg, abs, MAX_LECTURE);
    return { etag: etagDe(contenu), contenu };
  }

  /**
   * Écritures de Carnet à ce chemin APRÈS la version vue (journal du socle : 50 dernières par chemin). Si Carnet a
   * lui-même produit la version vue, ce sont les écritures qui suivent la dernière qui l'a produite ; sinon celles datées
   * de la même seconde que le marquage ou après (prudent : dans le doute, une écriture est comptée, jamais oubliée).
   */
  #ecrituresDepuis(chemin: string, ref: { etag: string; t: string }): EntreeJournal[] {
    const l = this.#ecrivain.journal.dernieres(chemin, 50).filter((e) => e.chemin === chemin);
    let i = -1;
    for (let k = l.length - 1; k >= 0; k--) if (l[k].apres === ref.etag) { i = k; break; }
    if (i >= 0) return l.slice(i + 1);
    const depuis = Date.parse(ref.t) || 0;
    return l.filter((e) => (Date.parse(e.t) || 0) >= depuis);
  }

  async #portee(lecteur: string, chemin: string) {
    const ref = await this.#nouveautes.reference(lecteur, chemin);
    if (!ref || ref.contenu === null) {
      throw new ErreurHttp(404, "Aucune version marquée vue n'est disponible pour cette page.", "pas_de_version_vue");
    }
    const ecritures = this.#ecrituresDepuis(chemin, ref);
    const humaines = ecritures.filter((e) => !MOUVEMENTS.has(e.action));
    return { ref: { ...ref, contenu: ref.contenu }, ecritures, humaines };
  }

  async apercuRetour(ctx: Ctx): Promise<void> {
    const segs = cheminPage(this.#cfg, ctx.url.searchParams.get("chemin"));
    const chemin = segs.join("/");
    const { ref, ecritures, humaines } = await this.#portee(ctx.login, chemin);
    const actuel = await this.#actuel(segs);
    if (!actuel) throw new ErreurHttp(404, "Page introuvable.", "introuvable");
    if (contenuVerrouille(actuel.contenu)) throw new ErreurHttp(423, MESSAGE_RETOUR_VERROU, "page_verrouillee", { raison: "page_verrouillee" });
    if (actuel.etag === ref.etag) throw new ErreurHttp(409, "La page est déjà à la version marquée vue.", "a_jour");
    const dernier = this.#ecrivain.journal.dernieres(chemin, 1)[0];
    json(ctx, 200, {
      chemin, titre: this.#espace.pages.get(chemin)?.titre ?? feuille(chemin),
      vu: { etag: ref.etag, t: ref.t, contenu: ref.contenu },
      actuel,
      bilan: bilan(differencesLignes(ref.contenu, actuel.contenu)),
      ecritures: ecritures.map((e) => ({ t: e.t, principal: e.principal, action: e.action, auteur_declare: e.auteur_declare ?? null })),
      externe: !(dernier && dernier.apres === actuel.etag),
      humaines: humaines.map((e) => ({ t: e.t, principal: e.principal, action: e.action })),
      decision: { estDecision: estDecision(ref.contenu), attestationNeutralisee: await barriereNecessaire(this.#ecrivain, ref.contenu) },
      // lots 5 × 6 : une page archivée le reste (le retour garde `archive: true`)
      archive: contenuArchive(actuel.contenu),
    });
  }

  async retour(ctx: Ctx): Promise<void> {
    const corps = await lireJson(ctx.req, 64 * 1024);
    const requete = requeteDe(ctx);
    if (!requete) throw new ErreurHttp(400, "En-tête X-Carnet-Requete obligatoire pour revenir à une version.", "requete_absente");
    if (!RE_REQUETE.test(requete)) throw new ErreurHttp(400, "Identifiant de requête invalide (en-tête X-Carnet-Requete).", "requete_invalide");
    const segs = cheminPage(this.#cfg, corps.chemin);
    const chemin = segs.join("/");
    const etag = chaine(corps.etag, "etag", 100);
    const vu = chaine(corps.vu, "vu", 100);
    if (corps.humaines !== undefined && typeof corps.humaines !== "boolean") throw new ErreurHttp(400, "Champ « humaines » invalide.", "champ_invalide");
    const accepteHumaines = corps.humaines === true;
    const operation = { vu, etag, humaines: accepteHumaines };
    // Rejeu d'abord (la référence a déjà avancé après un retour réussi : les contrôles ci-dessous échoueraient).
    const rejeu = await this.#ecrivain.verrou.executer(() => this.#ecrivain.rejeuSousVerrou({ chemin: segs, action: "retour-vue", requete, operation }, ctx.login));
    if (rejeu) {
      json(ctx, 200, { etag: rejeu.etag, chemin: rejeu.chemin, instantane: rejeu.instantane ?? null, rejoue: true });
      return;
    }
    const { ref, humaines } = await this.#portee(ctx.login, chemin);
    if (ref.etag !== vu) {
      throw new ErreurHttp(409, "La version marquée vue a changé depuis l'aperçu : rien n'a été écrit.", "reference_changee", { vu: ref.etag });
    }
    if (humaines.length && !accepteHumaines) {
      throw new ErreurHttp(409, "Des modifications faites dans Carnet depuis la version vue seraient retirées aussi : confirme explicitement.", "modifications_humaines", {
        humaines: humaines.map((e) => ({ t: e.t, principal: e.principal, action: e.action })),
      });
    }
    let copie = ref.contenu;
    const r = await this.#ecrivain.verrou.executer(async () => {
      const attester = await barriereRestauration(this.#cfg, this.#ecrivain, copie, "retour-vue");
      return this.#ecrivain.ecrireSousVerrou({
        chemin: segs, revision: etag, action: "retour-vue", requete, operation,
        // Lots 5 × 6 : revenir à la version vue ne DÉSARCHIVE pas (l'archive est un rangement, pas un contenu).
        // Page verrouillée : refusée par la porte (423) avant cette transformation, rien n'est écrit.
        transformer: (avant) => {
          if (avant !== null && contenuArchive(avant) && !contenuArchive(copie)) {
            try { copie = poserPropriete(copie, "archive", true); } catch (e) { if (!(e instanceof ErreurFormat)) throw e; }
          }
          return copie;
        },
        instantaneAvant: "avant-retour", ...(attester ? { attester } : {}),
      }, ctx.login);
    });
    // La version restaurée redevient la référence du lecteur (explicitement : l'observateur est asynchrone).
    await this.#nouveautes.poserReference(ctx.login, chemin, copie);
    json(ctx, 200, { etag: r.etag, chemin: r.chemin, instantane: r.instantane ?? null, ...(r.rejoue ? { rejoue: true } : {}) });
  }
}
