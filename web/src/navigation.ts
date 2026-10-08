// Routes : « / » accueil, « /p/<chemin de page sans .md> », « /f/<fichier> », « /projets », « /corbeille »,
// « /h/<chemin de page sans .md> » (historique des versions d'une page).
// L'historique du navigateur porte une profondeur (`carnet`) : le bouton retour de l'en-tête sait s'il peut revenir
// en arrière dans Carnet (appli installée sur l'iPhone : pas de bouton retour de Safari) ou s'il doit remonter au parent.
import { useEffect, useState } from "react";

export type Route =
  | { vue: "accueil" }
  | { vue: "page"; chemin: string }
  | { vue: "fichier"; chemin: string }
  | { vue: "projets" }
  | { vue: "corbeille" }
  | { vue: "historique"; chemin: string };

function segments(s: string): string {
  return s.split("/").filter(Boolean).map((x) => { try { return decodeURIComponent(x); } catch { return x; } }).join("/");
}

export function lireRoute(chemin = location.pathname): Route {
  if (chemin.startsWith("/p/")) {
    const nom = segments(chemin.slice(3));
    return nom ? { vue: "page", chemin: nom.normalize("NFC") + ".md" } : { vue: "accueil" };
  }
  if (chemin.startsWith("/h/")) {
    const nom = segments(chemin.slice(3));
    return nom ? { vue: "historique", chemin: nom.normalize("NFC") + ".md" } : { vue: "accueil" };
  }
  if (chemin.startsWith("/f/")) return { vue: "fichier", chemin: segments(chemin.slice(3)).normalize("NFC") };
  if (chemin === "/projets") return { vue: "projets" };
  if (chemin === "/corbeille") return { vue: "corbeille" };
  return { vue: "accueil" };
}

export function urlDe(route: Route): string {
  const enc = (c: string) => c.split("/").map(encodeURIComponent).join("/");
  switch (route.vue) {
    case "page": return "/p/" + enc(route.chemin.replace(/\.md$/i, ""));
    case "historique": return "/h/" + enc(route.chemin.replace(/\.md$/i, ""));
    case "fichier": return "/f/" + enc(route.chemin);
    case "projets": return "/projets";
    case "corbeille": return "/corbeille";
    default: return "/";
  }
}

const auditeurs = new Set<() => void>();

function profondeur(): number {
  const s = history.state as { carnet?: number } | null;
  return typeof s?.carnet === "number" ? s.carnet : 0;
}

export function naviguer(route: Route, remplacer = false): void {
  const url = urlDe(route);
  if (url === location.pathname) return;
  if (remplacer) history.replaceState({ carnet: profondeur() }, "", url);
  else history.pushState({ carnet: profondeur() + 1 }, "", url);
  noterRoute(route);
  auditeurs.forEach((f) => f());
}

/** Une page précédente de Carnet existe dans l'historique du navigateur (pas une autre page web). */
export function peutRevenir(): boolean {
  return profondeur() > 0;
}

window.addEventListener("popstate", () => {
  noterRoute(lireRoute());
  auditeurs.forEach((f) => f());
});

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => lireRoute());
  useEffect(() => {
    const f = () => setRoute(lireRoute());
    auditeurs.add(f);
    return () => { auditeurs.delete(f); };
  }, []);
  return route;
}

/** Clic sur un lien interne : navigation sans recharger (garde ⌘/Ctrl-clic pour un nouvel onglet). */
export function surLienInterne(e: React.MouseEvent, route: Route, avant?: () => void): void {
  if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  avant?.();
  naviguer(route);
}

// ---------------------------------------------------------------------------------------------
// Pages consultées récemment (⌘K à vide) : gardées dans le navigateur, jamais dans les fichiers.
// ---------------------------------------------------------------------------------------------

const CLE_RECENTES = "carnet:recentes";
const MAX_RECENTES = 20;

export function pagesRecentes(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CLE_RECENTES) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_RECENTES) : [];
  } catch {
    return [];
  }
}

function noterRoute(route: Route): void {
  if (route.vue !== "page") return;
  try {
    const l = [route.chemin, ...pagesRecentes().filter((c) => c !== route.chemin)].slice(0, MAX_RECENTES);
    localStorage.setItem(CLE_RECENTES, JSON.stringify(l));
  } catch { /* navigation privée */ }
}

/** Après un renommage ou un déplacement : les récentes suivent la page. */
export function renommerRecentes(f: (chemin: string) => string | null): void {
  try {
    const l = pagesRecentes().map(f).filter((c): c is string => c !== null);
    localStorage.setItem(CLE_RECENTES, JSON.stringify([...new Set(l)]));
  } catch { /* navigation privée */ }
}

noterRoute(lireRoute());
if (!history.state || typeof (history.state as { carnet?: number }).carnet !== "number") {
  try { history.replaceState({ ...(history.state ?? {}), carnet: 0 }, ""); } catch { /* bac à sable */ }
}
