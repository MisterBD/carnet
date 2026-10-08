// Client de l'API du serveur Carnet. Toute mutation porte l'en-tête X-Carnet (anti-CSRF).

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

export type Position = "avant" | "apres" | "dans";

export interface Page {
  chemin: string;
  contenu: string;
  etag: string | null;
  mtime: number;
  absente?: boolean;
  dossier?: boolean;
}

export interface Resultat {
  chemin: string;
  titre: string;
  icone: string | null;
  avant: string;
  extrait: string;
  apres: string;
  score: number;
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

function envoyer(methode: string, url: string, corps?: unknown, entetes: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: methode,
    headers: { ...ENTETES_MUTATION, "Content-Type": "application/json", ...entetes },
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

  ecrire: (chemin: string, contenu: string, etag: string | null) =>
    envoyer("PUT", `/api/page?chemin=${q(chemin)}`, { contenu }, etag ? { "If-Match": etag } : { "If-None-Match": "*" })
      .then((r) => lire<{ etag: string; mtime: number }>(r)),

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
    fetch(`/api/historique?chemin=${q(chemin)}`).then((r) => lire<{ git: boolean; versions: Version[] }>(r)),
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

  recherche: (texte: string, signal?: AbortSignal) =>
    fetch(`/api/recherche?q=${q(texte)}&limite=30`, { signal }).then((r) => lire<{ resultats: Resultat[] }>(r)),

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

  artefacts: () => fetch("/api/artefacts").then((r) => lire<{ artefacts: Array<{ chemin: string; titre: string; date?: string }> }>(r)),
};

export function urlFichier(chemin: string): string {
  return `/api/fichier?chemin=${q(chemin)}`;
}
