// Client de l'API du serveur Carnet. Toute mutation porte l'en-tête X-Carnet (anti-CSRF).
import type { ResultatBase, Tri, TypePropriete, ValeurBrute, ValeurSaisie } from "../../shared/bases.ts";

export interface Noeud {
  chemin: string;
  nom: string;
  titre: string;
  icone: string | null;
  existe: boolean;
  type: "page" | "fichier";
  ext?: string;
  enfants: Noeud[];
  mtime: number;
  resume?: string;
  /** Lien symbolique vers une autre page : affichée, jamais modifiée. */
  lectureSeule?: boolean;
  /** Lot 6 : page archivée (`archive: true`) : rangée dans le groupe replié « Archives ». */
  archive?: boolean;
  /** Lot 6 : page verrouillée (`verrou: true`). */
  verrou?: boolean;
}

export interface Config {
  utilisateur: { login: string; nom: string; prenom?: string | null };
  artBase: string;
  espace: string;
  dev: boolean;
  /** Historique git disponible pour l'espace (sinon : instantanés seulement). */
  historique?: { git: boolean };
  /** Durée de séjour dans la corbeille avant purge automatique (0 = jamais). */
  corbeille?: { jours: number };
  /** Mentions qui placent une page dans « À relire » (ex. « @camille »). */
  mentions?: string[];
  /** Réseau privé à allumer pour joindre Carnet (« Tailscale »…), cité par les écrans hors ligne ; null = texte générique. */
  reseau?: string | null;
  /** Qui prévenir quand le serveur répond mal ; null = texte générique. */
  contact?: string | null;
  /** Dossier des captures (CARNET_INBOX, « Inbox » par défaut) et fuseau des échéances (lot 1). */
  inbox?: string;
  fuseau?: string;
}

export interface ElementCorbeille {
  id: string;
  chemin: string;
  titre: string;
  icone: string | null;
  /** Date de suppression (ms). */
  date: number;
  sousPages: number;
  /** Une page occupe aujourd'hui le chemin d'origine (la restauration prendra un nom « (restaurée) »). */
  existe: boolean;
}

export interface Version {
  id: string;
  date: number;
  source: "git" | "instantane";
  auteur?: string;
  message?: string;
  auto?: boolean;
  /** Instantané : pris à la main, juste avant une restauration, ou version automatique de début de séance. */
  genre?: "manuel" | "avant-restauration" | "seance" | "avant-retour";
}

export interface Retrolien { chemin: string; titre: string; icone: string | null; extrait: string }

export interface Apercu {
  chemin: string;
  titre: string;
  icone: string | null;
  resume: string | null;
  extrait: string;
  mtime: number;
  sousPages: number;
}

// ---------- Lot 10 « Missions vivantes » (GET /api/missions, lecture seule) ----------

export type SectionMission = "a_arbitrer" | "resultats" | "en_cours" | "autres";
export type CodeEtatMission = "a_faire" | "en_cours" | "a_arbitrer" | "bloquee" | "terminee_declaree" | "abandonnee";

export interface LienMission {
  brut: string;
  genre: "page" | "dossier" | "fichier" | "externe" | "introuvable" | "invalide";
  chemin: string | null;
  titre: string | null;
  url: string | null;
  /** Présent dans l'espace (page, dossier, fichier). Une URL externe n'est jamais « résolue ». */
  resolu: boolean;
}

export interface Mission {
  chemin: string;
  titre: string;
  icone: string | null;
  etag: string;
  id: string | null;
  demande: string | null;
  demande_par: string | null;
  responsable_declare: string | null;
  etat: { brut: string | null; code: CodeEtatMission | null };
  section: SectionMission;
  /** Dernier signal DÉCLARÉ par l'agent (ms), à distinguer de `observe` (date du fichier). */
  signal: { brut: string | null; date: number | null; precision: "minute" | "jour" | null; fuseau: boolean };
  observe: number;
  prochain_pas: string | null;
  blocage: string | null;
  livrables: LienMission[];
  resultat: LienMission | null;
  decision: (LienMission & { statut: string | null }) | null;
  client: LienMission | null;
  journal: { nb: number; dernier: string | null };
  technique: boolean;
  anomalies: Array<{ code: string; texte: string }>;
}

export interface ReponseMissions {
  maintenant: number;
  fuseau: string;
  missions: Mission[];
  compteurs: { total: number; a_arbitrer: number; resultats: number; en_cours: number; autres: number; bloquees: number; anomalies: number };
  tronque: boolean;
}

export type Position = "avant" | "apres" | "dans";

export interface Page {
  chemin: string;
  contenu: string;
  etag: string | null;
  mtime: number;
  absente?: boolean;
  dossier?: boolean;
  /** Lot 3 : preuve d'une décision, calculée par le serveur (pages `type: decision` seulement). */
  preuveDecision?: PreuveDecision;
}

