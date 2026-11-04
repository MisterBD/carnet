// Carnet V3 · lot 5 « Fiabilité » : BROUILLONS DURABLES, hors de l'espace, dans ce navigateur.
//
// Toute saisie d'une page que le serveur n'a pas encore confirmée est gardée ici (IndexedDB, repli localStorage) :
// elle survit à un rechargement, à une coupure réseau, à un arrêt du serveur. Le fichier de l'espace n'est JAMAIS
// touché par un brouillon : seul un enregistrement confirmé par le serveur (PUT /api/page) l'écrit.
//
// Un brouillon par page : identifié par l'espace + le chemin, avec la RÉVISION DE BASE (etag de la version du fichier
// sur laquelle la saisie s'appuie) et l'identifiant d'idempotence du geste (`X-Carnet-Requete`), réutilisé tel quel
// pour chaque nouvel essai, y compris après un rechargement : une réponse perdue puis un renvoi = une seule écriture.
//
// Stockage : base IndexedDB « carnet-brouillons », magasin « brouillons » (clé `cle`). Repli : localStorage
// « carnet:brouillon:<cle> » (navigation privée, IndexedDB refusé). À la fermeture de l'onglet (pagehide), une copie
// SYNCHRONE part aussi dans localStorage (une écriture IndexedDB peut ne pas aboutir à ce moment-là) ; à la relecture,
// le plus récent des deux gagne.

// « refuse » (finale V3) : saisie REFUSÉE définitivement (page verrouillée, 423). Gardée à part (clé `cleRefus`), jamais
// renvoyée, jusqu'à ce que l'utilisateur la copie ou la jette explicitement (bandeau de la page, « Écritures en attente »).
export type EtatBrouillon = "en-attente" | "echec" | "conflit" | "refuse";

export interface Brouillon {
  /** `${espace}\u0000${chemin}\u0000${onglet}` (K11-02 : un brouillon par onglet ; ancien format sans onglet relu). */
  cle: string;
  /** K11-02 : onglet qui a fait la saisie (`ONGLET`) ; absent pour les brouillons d'avant la finale. */
  onglet?: string;
  espace: string;
  chemin: string;
  /** Révision (etag) du fichier sur laquelle la saisie s'appuie ; null = la page n'existait pas (création). */
  base: string | null;
  /** Contenu du fichier à la révision de base (pour comparer) ; null si inconnu. */
  original: string | null;
  /** Fichier complet à écrire (frontmatter, titre, corps). */
  contenu: string;
  /** Texte de l'éditeur (Markdown du corps), pour « Copier mon texte ». */
  texte: string;
  /** Identifiant d'idempotence du geste (X-Carnet-Requete), gardé à travers les essais et les rechargements. */
  requete: string;
  /** « Garder la mienne » demandé (le serveur garde alors la version écrasée en instantané). */
  ecraser: boolean;
  titre: string;
  /** Dernière modification du brouillon (ms). */
  t: number;
  etat: EtatBrouillon;
  /** Dernière erreur connue (texte pour l'écran). */
  erreur?: string;
}

const BASE = "carnet-brouillons";
const MAGASIN = "brouillons";
const PREFIXE_LS = "carnet:brouillon:";

// K11-02 (finale V3) : deux onglets sur la même page partageaient UNE clé ; l'enregistrement confirmé dans
// B retirait le brouillon de A (hors ligne), perdu au plantage de A. Chaque onglet a désormais son identifiant
// (sessionStorage : il survit au rechargement du MÊME onglet) et ses brouillons ; une confirmation ne retire que le
// brouillon de son onglet. Un brouillon d'un onglet disparu (fermé, planté) est « orphelin » : rouvrir la page
// l'adopte (une seule fois, si aucun onglet vivant ne le tient) ; « Écritures en attente » les liste tous.
function identifiantOnglet(): string {
  const nouveau = () => {
    try { if (typeof crypto !== "undefined" && "randomUUID" in crypto) return crypto.randomUUID().replace(/-/g, "").slice(0, 16); } catch { /* rien */ }
    return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
  };
  try {
    const x = sessionStorage.getItem("carnet:onglet");
    if (x) return x;
    const n = nouveau();
    sessionStorage.setItem("carnet:onglet", n);
    return n;
  } catch {
    return nouveau();
  }
}

/** Identifiant de CET onglet (stable au rechargement). */
export const ONGLET = identifiantOnglet();

export function cleBrouillon(espace: string, chemin: string, onglet: string = ONGLET): string {
  return `${espace}\u0000${chemin}\u0000${onglet}`;
}

