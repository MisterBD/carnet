// Routes : « / » Aujourd'hui (l'accueil de l'appli, distinct de la page Accueil.md), « /boite » (boîte de réception), « /p/<chemin de page sans .md> », « /f/<fichier> », « /projets », « /corbeille »,
// « /h/<chemin de page sans .md> » (historique des versions d'une page), « /prep/<chemin de fiche sans .md> » (dossier de
// rendez-vous, lot 11).
// L'historique du navigateur porte une profondeur (`carnet`) : le bouton retour de l'en-tête sait s'il peut revenir
// en arrière dans Carnet (appli installée sur l'iPhone : pas de bouton retour de Safari) ou s'il doit remonter au parent.
import { useEffect, useState } from "react";

export type Route =
  | { vue: "accueil" }
  | { vue: "page"; chemin: string }
  | { vue: "fichier"; chemin: string }
  | { vue: "projets" }
  | { vue: "missions" } // lot 10
  | { vue: "corbeille" }
  | { vue: "boite" }
  | { vue: "historique"; chemin: string }
  // lot 3 « Agents »
  | { vue: "decisions" }
  | { vue: "nouveautes" }
  | { vue: "cles" }
  // lot 5 « Fiabilité »
  | { vue: "attente" }
  // lot 6 « Pages » : ouvre (et crée au besoin) le journal du jour, puis remplace l'adresse par la page
  | { vue: "journal" }
  // lot 11 « Dossier de rendez-vous »
  | { vue: "preparation"; chemin: string };

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
  if (chemin.startsWith("/prep/")) {
    const nom = segments(chemin.slice(6));
    return nom ? { vue: "preparation", chemin: nom.normalize("NFC") + ".md" } : { vue: "accueil" };
  }
  if (chemin.startsWith("/f/")) return { vue: "fichier", chemin: segments(chemin.slice(3)).normalize("NFC") };
  if (chemin === "/projets") return { vue: "projets" };
  if (chemin === "/missions") return { vue: "missions" }; // lot 10
  if (chemin === "/corbeille") return { vue: "corbeille" };
  if (chemin === "/boite") return { vue: "boite" };
  if (chemin === "/decisions") return { vue: "decisions" };
  if (chemin === "/nouveautes") return { vue: "nouveautes" };
  if (chemin === "/cles") return { vue: "cles" };
  if (chemin === "/attente") return { vue: "attente" };
  if (chemin === "/journal") return { vue: "journal" };
  return { vue: "accueil" };
}

export function urlDe(route: Route): string {
  const enc = (c: string) => c.split("/").map(encodeURIComponent).join("/");
  switch (route.vue) {
    case "page": return "/p/" + enc(route.chemin.replace(/\.md$/i, ""));
    case "historique": return "/h/" + enc(route.chemin.replace(/\.md$/i, ""));
    case "preparation": return "/prep/" + enc(route.chemin.replace(/\.md$/i, ""));
    case "fichier": return "/f/" + enc(route.chemin);
    case "projets": return "/projets";
    case "missions": return "/missions"; // lot 10
    case "corbeille": return "/corbeille";
    case "boite": return "/boite";
    case "decisions": return "/decisions";
    case "nouveautes": return "/nouveautes";
    case "cles": return "/cles";
    case "attente": return "/attente";
    case "journal": return "/journal";
    default: return "/";
  }
}

const auditeurs = new Set<() => void>();

function profondeur(): number {
  const s = history.state as { carnet?: number } | null;
  return typeof s?.carnet === "number" ? s.carnet : 0;
}

/**
 * Ouvre une route. `ancre` (titre visé par un lien [[Page#Titre]], #5) est portée dans l'adresse (« #Cette%20semaine ») :
 * la page y défile une fois affichée. Même page avec une ancre : on défile sans recharger (événement `carnet:ancre`).
 */
export function naviguer(route: Route, remplacer = false, ancre: string | null = null): void {
  const url = urlDe(route);
  const diese = ancre ? "#" + encodeURIComponent(ancre) : "";
  if (url === location.pathname) {
    if (diese && decodeURIComponent(location.hash) !== decodeURIComponent(diese)) {
      history.pushState({ carnet: profondeur() + 1 }, "", url + diese);
    }
    if (diese) window.dispatchEvent(new CustomEvent("carnet:ancre", { detail: ancre }));
    return;
  }
  if (remplacer) history.replaceState({ carnet: profondeur() }, "", url + diese);
  else history.pushState({ carnet: profondeur() + 1 }, "", url + diese);
  noterRoute(route);
  auditeurs.forEach((f) => f());
}

/** Ancre de l'adresse courante (« Cette semaine »), ou null. */
export function ancreCourante(): string | null {
  if (!location.hash || location.hash === "#") return null;
  try { return decodeURIComponent(location.hash.slice(1)); } catch { return location.hash.slice(1); }
}

// ---------------------------------------------------------------------------------------------
// Instance de la page ouverte (K2-02) : un renommage depuis le titre garde la même vue (même éditeur, même curseur,
// même file d'enregistrement) ; seule l'adresse change. Toute autre navigation crée une vue neuve.
// ---------------------------------------------------------------------------------------------

let instance: { cle: string; chemin: string } | null = null;
let generation = 0;

/** Clé React de la vue d'une page : stable tant que la page reste ouverte, même renommée sur place. */
export function clePage(chemin: string): string {
  if (instance && instance.chemin === chemin) return instance.cle;
  instance = { cle: `${chemin}\u0001${++generation}`, chemin };
  return instance.cle;
}

/** La page ouverte `ancien` vient d'être renommée en `nouveau` par sa propre vue : la vue est gardée. */
export function renommerSurPlace(ancien: string, nouveau: string): void {
  if (instance && instance.chemin === ancien) instance.chemin = nouveau;
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