export interface Resultat {
  chemin: string;
  titre: string;
  icone: string | null;
  avant: string;
  extrait: string;
  apres: string;
  score: number;
  /** Lot 6 : page archivée (la recherche ne les renvoie qu'avec « Inclure les archives »). */
  archive?: boolean;
}

export interface ResumePage {
  chemin: string;
  titre: string;
  icone: string | null;
  mtime: number;
  resume?: string;
  raisons?: string[];
}

export interface Tache {
  chemin: string;
  titre: string;
  ligne: number;
  texte: string;
  libelle: string;
}

export interface Accueil {
  recents: ResumePage[];
  aRelire: ResumePage[];
  taches: Tache[];
}

export interface PageProjet {
  chemin: string;
  titre: string;
  icone: string | null;
  mtime: number;
  meta: Record<string, string>;
}

// ---------- V3 lot 1 « Aujourd'hui » : tâches datées, capture, boîte de réception ----------

export type Priorite = "plus-haute" | "haute" | "moyenne" | "basse" | "plus-basse";

export interface TacheJour {
  chemin: string;
  /** Titre de la page qui contient la tâche. */
  titre: string;
  icone: string | null;
  /** Numéro de ligne (0 = première) et texte brut exact de la ligne, renvoyés tels quels pour modifier la tâche. */
  ligne: number;
  texte: string;
  /** Texte de la tâche sans les marqueurs reconnus. */
  libelle: string;
  /** Caractère entre crochets : " " à faire, "/" en cours, autre = statut personnalisé conservé. */
  coche: string;
  echeance?: string;
  prevue?: string;
  debut?: string;
  priorite?: Priorite;
  recurrence?: string;
  anomalies: string[];
  /**
   * Échéances (11/10/2026) : fiche d'une base qui déclare `carnet.aujourdhui` (ligne = -1, texte = "") : provenance,
   * révision lue (If-Match), propriété et valeur « fait » déclarées, valeur d'avant (pour « Annuler »).
   */
  fiche?: FicheTache;
}

export interface FicheTache {
  base: string; baseTitre: string; bloc: number; etag: string;
  propriete: string; valeur: string | boolean;
  avant?: ValeurBrute; absente?: boolean;
}

export interface DonneesAujourdhui {
  /** Date du jour (AAAA-MM-JJ) dans le fuseau du carnet. */
  date: string;
  fuseau: string;
  enRetard: TacheJour[];
  aujourdhui: TacheJour[];
  semaine: TacheJour[];
  plusTard: TacheJour[];
  sansDate: TacheJour[];
  aRelire: { critere: { statut: string; mentions: string[] }; pages: ResumePage[] };
  recents: ResumePage[];
  /** Nombre de captures dans la boîte de réception. */
  boite: number;
  /** Lot 12 : vues « À relancer » des bases de l'espace (absent si aucune). */
  aRelancer?: Array<{ chemin: string; titre: string; bloc: number; vue: number; nom: string; total: number }>;
  /** API du lot 3 disponibles sur ce serveur. */
  modules?: { decisions: boolean; nouveautes: boolean };
}

export interface Capture {
  chemin: string;
  titre: string;
  id: string | null;
  cree: string | null;
  source: string | null;
  extrait: string;
  mtime: number;
}

export interface Decision { chemin: string; titre: string; id?: string; statut?: string; demandee_par?: string | null; echeance?: string | null; cree?: string | null }
// `Nouveaute` : type du lot 3 (plus bas), même forme que celle attendue par l'écran Aujourd'hui (intégration V3).

/** `faite: true` : le serveur pose ✅ avec la date du jour (fuseau du carnet) ; `faite: null` retire ✅ (décocher). */
export interface ChangementsTache { coche?: boolean; echeance?: string | null; priorite?: Priorite | null; faite?: true | null }

/** Lecture tolérante d'une API d'un autre lot : null si absente (404), en erreur ou hors service. */
async function facultatif<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ---------- Dossier de rendez-vous (lot 11, server/src/preparation.ts) ----------