/** Clé d'une saisie refusée (page verrouillée) : distincte du brouillon de la page, qu'une nouvelle saisie remplacerait. */
export function cleRefus(espace: string, chemin: string, onglet: string = ONGLET): string {
  return `${cleBrouillon(espace, chemin, onglet)}\u0000refus`;
}

// ---------- Onglets vivants (BroadcastChannel) : un brouillon tenu par un onglet ouvert n'est jamais adopté ----------
let canal: BroadcastChannel | null = null;
try {
  if (typeof BroadcastChannel !== "undefined") {
    canal = new BroadcastChannel("carnet-onglets");
    canal.onmessage = (e: MessageEvent) => {
      const m = e.data as { type?: string; id?: string };
      if (m && m.type === "qui") canal?.postMessage({ type: "present", id: m.id, onglet: ONGLET });
    };
  }
} catch { canal = null; }

/** Onglets de Carnet ouverts dans ce navigateur (celui-ci compris), ou null si on ne peut pas le savoir. */
export function ongletsVivants(delai = 250): Promise<Set<string> | null> {
  if (!canal) return Promise.resolve(null);
  return new Promise((resolve) => {
    const id = Math.random().toString(36).slice(2);
    const vus = new Set<string>([ONGLET]);
    let ecoute: BroadcastChannel | null = null;
    try {
      ecoute = new BroadcastChannel("carnet-onglets");
      ecoute.onmessage = (e: MessageEvent) => { const m = e.data as { type?: string; id?: string; onglet?: string }; if (m && m.type === "present" && m.id === id && m.onglet) vus.add(m.onglet); };
      canal!.postMessage({ type: "qui", id });
    } catch { resolve(null); return; }
    window.setTimeout(() => { try { ecoute?.close(); } catch { /* rien */ } resolve(vus); }, delai);
  });
}

/** Brouillons (à renvoyer, pas les refusés) de cette page laissés par un AUTRE onglet qui n'est plus ouvert. */
export async function orphelins(espace: string, chemin: string): Promise<{ orphelins: Brouillon[]; autresVivants: Brouillon[] }> {
  const tous = (await lister()).filter((b) => b.espace === espace && b.chemin === chemin && b.etat !== "refuse" && b.onglet !== ONGLET);
  if (!tous.length) return { orphelins: [], autresVivants: [] };
  const vivants = await ongletsVivants();
  if (vivants === null) return { orphelins: [], autresVivants: tous }; // inconnu : on n'adopte rien, on le signale
  return { orphelins: tous.filter((b) => !b.onglet || !vivants.has(b.onglet)), autresVivants: tous.filter((b) => b.onglet && vivants.has(b.onglet)) };
}

/** Adopte un brouillon orphelin dans cet onglet (même saisie, même identifiant de geste) ; l'ancienne entrée est retirée. */
export async function adopter(b: Brouillon): Promise<Brouillon> {
  const n: Brouillon = { ...b, cle: cleBrouillon(b.espace, b.chemin), onglet: ONGLET };
  await poser(n);
  if (b.cle !== n.cle) await retirerCle(b.cle);
  return n;
}

let ouverture: Promise<IDBDatabase | null> | null = null;

function ouvrir(): Promise<IDBDatabase | null> {
  if (ouverture) return ouverture;
  ouverture = new Promise<IDBDatabase | null>((resolve) => {
    try {
      if (typeof indexedDB === "undefined") { resolve(null); return; }
      const r = indexedDB.open(BASE, 1);
      const minuterie = window.setTimeout(() => resolve(null), 3000); // Safari : ouverture parfois bloquée
      r.onupgradeneeded = () => {
        if (!r.result.objectStoreNames.contains(MAGASIN)) r.result.createObjectStore(MAGASIN, { keyPath: "cle" });
      };
      r.onsuccess = () => { window.clearTimeout(minuterie); resolve(r.result); };
      r.onerror = () => { window.clearTimeout(minuterie); resolve(null); };
      r.onblocked = () => { window.clearTimeout(minuterie); resolve(null); };
    } catch {
      resolve(null);
    }
  });
  return ouverture;
}

function requeteIdb<T>(mode: IDBTransactionMode, f: (m: IDBObjectStore) => IDBRequest<T>): Promise<T | undefined> {
  return ouvrir().then((db) => new Promise<T | undefined>((resolve, reject) => {
    if (!db) { reject(new Error("IndexedDB indisponible")); return; }
    try {
      const tx = db.transaction(MAGASIN, mode);
      const r = f(tx.objectStore(MAGASIN));
      tx.oncomplete = () => resolve(r.result);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB"));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB"));
    } catch (e) {
      reject(e as Error);
    }
  }));
}

function valide(x: unknown): x is Brouillon {
  if (!x || typeof x !== "object") return false;
  const b = x as Record<string, unknown>;
  return typeof b.cle === "string" && typeof b.chemin === "string" && typeof b.contenu === "string" && typeof b.requete === "string"
    && typeof b.t === "number" && (b.base === null || typeof b.base === "string");
}

