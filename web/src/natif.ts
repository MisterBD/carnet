// Carnet V3 · lot 9 « iOS » : pont avec l'app iOS « Carnet » (coquille native qui affiche cette interface).
//
// Actif SEULEMENT dans l'app : User-Agent contenant « CarnetiOS/<version> » ET gestionnaire natif présent
// (window.webkit.messageHandlers.carnet). Partout ailleurs, ce module n'est même pas chargé (voir main.tsx).
//
// Rôle (V1, sans jeton d'appareil) : l'extension de partage d'iOS range chaque capture dans une file sur l'iPhone, sans
// réseau. Quand cette page est chargée dans l'app, le natif lui confie les captures en attente
// (window.carnetNatif.recevoirCaptures) ; on les envoie une à une à POST /api/capture, en même origine, avec
// X-Carnet-Requete = identifiant de la capture (le serveur dédoublonne : un renvoi ne crée jamais de seconde page),
// puis on acquitte chacune. Le natif ne supprime un fichier qu'après acquittement.
//
// Messages vers le natif (deux types, rien d'autre) :
//   { type: "etat", pret: true }                         module prêt (une fois par chargement de page)
//   { type: "etat", pret: true, lot: <n> }               lot n traité (les captures non acquittées repartiront)
//   { type: "acquitte", id: "<uuid>", resultat: "enregistre" | "refuse" }

export type ResultatEnvoi = "enregistre" | "refuse" | "reessayer";

/** Capture telle que le natif la confie (champs du fichier JSON de la file, voir ios/CarnetKit). */
export interface CaptureNative {
  id: string;
  cree: string;
  texte: string;
  lien?: string;
  titre?: string;
}

export type MessageNatif =
  | { type: "etat"; pret: boolean; lot?: number }
  | { type: "acquitte"; id: string; resultat: "enregistre" | "refuse" };

export interface Dependances {
  envoyer: (c: CaptureNative) => Promise<ResultatEnvoi>;
  poster: (m: MessageNatif) => void;
}

export interface Bilan {
  enregistrees: number;
  refusees: number;
  enEchec: number;
}

const RE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_LOT = 50;
const MAX_TEXTE = 200_000;
const MAX_LIEN = 2048;

export function estAppIos(ua: string): boolean {
  return /(^|\s)CarnetiOS\/\d/.test(ua);
}

/** Adresse http(s) que le serveur accepte comme `lien` (sinon elle va dans le texte). */
export function estLienWeb(s: string): boolean {
  if (!s || s.length > MAX_LIEN || /[\s\u0000-\u001f\u007f]/.test(s)) return false;
  try {
    const u = new URL(s);
    return (u.protocol === "http:" || u.protocol === "https:") && u.host !== "";
  } catch {
    return false;
  }
}

/** Capture venue du natif, vérifiée ; null si elle n'est pas conforme (ni envoyée ni acquittée : le fichier reste). */
export function lireCapture(v: unknown): CaptureNative | null {
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "string" || !RE_ID.test(o.id)) return null;
  if (typeof o.texte !== "string" || o.texte.length > MAX_TEXTE) return null;
  if (typeof o.cree !== "string") return null;
  if (o.lien !== undefined && o.lien !== null && typeof o.lien !== "string") return null;
  if (o.titre !== undefined && o.titre !== null && typeof o.titre !== "string") return null;
  const c: CaptureNative = { id: o.id, cree: o.cree, texte: o.texte };
  if (typeof o.lien === "string" && o.lien) c.lien = o.lien;
  if (typeof o.titre === "string" && o.titre) c.titre = o.titre;
  if (!c.texte.trim() && !c.lien) return null;
  return c;
}

/** Corps de POST /api/capture (lot 1 « Aujourd'hui ») : { texte, lien?, titre? }. */
export function corpsCapture(c: CaptureNative): { texte: string; lien?: string; titre?: string } {
  let texte = c.texte;
  const corps: { texte: string; lien?: string; titre?: string } = { texte };
  if (c.lien) {
    if (estLienWeb(c.lien)) corps.lien = c.lien;
    else if (!texte.includes(c.lien)) texte = texte.trim() ? `${texte}\n\n${c.lien}` : c.lien;
  }
  corps.texte = texte;
  if (c.titre) corps.titre = c.titre;
  return corps;
}