export interface RevisionPrep { etag: string; court: string; modifiee: string; mtime: number }
export interface RefPagePrep { chemin: string; titre: string; revision: RevisionPrep }
export interface SourcePrep {
  brut: string;
  etat: "lue" | "dossier" | "introuvable" | "non_accessible" | "externe" | "ignoree";
  raison?: string; nom?: string; chemin?: string; pages?: number; total?: number; tronque?: boolean; implicite?: boolean; doublon?: boolean; exclues?: number;
}
export interface PreuvePrep { etat: "absente" | "valide" | "perimee" | "remplacee" | "indeterminee"; geste: "cle-d-acces" | "identite-seule" | null; resultat: string | null }
export interface ApercuPreparation {
  version: 1;
  fiche: RefPagePrep;
  genere: string;
  empreinte: string;
  couverture: { declarees: number; entreesIgnorees: number; lues: number; manquantes: number; nonAccessibles: number; externes: number; ignorees: number; tronquee: boolean };
  sources: SourcePrep[];
  pages: Array<RefPagePrep & { origine: string }>;
  decisions: Array<{ source: RefPagePrep; aConfirmer: boolean; id: string | null; statut: string | null; cree: string | null; demandePar: string | null; extrait: string; preuve: PreuvePrep | null }>;
  taches: Array<{ source: RefPagePrep; ligne: number; texte: string; echeance: string | null; priorite: string | null; enCours: boolean; enRetard: boolean; anomalies: string[] }>;
  notes: Array<{ source: RefPagePrep; extrait: string }>;
  livrables: Array<{
    titre: string; etat: "present" | "absent" | "externe" | "non_accessible"; chemin?: string; dossier?: boolean; revision?: RevisionPrep; url?: string; brut?: string;
    origine: "mission" | "type" | "etiquette"; mission?: { chemin: string; titre: string; etat: string | null };
  }>;
  masques: { decisions: number; taches: number; notes: number; livrables: number; notesAnciennes: number };
}
export interface EtatPreparation {
  fiche: string | null;
  ficheExiste: boolean;
  cree: string | null;
  sources: number;
  aRafraichir: boolean;
  changements: Array<{ chemin: string; titre: string; etat: "modifiee" | "disparue" | "retiree" | "nouvelle" }>;
}

export class ErreurApi extends Error {
  statut: number;
  corps: Record<string, unknown>;
  constructor(statut: number, corps: Record<string, unknown>) {
    super(String(corps.erreur ?? `Erreur ${statut}`));
    this.statut = statut;
    this.corps = corps;
  }
}

const ENTETES_MUTATION = { "X-Carnet": "1" };

async function lire<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let corps: Record<string, unknown> = {};
    try { corps = await r.json(); } catch { corps = { erreur: r.statusText || `Erreur ${r.status}` }; }
    throw new ErreurApi(r.status, corps);
  }
  return (await r.json()) as T;
}

const q = encodeURIComponent;

/**
 * Identifiant d'idempotence d'un geste (en-tête X-Carnet-Requete) : 128 bits aléatoires en hexadécimal. Le serveur
 * rejoue le même résultat si le même geste arrive deux fois (double envoi, relance après une réponse perdue).
 */
export function nouvelleRequete(): string {
  const o = new Uint8Array(16);
  crypto.getRandomValues(o);
  return Array.from(o, (x) => x.toString(16).padStart(2, "0")).join("");
}

function envoyer(methode: string, url: string, corps?: unknown, entetes: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: methode,
    headers: { ...ENTETES_MUTATION, "X-Carnet-Requete": nouvelleRequete(), "Content-Type": "application/json", ...entetes },
    body: corps === undefined ? undefined : JSON.stringify(corps),
    credentials: "same-origin",
  });
}