function lireLs(cle: string): Brouillon | null {
  try {
    const v = localStorage.getItem(PREFIXE_LS + cle);
    if (!v) return null;
    const b = JSON.parse(v);
    return valide(b) ? b : null;
  } catch {
    return null;
  }
}

function retirerLs(cle: string): void {
  try { localStorage.removeItem(PREFIXE_LS + cle); } catch { /* rien */ }
}

/** Écriture SYNCHRONE (localStorage) : fermeture de l'onglet, ou repli quand IndexedDB est indisponible. */
export function poserSync(b: Brouillon): boolean {
  try {
    localStorage.setItem(PREFIXE_LS + b.cle, JSON.stringify(b));
    return true;
  } catch {
    return false;
  }
}

/** Mémorise (ou remplace) le brouillon de la page. Ne lève jamais : vrai si gardé quelque part. */
export async function poser(b: Brouillon): Promise<boolean> {
  try {
    await requeteIdb("readwrite", (m) => m.put(b));
    // une copie de repli plus ancienne ne doit pas gagner à la relecture
    if (lireLs(b.cle)) retirerLs(b.cle);
    notifierChangement();
    return true;
  } catch {
    const ok = poserSync(b);
    notifierChangement();
    return ok;
  }
}

/** Brouillon de la page (le plus récent d'IndexedDB et de localStorage), ou null. */
export async function lire(espace: string, chemin: string): Promise<Brouillon | null> {
  return lireCle(cleBrouillon(espace, chemin));
}

/** Saisie refusée (page verrouillée) gardée pour cette page, ou null. */
export async function lireRefus(espace: string, chemin: string): Promise<Brouillon | null> {
  return lireCle(cleRefus(espace, chemin));
}

/** Garde une saisie refusée (page verrouillée) : jamais renvoyée, retirée seulement par un geste explicite. */
export async function poserRefus(b: Brouillon): Promise<boolean> {
  return poser({ ...b, cle: cleRefus(b.espace, b.chemin), onglet: ONGLET, etat: "refuse" });
}

/** Saisies refusées gardées pour cette page (tous onglets), la plus récente d'abord. */
export async function refusDe(espace: string, chemin: string): Promise<Brouillon[]> {
  return (await lister()).filter((b) => b.espace === espace && b.chemin === chemin && b.etat === "refuse");
}

/** Retire une entrée par sa clé exacte (brouillon ou saisie refusée), sur geste explicite. */
export async function retirerCle(cle: string): Promise<void> {
  try { await requeteIdb("readwrite", (m) => m.delete(cle)); } catch { /* rien */ }
  retirerLs(cle);
  notifierChangement();
}

async function lireCle(cle: string): Promise<Brouillon | null> {
  let idb: Brouillon | null = null;
  try {
    const x = await requeteIdb("readonly", (m) => m.get(cle));
    idb = valide(x) ? x : null;
  } catch { /* repli seul */ }
  const ls = lireLs(cle);
  if (idb && ls) return ls.t > idb.t ? ls : idb;
  return idb ?? ls;
}

/**
 * Retire le brouillon de la page. `requete` : seulement s'il s'agit toujours de ce geste (une saisie plus récente,
 * pas encore confirmée, est gardée).
 */
export async function retirer(espace: string, chemin: string, requete?: string): Promise<void> {
  const cle = cleBrouillon(espace, chemin);
  const actuel = requete ? await lire(espace, chemin) : null;
  if (requete && actuel && actuel.requete !== requete) return;
  try { await requeteIdb("readwrite", (m) => m.delete(cle)); } catch { /* rien */ }
  retirerLs(cle);
  notifierChangement();
}

/** Tous les brouillons de ce navigateur (tous espaces), du plus récent au plus ancien. */
export async function lister(): Promise<Brouillon[]> {
  const parCle = new Map<string, Brouillon>();
  try {
    const tous = await requeteIdb("readonly", (m) => m.getAll());
    for (const b of tous ?? []) if (valide(b)) parCle.set(b.cle, b);
  } catch { /* repli seul */ }
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(PREFIXE_LS)) continue;
      const b = lireLs(k.slice(PREFIXE_LS.length));
      if (!b) continue;
      const deja = parCle.get(b.cle);
      if (!deja || b.t > deja.t) parCle.set(b.cle, b);
    }
  } catch { /* rien */ }
  return [...parCle.values()].sort((a, b) => b.t - a.t);
}

function notifierChangement(): void {
  try { window.dispatchEvent(new Event("carnet:brouillons")); } catch { /* rien */ }
}