/**
 * Réponse du serveur → suite à donner. 201 (créée) et 200 (déjà reçue, rejeu) : acquitter. 400, 409, 413, 422 :
 * refus définitif (le natif met la capture de côté, sans la supprimer). Le reste (réseau, 403 d'identité, 404 d'un
 * serveur sans la route, 429, 5xx) : réessayer plus tard.
 */
export function classerStatut(statut: number): ResultatEnvoi {
  if (statut === 200 || statut === 201) return "enregistre";
  if (statut === 400 || statut === 409 || statut === 413 || statut === 422) return "refuse";
  return "reessayer";
}

/** L'appel à la route de capture, isolé ici : seul endroit à changer si la route évolue. */
export async function envoyerCaptureServeur(c: CaptureNative, f: typeof fetch = fetch): Promise<ResultatEnvoi> {
  try {
    const r = await f("/api/capture", {
      method: "POST",
      headers: { "X-Carnet": "1", "X-Carnet-Requete": c.id, "Content-Type": "application/json" },
      body: JSON.stringify(corpsCapture(c)),
      credentials: "same-origin",
    });
    return classerStatut(r.status);
  } catch {
    return "reessayer";
  }
}

/**
 * Traite un lot confié par le natif ({ lot, captures }) : envois dans l'ordre, un acquittement par réponse définitive,
 * puis fin de lot. Au premier échec passager (serveur injoignable…), on n'insiste pas sur les suivantes.
 */
export async function traiterLot(charge: unknown, deps: Dependances): Promise<Bilan> {
  const o = (typeof charge === "object" && charge !== null ? charge : {}) as Record<string, unknown>;
  const lot = typeof o.lot === "number" && Number.isInteger(o.lot) && o.lot > 0 ? o.lot : null;
  const liste = Array.isArray(o.captures) ? o.captures.slice(0, MAX_LOT) : [];
  const bilan: Bilan = { enregistrees: 0, refusees: 0, enEchec: 0 };
  let panne = false;
  for (const brut of liste) {
    const c = lireCapture(brut);
    if (!c || panne) {
      bilan.enEchec++;
      continue;
    }
    const r = await deps.envoyer(c);
    if (r === "reessayer") {
      bilan.enEchec++;
      panne = true;
      continue;
    }
    deps.poster({ type: "acquitte", id: c.id, resultat: r });
    if (r === "enregistre") bilan.enregistrees++;
    else bilan.refusees++;
  }
  if (lot !== null) deps.poster({ type: "etat", pret: true, lot });
  return bilan;
}

interface FenetreNative {
  navigator: { userAgent: string };
  fetch: typeof fetch;
  webkit?: { messageHandlers?: { carnet?: { postMessage: (m: unknown) => void } } };
  carnetNatif?: unknown;
  dispatchEvent?: (e: Event) => boolean;
}

/**
 * Installe window.carnetNatif (non modifiable) et annonce au natif que la page est prête. Ne fait rien hors de l'app.
 * Après des captures enregistrées, émet l'évènement « carnet:captures » (detail = bilan) pour qui veut rafraîchir.
 */
export function installerPontNatif(fenetre: unknown = globalThis): boolean {
  const w = fenetre as FenetreNative;
  if (!estAppIos(w.navigator?.userAgent ?? "")) return false;
  const gestionnaire = w.webkit?.messageHandlers?.carnet;
  if (!gestionnaire || typeof gestionnaire.postMessage !== "function") return false;
  if (w.carnetNatif !== undefined) return true;
  const poster = (m: MessageNatif) => {
    try {
      gestionnaire.postMessage(m);
    } catch {
      /* natif indisponible : rien n'est perdu, la capture reste dans la file */
    }
  };
  const deps: Dependances = { envoyer: (c) => envoyerCaptureServeur(c, (...a) => w.fetch(...a)), poster };
  let chaine: Promise<void> = Promise.resolve();
  const api = Object.freeze({
    recevoirCaptures(charge: unknown): Promise<void> {
      chaine = chaine
        .then(() => traiterLot(charge, deps))
        .then((bilan) => {
          if (bilan.enregistrees > 0 && typeof w.dispatchEvent === "function" && typeof CustomEvent === "function") {
            w.dispatchEvent(new CustomEvent("carnet:captures", { detail: bilan }));
          }
        })
        .catch(() => undefined);
      return chaine;
    },
  });
  Object.defineProperty(w, "carnetNatif", { value: api, writable: false, configurable: false, enumerable: false });
  poster({ type: "etat", pret: true });
  return true;
}