export const api = {
  config: () => fetch("/api/config").then((r) => lire<Config>(r)),
  arbre: () => fetch("/api/arbre").then((r) => lire<{ racine: Noeud[]; version?: number }>(r)),

  async page(chemin: string): Promise<Page> {
    const r = await fetch(`/api/page?chemin=${q(chemin)}`);
    if (r.status === 404) {
      const corps = await r.json().catch(() => ({}));
      return { chemin, contenu: "", etag: null, mtime: 0, absente: true, dossier: Boolean((corps as { dossier?: boolean }).dossier) };
    }
    return lire<Page>(r);
  },

  /**
   * Enregistre une page. `requete` : même identifiant pour les relances d'un MÊME enregistrement (sinon un nouveau) ;
   * `ecraser` : « Garder la mienne » après un conflit, `etag` étant celui reçu dans le 412 (la version écrasée est
   * gardée en instantané par le serveur).
   */
  ecrire: (chemin: string, contenu: string, etag: string | null, opts: { requete?: string; ecraser?: boolean } = {}) =>
    envoyer("PUT", `/api/page?chemin=${q(chemin)}`, { contenu, ...(opts.ecraser ? { ecraser: true } : {}) }, {
      ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }),
      ...(opts.requete ? { "X-Carnet-Requete": opts.requete } : {}),
    }).then((r) => lire<{ etag: string; mtime: number; rejoue?: boolean }>(r)),

  creer: (parent: string, titre: string, contenu?: string) =>
    envoyer("POST", "/api/page", { parent, titre, contenu }).then((r) => lire<{ chemin: string; etag: string }>(r)),

  renommer: (chemin: string, nom: string) =>
    envoyer("POST", "/api/renommer", { chemin, nom }).then((r) => lire<{ chemin: string; liensMisAJour: number }>(r)),

  deplacer: (chemin: string, parent: string) =>
    envoyer("POST", "/api/deplacer", { chemin, parent }).then((r) => lire<{ chemin: string; liensMisAJour: number }>(r)),

  supprimer: (chemin: string) =>
    envoyer("POST", "/api/supprimer", { chemin }).then((r) => lire<{ id: string; corbeille: string; chemin: string; titre: string }>(r)),

  /** Renomme par le titre : la ligne « # Titre » (ou `title:`) change, et le fichier suit si son nom suivait le titre. */
  renommerTitre: (chemin: string, titre: string) =>
    envoyer("POST", "/api/renommer", { chemin, titre }).then((r) => lire<{ chemin: string; liensMisAJour: number; etag?: string; renomme: boolean }>(r)),

  /** Glisser-déposer et Monter / Descendre : avant ou après une page sœur, ou dans une page (fin de ses sous-pages). */
  placer: (chemin: string, cible: string, position: Position) =>
    envoyer("POST", "/api/placer", { chemin, cible, position }).then((r) => lire<{ chemin: string; liensMisAJour: number }>(r)),

  dupliquer: (chemin: string) =>
    envoyer("POST", "/api/dupliquer", { chemin }).then((r) => lire<{ chemin: string }>(r)),

  corbeille: () => fetch("/api/corbeille").then((r) => lire<{ elements: ElementCorbeille[]; jours: number }>(r)),
  restaurer: (id: string) =>
    envoyer("POST", "/api/corbeille/restaurer", { id }).then((r) => lire<{ chemin: string; renomme: boolean }>(r)),
  effacer: (id: string) =>
    envoyer("POST", "/api/corbeille/effacer", { id }).then((r) => lire<{ effaces: number }>(r)),
  viderCorbeille: () =>
    envoyer("POST", "/api/corbeille/effacer", { tout: true }).then((r) => lire<{ effaces: number }>(r)),
  apercuCorbeille: (id: string) =>
    fetch(`/api/corbeille/apercu?id=${q(id)}`).then((r) => lire<{ id: string; chemin: string; titre: string; contenu: string }>(r)),

  historique: (chemin: string) =>
    fetch(`/api/historique?chemin=${q(chemin)}`).then((r) => lire<{ git: boolean; versions: Version[]; pauseVersions?: number }>(r)),
  version: (chemin: string, id: string) =>
    fetch(`/api/version?chemin=${q(chemin)}&id=${q(id)}`).then((r) => lire<{ id: string; date: number; contenu: string }>(r)),
  instantane: (chemin: string) =>
    envoyer("POST", "/api/instantane", { chemin }).then((r) => lire<{ id: string; date: number; identique: boolean }>(r)),
  restaurerVersion: (chemin: string, id: string, etag?: string | null) =>
    envoyer("POST", "/api/restaurer-version", { chemin, id }, etag ? { "If-Match": etag } : {}).then((r) => lire<{ etag: string; instantane: string | null }>(r)),

  retroliens: (chemin: string) =>
    fetch(`/api/retroliens?chemin=${q(chemin)}`).then((r) => lire<{ pages: Retrolien[] }>(r)),
  apercu: (chemin: string, signal?: AbortSignal) =>
    fetch(`/api/apercu?chemin=${q(chemin)}`, { signal }).then((r) => lire<Apercu>(r)),
  couvertures: (page: string) =>
    fetch(`/api/couvertures?page=${q(page)}`).then((r) => lire<{ images: Array<{ chemin: string; relatif: string }> }>(r)),

  recherche: (texte: string, signal?: AbortSignal, archives = false) =>
    fetch(`/api/recherche?q=${q(texte)}&limite=30${archives ? "&archives=1" : ""}`, { signal }).then((r) => lire<{ resultats: Resultat[] }>(r)),

  async televerser(page: string, f: File): Promise<{ chemin: string; relatif: string }> {
    const r = await fetch(`/api/images?page=${q(page)}`, {
      method: "POST",
      headers: { ...ENTETES_MUTATION, "Content-Type": f.type || "application/octet-stream", "X-Nom-Fichier": q(f.name || "image") },
      body: f,
    });
    return lire(r);
  },

  accueil: () => fetch("/api/accueil").then((r) => lire<Accueil>(r)),

  tache: (t: Tache, coche: boolean) =>
    envoyer("POST", "/api/tache", { chemin: t.chemin, ligne: t.ligne, texte: t.texte, coche }).then((r) => lire<{ etag: string; texte: string }>(r)),

  projets: (dossier?: string) =>
    fetch(`/api/projets${dossier ? `?dossier=${q(dossier)}` : ""}`).then((r) => lire<{ pages: PageProjet[] }>(r)),

  meta: (chemin: string, champs: Record<string, string | null>, etag?: string | null) =>
    envoyer("POST", "/api/meta", { chemin, champs }, etag ? { "If-Match": etag } : {}).then((r) => lire<{ etag: string }>(r)),

  favoris: () => fetch("/api/favoris").then((r) => lire<{ chemins: string[] }>(r)),
  poserFavoris: (chemins: string[]) => envoyer("PUT", "/api/favoris", { chemins }).then((r) => lire<{ chemins: string[] }>(r)),

  missions: () => fetch("/api/missions").then((r) => lire<ReponseMissions>(r)), // lot 10
  preparation: (chemin: string) =>
    fetch(`/api/preparation?chemin=${q(chemin)}`).then((r) => lire<ApercuPreparation>(r)),
  etatPreparation: (chemin: string) =>
    fetch(`/api/preparation/etat?chemin=${q(chemin)}`).then((r) => lire<EtatPreparation>(r)),
  conserverPreparation: (a: ApercuPreparation, requete: string) =>
    envoyer("POST", "/api/preparation/conserver", { chemin: a.fiche.chemin, empreinte: a.empreinte, genere: a.genere }, { "X-Carnet-Requete": requete })
      .then((r) => lire<{ chemin: string; etag: string; rejoue: boolean }>(r)),

  artefacts: () => fetch("/api/artefacts").then((r) => lire<{ artefacts: Array<{ chemin: string; titre: string; date?: string }> }>(r)),
  // ---------- V3 lot 1 « Aujourd'hui » ----------
  aujourdhui: () => fetch("/api/aujourdhui").then((r) => lire<DonneesAujourdhui>(r)),
  /**
   * Modifie une tâche (route /api/tache du socle) : clôture, échéance, priorité. `texte` = ligne telle qu'affichée (409
   * `tache_changee` si elle a changé) ; marqueur en double ou invalide : 422 ciblé. `texte` renvoyé null sur un rejeu.
   */
  modifierTache: (t: { chemin: string; ligne: number; texte: string }, changements: ChangementsTache, requete = nouvelleRequete()) =>
    envoyer("POST", "/api/tache", { chemin: t.chemin, ligne: t.ligne, texte: t.texte, ...changements }, { "X-Carnet-Requete": requete })
      .then((r) => lire<{ etag: string; texte: string | null; rejoue?: boolean }>(r)),
  /**
   * Échéances : coche (fait: true → valeur « fait » déclarée par la base) ou décoche (avant / absente) une fiche de base,
   * à la révision lue ; 412 si le fichier a changé (rien n'est écrasé), 422 si la base ne le déclare pas.
   */
  cocherFiche: (chemin: string, etag: string, corps: { fait: true } | { fait: false; avant?: ValeurBrute; absente?: true }, requete = nouvelleRequete()) =>
    envoyer("POST", "/api/aujourdhui/fiche", { chemin, ...corps }, { "If-Match": etag, "X-Carnet-Requete": requete })
      .then((r) => lire<{ etag: string; cle: string; valeur: string | boolean | null; rejoue?: boolean }>(r)),
  /** Capture texte/lien vers la boîte de réception. `requete` : garder la même pour un renvoi (aucun doublon). */
  capturer: (c: { texte: string; lien?: string; titre?: string }, requete: string) =>
    envoyer("POST", "/api/capture", c, { "X-Carnet-Requete": requete }).then((r) => lire<{ chemin: string; id: string; etag: string; rejoue?: boolean }>(r)),
  boite: () => fetch("/api/boite").then((r) => lire<{ dossier: string; captures: Capture[] }>(r)),
  /** API du lot 3 : null si elle n'existe pas (section masquée). */
  decisionsEnAttente: () => facultatif<{ decisions: Decision[] }>("/api/decisions?statut=en%20attente"),
  nouveautes: () => facultatif<{ pages: Nouveaute[] }>("/api/nouveautes"),
};

