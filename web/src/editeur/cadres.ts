// Registre des cadres isolés (artefacts, rendus Mermaid / Vega-Lite servis par le serveur d'artefacts).
// Un message n'est accepté que s'il vient de la fenêtre du cadre (event.source), jamais d'après event.origin
// (les cadres sandbox ont une origine opaque « null »).
type Gestion = (donnees: Record<string, unknown>) => void;
interface Cadre { iframe: HTMLIFrameElement; f: Gestion }

const cadres = new Set<Cadre>();
let theme: "clair" | "sombre" = "clair";

window.addEventListener("message", (e) => {
  if (!e.data || typeof e.data !== "object") return;
  for (const c of cadres) {
    if (c.iframe.contentWindow && e.source === c.iframe.contentWindow) {
      c.f(e.data as Record<string, unknown>);
      return;
    }
  }
});

export function enregistrerCadre(iframe: HTMLIFrameElement, f: Gestion): () => void {
  const c = { iframe, f };
  cadres.add(c);
  return () => { cadres.delete(c); };
}

export function themeCadres(): "clair" | "sombre" {
  return theme;
}

export function diffuserTheme(t: "clair" | "sombre"): void {
  theme = t;
  for (const c of cadres) {
    try { c.iframe.contentWindow?.postMessage({ type: "hote:theme", theme: t }, "*"); } catch { /* cadre en cours de chargement */ }
  }
}

/** Retire du registre les cadres qui ne sont plus dans le document (pages fermées). */
export function nettoyerCadres(): void {
  for (const c of cadres) if (!c.iframe.isConnected) cadres.delete(c);
}
