import { trace } from "./outils";
// Événements en direct (SSE) : une seule connexion pour toute l'appli, relancée automatiquement.
export type Evenement =
  | { type: "modif"; chemin: string; etag: string }
  | { type: "arbre"; version?: number }
  | { type: "connexion"; etat: "ouverte" | "perdue" };

type Auditeur = (e: Evenement) => void;
const auditeurs = new Set<Auditeur>();
let source: EventSource | null = null;
let attente = 1000;

function emettre(e: Evenement) {
  auditeurs.forEach((f) => { try { f(e); } catch (err) { console.warn(err); } });
}

function ouvrir() {
  source = new EventSource("/api/evenements");
  source.onopen = () => { attente = 1000; trace("sse ouvert"); emettre({ type: "connexion", etat: "ouverte" }); };
  source.onmessage = (m) => {
    try {
      const d = JSON.parse(m.data);
      if (d && (d.type === "modif" || d.type === "arbre")) emettre(d);
    } catch { /* ignoré */ }
  };
  source.onerror = () => {
    trace("sse erreur", source?.readyState);
    emettre({ type: "connexion", etat: "perdue" });
    if (source && source.readyState === EventSource.CLOSED) {
      source = null;
      window.setTimeout(ouvrir, attente);
      attente = Math.min(attente * 2, 30000);
    }
  };
}

export function ecouter(f: Auditeur): () => void {
  auditeurs.add(f);
  if (!source) ouvrir();
  return () => { auditeurs.delete(f); };
}

// Retour au premier plan (iPhone) : on relance si la connexion est tombée.
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && (!source || source.readyState === EventSource.CLOSED)) {
    source?.close();
    source = null;
    ouvrir();
    emettre({ type: "arbre" });
  }
});