// ---------------------------------------------------------------------------------------------
// V3 lot 2 « Bases » : bloc ```base, cellules, panneau « Propriétés »
// ---------------------------------------------------------------------------------------------

export interface ProprietePage {
  cle: string;
  /** Libellé donné par la base (displayName), sinon absent. */
  libelle?: string;
  etat: "valeur" | "anomalie";
  valeur?: ValeurBrute;
  raison?: string;
  /** Type déclaré par la base (declare: true) ou déduit de la valeur pour l'affichage. */
  type: TypePropriete | null;
  declare: boolean;
  options: string[] | null;
  horsListe?: boolean;
}

export interface ProprietesPage {
  chemin: string;
  /** Page absente de l'index (dossier sans page, renommage en cours) : rien à montrer. */
  absente?: boolean;
  etag: string;
  yamlInvalide: string | null;
  /** En-tête que Carnet refuse de modifier (ancre, alias, clé en double…) : raison, sinon null. */
  nonModifiable: string | null;
  proprietes: ProprietePage[];
  base: { page: string; titre: string; bloc: number } | null;
  declarations: Array<{ cle: string; type: TypePropriete; options: string[] | null }>;
}

export interface ChangementVueBase {
  tri?: Tri[] | null; ajouterFiltre?: string; retirerFiltre?: number;
  /** K14-01 : vues (un seul changement par requête). */
  nouvelleVue?: { nom: string; retablir?: EtatVueBase; filtres?: string[]; tri?: Tri[] }; dupliquerVue?: true; renommerVue?: string; supprimerVue?: true;
  /** Échéances : « Afficher dans Aujourd'hui » (null = ne plus afficher), seul dans sa requête. */
  aujourdhui?: DeclarationAujourdhuiBase | null;
}

/** Échéances : `carnet.aujourdhui` d'une base (clés du frontmatter). */
export interface DeclarationAujourdhuiBase { echeance: string; fait: { propriete: string; valeur: string | boolean }; priorite?: string | null }

/** Échéances : aperçu des fiches concernées (bloc réécrit, pas encore enregistré). */
export interface ApercuAujourdhui { fiches: number; enRetard: number; aujourdhui: number; aVenir: number; sansDate: number; faites: number; dossier: string | null }

/** K14-01 : filtres et tri d'une vue tels qu'écrits dans le YAML (clé absente = absente de l'objet). */
export interface EtatVueBase { filters?: unknown; sort?: unknown }

/** Réponse de POST /api/base/reecrire. */
export interface ReecritureBase {
  source: string; inchange: boolean;
  /** K14-01 : vue à montrer ensuite, nom créé ou renommé, vue de départ remise comme avant ou non (et pourquoi). */
  vue: number; nom?: string; retablie?: boolean; raisonNonRetablie?: string;
  avant: EtatVueBase | null; apres: EtatVueBase | null;
  /** Échéances : aperçu après « Afficher dans Aujourd'hui ». */
  apercu?: ApercuAujourdhui;
}

/** K10-01 : destination de rangement « Ajouter à <titre> » (page qui porte la base, dossier de ses entrées). */
export interface DestinationBase { titre: string; page: string; bloc: number; dossier: string; parent: string; icone: string | null }

export const apiBases = {
  base: (chemin: string, bloc: number, vue = 0) =>
    fetch(`/api/base?chemin=${q(chemin)}&bloc=${bloc}&vue=${vue}`).then((r) => lire<ResultatBase & { source: string }>(r)),
  evaluer: (chemin: string, source: string, vue: number) =>
    envoyer("POST", "/api/base/evaluer", { chemin, source, vue }).then((r) => lire<ResultatBase>(r)),
  reecrire: (source: string, vue: number, changement: ChangementVueBase, chemin?: string) =>
    envoyer("POST", "/api/base/reecrire", { source, vue, changement, ...(chemin ? { chemin } : {}) }).then((r) => lire<ReecritureBase>(r)),
  dossier: (page: string, nom: string) =>
    envoyer("POST", "/api/base/dossier", { page, nom }).then((r) => lire<{ dossier: string }>(r)),
  /** K10-01 : « Ajouter à <base> » : une destination par base au dossier des entrées connu (`parent` → api.deplacer). */
  destinations: () => fetch("/api/bases/destinations").then((r) => lire<{ destinations: DestinationBase[] }>(r)),
  /** Nouvelle entrée (page au nom unique) dans le dossier déclaré par le bloc. */
  entree: (page: string, source: string, titre: string, requete = nouvelleRequete()) =>
    envoyer("POST", "/api/base/entree", { page, source, titre }, { "X-Carnet-Requete": requete }).then((r) => lire<{ chemin: string; etag: string }>(r)),
  proprietes: (chemin: string) => fetch(`/api/proprietes?chemin=${q(chemin)}`).then((r) => lire<ProprietesPage>(r)),
  /** Pose (ou retire : `valeur` undefined) UNE propriété, à la révision `etag` ; 412 si le fichier a changé. */
  propriete: (chemin: string, cle: string, valeur: ValeurSaisie | undefined, etag: string,
    decl: { type?: TypePropriete | null; options?: string[] | null } = {}, requete = nouvelleRequete()) =>
    envoyer("POST", "/api/propriete", {
      chemin, cle, ...(valeur === undefined ? { retirer: true } : { valeur }), ...(decl.type ? { type: decl.type, options: decl.options ?? null } : {}),
    }, { "If-Match": etag, "X-Carnet-Requete": requete }).then((r) => lire<{ etag: string; contenu: string; inchange?: boolean }>(r)),
};

export function urlFichier(chemin: string): string {
  return `/api/fichier?chemin=${q(chemin)}`;
}

// ---------------------------------------------------------------------------------------------
// Lot 3 « Agents » : décisions, nouveautés, fichiers des agents, clés d'accès (ajouts groupés)
// ---------------------------------------------------------------------------------------------

export type EtatPreuve = "absente" | "valide" | "perimee" | "remplacee" | "indeterminee";
export type GesteDecision = "cle-d-acces" | "identite-seule";
export type ResultatDecision = "approuvée" | "à corriger" | "refusée";

export interface PreuveDecision {
  etat: EtatPreuve;
  demande: string | null;
  empreinte: string | null;
  resultat: string | null;
  portee: string | null;
  attestationId: string | null;
  geste: GesteDecision | null;
  /** Date de l'attestation qui fait foi (null sans attestation ; lot 3). */
  t?: string | null;
  /** Une ligne du journal des attestations a disparu après la dernière attestation de cette demande (lot 3). */
  journalCoupe?: boolean;
  /** Le statut écrit dans le fichier correspond-il au résultat attesté ? (null sans attestation) */
  declarationConforme?: boolean | null;
  /** Méthode d'empreinte (« carnet-proposition-v1 »). */
  methode?: string;
}

export interface ResumeDecision {
  chemin: string;
  titre: string;
  icone: string | null;
  id: string | null;
  /** Statut effectif calculé par le serveur (« en attente », résultat attesté, « incomplète »…). */
  statut: string;
  statut_declare: string | null;
  demandee_par: string | null;
  echeance: string | null;
  cree: string;
  mtime: number;
  preuve: { etat: EtatPreuve; resultat: string | null; geste: GesteDecision | null; t: string | null };
  derniere: { resultat: string | null; le: string | null; verification: string } | null;
  raison: string | null;
}

export interface EnregistrementDecision {
  ligne: number;
  demande: string | null;
  decision: string | null;
  resultat: string | null;
  par: string | null;
  le: string | null;
  empreinte: string | null;
  geste: string | null;
  commentaire: string;
  copie: string;
  verification: "attestee" | "remplacee" | "non-attestee";
  geste_atteste: string | null;
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
  bloquants: string[];
  manques: string[];
  /** K10-04 : rubriques requises pour approuver (objet, action demandée) absentes ou vides. */
  vides?: string[];
  decidable: boolean;
  /** K10-04 : « Approuver » possible (objet et action renseignés). Absent (ancien serveur) = comme `decidable`. */
  approuvable?: boolean;
  raison_approbation?: string | null;
  raison: string | null;
  preuve: PreuveDecision;
  enregistrements: EnregistrementDecision[];
  cles: { nombre: number; pourCetteAdresse: number };
}

export type EtatNouveaute = "modifiee" | "nouvelle" | "renommee" | "supprimee";

export interface Nouveaute {
  chemin: string;
  titre: string;
  icone: string | null;
  mtime: number;
  etat: EtatNouveaute;
  vers: string | null;
  auteur: string;
  maj_par_declare: string | null;
  motif_declare: string | null;
  etag: string | null;
  technique: boolean;
  modifiee?: boolean;
  vu_le: string | null;
  ajouts?: number;
  retraits?: number;
}

export interface DetailNouveaute extends Partial<Omit<Nouveaute, "etat">> {
  etat: EtatNouveaute | "a-jour" | "inconnue";
  depart: string;
  vu?: { etag: string; t: string; contenu: string | null } | null;
  actuel?: { etag: string; contenu: string } | null;
}

export interface CleAcces { id: string; nom: string; rpId: string; cree: string; utilisee: string | null; ici: boolean }

export const apiAgents = {
  decisions: (statut?: string) =>
    fetch(`/api/decisions${statut ? `?statut=${q(statut)}` : ""}`).then((r) => lire<{ decisions: ResumeDecision[] }>(r)),
  decision: (chemin: string) => fetch(`/api/decision?chemin=${q(chemin)}`).then((r) => lire<VueDecision>(r)),
  creerDecision: (titre: string, parent?: string) =>
    envoyer("POST", "/api/decisions", { titre, parent }).then((r) => lire<{ chemin: string; etag: string; id: string }>(r)),
  defiDecision: (corps: { chemin: string; demande: string; empreinte: string; resultat: ResultatDecision; commentaire: string }) =>
    envoyer("POST", "/api/decision/defi", corps).then((r) => lire<Record<string, unknown>>(r)),
  decider: (corps: Record<string, unknown>, requete: string) =>
    envoyer("POST", "/api/decision", corps, { "X-Carnet-Requete": requete }).then((r) => lire<{ etag: string; geste: GesteDecision; rejoue: boolean }>(r)),
  /** `compte` : seulement le nombre (léger, pour la barre latérale). */
  nouveautes: (techniques = false, compte = false) =>
    fetch(`/api/nouveautes?techniques=${techniques ? 1 : 0}${compte ? "&compte=1" : ""}`)
      .then((r) => lire<{ depart: string; pages: Nouveaute[]; techniques_masquees: number; nombre?: number }>(r)),
  nouveaute: (chemin: string) => fetch(`/api/nouveaute?chemin=${q(chemin)}`).then((r) => lire<DetailNouveaute>(r)),
  marquerVu: (pages: Array<{ chemin: string; etag: string | null; vers?: string | null; contenu?: string }>) =>
    envoyer("POST", "/api/nouveautes/vu", { pages }).then((r) => lire<{ marquees: string[]; restantes: string[] }>(r)),
  techniques: () => fetch("/api/techniques").then((r) => lire<{ regles: string }>(r)),
  cles: () => fetch("/api/cles").then((r) => lire<{ rpId: string; cles: CleAcces[]; enrolement: boolean }>(r)),
  defiCle: (code: string) => envoyer("POST", "/api/cles/defi", { code }).then((r) => lire<Record<string, unknown>>(r)),
  enregistrerCle: (corps: Record<string, unknown>) => envoyer("POST", "/api/cles", corps).then((r) => lire<{ id: string; nom: string }>(r)),
};

// ---------- V3 lot 5 « Fiabilité » : copie de conflit, retour à la version marquée vue, écritures indéterminées ----------

export interface ApercuRetour {
  chemin: string;
  titre: string;
  vu: { etag: string; t: string; contenu: string };
  actuel: { etag: string; contenu: string };
  bilan: { ajouts: number; retraits: number };
  /** Écritures de Carnet à ce chemin depuis la version vue (journal du socle). */
  ecritures: Array<{ t: string; principal: string; action: string; auteur_declare: string | null }>;
  /** La version actuelle n'a pas été écrite par Carnet (auteur non vérifié). */
  externe: boolean;
  /** Écritures faites par l'interface de Carnet depuis : présumées humaines, retirées aussi par le retour. */
  humaines: Array<{ t: string; principal: string; action: string }>;
  decision: { estDecision: boolean; attestationNeutralisee: boolean };
  /** Lots 5 × 6 : page archivée, qui le reste après le retour. */
  archive?: boolean;
}

export interface Indeterminee {
  id: string;
  chemin: string;
  action: string;
  t: string;
  vers: string | null;
  avant: string | null;
  apres: string | null;
  actuel: string | null;
  existe: boolean;
}

export const apiFiabilite = {
  /** Copie de conflit « <Page> (conflit AAAA-MM-JJ HHhMM).md » à côté de la page ; l'original n'est jamais touché. */
  copieConflit: (chemin: string, contenu: string, requete = nouvelleRequete()) =>
    envoyer("POST", "/api/page/conflit", { chemin, contenu }, { "X-Carnet-Requete": requete }).then((r) => lire<{ chemin: string; etag: string; retires?: Array<"archive" | "verrou"> }>(r)),
  apercuRetour: (chemin: string) => fetch(`/api/nouveautes/retour?chemin=${q(chemin)}`).then((r) => lire<ApercuRetour>(r)),
  /** `etag` : révision actuelle vue dans l'aperçu ; `vu` : version marquée vue de l'aperçu. Rien n'est écrit si l'une a changé. */
  retour: (corps: { chemin: string; etag: string; vu: string; humaines?: boolean }, requete: string) =>
    envoyer("POST", "/api/nouveautes/retour", corps, { "X-Carnet-Requete": requete })
      .then((r) => lire<{ etag: string; chemin: string; instantane: string | null; rejoue?: boolean }>(r)),
  indeterminees: () => fetch("/api/ecritures/indeterminees").then((r) => lire<{ elements: Indeterminee[] }>(r)),
  traiterIndeterminee: (id: string) =>
    envoyer("POST", "/api/ecritures/indeterminees/traiter", { id }).then((r) => lire<{ restantes: number }>(r)),
};

// ---------------------------------------------------------------------------------------------
// V3 lot 6 · modèles et journal (dossier « Modèles/ », journal du jour « Journal/AAAA-MM-JJ.md »)
// ---------------------------------------------------------------------------------------------

export interface Modele { chemin: string; titre: string; icone: string | null }
export interface ResultatJournal { chemin: string; date: string; cree: boolean; etag?: string }

export const apiModeles = {
  liste: () => fetch("/api/modeles").then((r) => lire<{ dossier: string; modeles: Modele[] }>(r)),
  /** Crée « titre » depuis le modèle (sous `parent` si donné) ; `requete` : identifiant du geste, gardé pour un renvoi. */
  creer: (modele: string, titre: string, parent: string | null, requete: string) =>
    envoyer("POST", "/api/page/modele", { modele, titre, parent }, { "X-Carnet-Requete": requete })
      .then((r) => lire<{ chemin: string; etag: string; rejoue?: boolean }>(r)),
  /** Journal du jour : créé une seule fois (depuis Modèles/Journal.md s'il existe), sinon ouvert tel quel. */
  journal: (requete = nouvelleRequete()) =>
    envoyer("POST", "/api/journal", {}, { "X-Carnet-Requete": requete }).then((r) => lire<ResultatJournal>(r)),
};
