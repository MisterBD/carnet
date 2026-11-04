// Carnet · vie de l'appli installée : état du réseau, mise à jour du service worker, geste « retour » du tiroir.
// Rien ici ne lit ni ne garde de contenu de note : seulement des signaux (joignable ou non).
import { useCallback, useEffect, useRef, useState } from "react";
import { ErreurApi } from "./api";
import { ecouter } from "./evenements";

// ---------------------------------------------------------------------------------------------
// Pannes : ce que l'on dit à l'utilisateur quand le carnet ne répond pas
// ---------------------------------------------------------------------------------------------

export type Panne =
  | { genre: "reseau" }                    // aucune réponse : réseau privé (VPN) coupé, avion, serveur arrêté
  | { genre: "acces" }                     // 403 : pas d'identité posée par le proxy (mauvaise adresse, mauvais compte)
  | { genre: "serveur"; statut: number }   // le serveur répond, mal (502 du proxy, 500…)
  | { genre: "inconnue"; message: string };

// ---------------------------------------------------------------------------------------------
// Aide de connexion : le réseau privé à allumer (CARNET_RESEAU, ex. « Tailscale ») et qui prévenir (CARNET_CONTACT).
// Retenue dans le navigateur à chaque démarrage réussi : l'écran hors ligne doit pouvoir la citer quand le serveur
// ne répond plus (et l'écran de repli du service worker, public/hors-ligne.html, la lit aussi). Rien d'autre n'est gardé.
// ---------------------------------------------------------------------------------------------

export interface AideConnexion { reseau: string | null; contact: string | null }
const CLE_AIDE = "carnet:aide-connexion";

export function retenirAideConnexion(a: AideConnexion): void {
  try {
    if (a.reseau || a.contact) localStorage.setItem(CLE_AIDE, JSON.stringify({ reseau: a.reseau || null, contact: a.contact || null }));
    else localStorage.removeItem(CLE_AIDE);
  } catch { /* navigation privée */ }
}

export function aideConnexion(): AideConnexion {
  try {
    const x = JSON.parse(localStorage.getItem(CLE_AIDE) ?? "null") as Partial<AideConnexion> | null;
    const propre = (v: unknown) => (typeof v === "string" && /^[\p{L}\p{N}][\p{L}\p{N} '’.-]{0,39}$/u.test(v) ? v : null);
    return { reseau: propre(x?.reseau), contact: propre(x?.contact) };
  } catch {
    return { reseau: null, contact: null };
  }
}

export function classerErreur(e: unknown): Panne {
  if (e instanceof ErreurApi) {
    if (e.statut === 403) return { genre: "acces" };
    if (e.statut >= 500 || e.statut === 421) return { genre: "serveur", statut: e.statut };
    return { genre: "inconnue", message: e.message };
  }
  // fetch() qui échoue sans réponse : TypeError (« Failed to fetch » Chromium, « Load failed » Safari, « NetworkError… » Firefox)
  if (e instanceof TypeError || (e instanceof DOMException && (e.name === "AbortError" || e.name === "NetworkError"))) return { genre: "reseau" };
  return { genre: "inconnue", message: e instanceof Error ? e.message : String(e) };
}

/** Le serveur répond-il ? `/sante` ne demande pas d'identité. « mauvais » = il répond, mais pas 200. */
export async function sonderServeur(delaiMs = 6000): Promise<"ok" | "mauvais" | "injoignable"> {
  const ctl = new AbortController();
  const t = window.setTimeout(() => ctl.abort(), delaiMs);
  try {
    const r = await fetch("/sante", { cache: "no-store", signal: ctl.signal });
    return r.ok ? "ok" : "mauvais";
  } catch {
    return "injoignable";
  } finally {
    window.clearTimeout(t);
  }
}

// ---------------------------------------------------------------------------------------------
// Réseau en cours d'usage : « hors ligne » si le navigateur le dit OU si le flux en direct est perdu depuis un moment
// (réseau privé coupé alors que le Wi-Fi marche : navigator.onLine reste vrai, seul le flux tombe).
// ---------------------------------------------------------------------------------------------

export type EtatReseau = "ok" | "hors" | "retour";

export function useReseau(): { etat: EtatReseau; reessayer: () => Promise<void> } {
  const [etat, setEtat] = useState<EtatReseau>("ok");
  const hors = useRef(false);
  const minuterie = useRef<number | null>(null);
  const retour = useRef<number | null>(null);

  const perdu = useCallback(() => {
    if (hors.current || minuterie.current) return;
    // on laisse 2,5 s : un flux qui se reconnecte aussitôt ne doit pas faire clignoter l'écran
    minuterie.current = window.setTimeout(() => {
      minuterie.current = null;
      hors.current = true;
      setEtat("hors");
    }, 2500);
  }, []);

  const retrouve = useCallback(() => {
    if (minuterie.current) { window.clearTimeout(minuterie.current); minuterie.current = null; }
    if (!hors.current) return;
    hors.current = false;
    setEtat("retour");
    if (retour.current) window.clearTimeout(retour.current);
    retour.current = window.setTimeout(() => setEtat((e) => (e === "retour" ? "ok" : e)), 2200);
  }, []);

  useEffect(() => {
    const off = ecouter((e) => {
      if (e.type === "connexion") (e.etat === "perdue" ? perdu : retrouve)();
    });
    const surOffline = () => perdu();
    const surOnline = () => { void sonderServeur(4000).then((r) => { if (r === "ok") retrouve(); }); };
    window.addEventListener("offline", surOffline);
    window.addEventListener("online", surOnline);
    if (!navigator.onLine) perdu();
    return () => {
      off();
      window.removeEventListener("offline", surOffline);
      window.removeEventListener("online", surOnline);
      if (minuterie.current) window.clearTimeout(minuterie.current);
      if (retour.current) window.clearTimeout(retour.current);
    };
  }, [perdu, retrouve]);

  const reessayer = useCallback(async () => {
    if ((await sonderServeur()) === "ok") retrouve();
  }, [retrouve]);

  return { etat, reessayer };
}

// ---------------------------------------------------------------------------------------------
// Service worker : on vérifie s'il y a une nouvelle version chaque fois que l'appli revient au premier plan
// (une appli installée sur iPhone reste ouverte des jours, sans jamais « recharger »).
// ---------------------------------------------------------------------------------------------

export function useMiseAJourServiceWorker(): void {
  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;
    const f = () => {
      if (document.visibilityState !== "visible") return;
      navigator.serviceWorker.getRegistration().then((r) => r?.update()).catch(() => { /* hors ligne : tant pis */ });
    };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, []);
}

// ---------------------------------------------------------------------------------------------
// Geste « retour » : sur iPhone installé, glisser depuis le bord gauche fait « page précédente ». Avec le tiroir ouvert,
// il doit seulement le refermer. Le tiroir pose donc une entrée d'historique à l'ouverture (même adresse).
// Si le tiroir se ferme autrement (voile, choix d'une page), l'entrée est retirée, ou sautée si une navigation l'a
// laissée derrière elle : un seul « retour » ramène toujours à la page d'avant.
// ---------------------------------------------------------------------------------------------

export function useGesteRetourTiroir(ouvert: boolean, fermer: () => void): void {
  const posee = useRef(false);
  const fermerRef = useRef(fermer);
  fermerRef.current = fermer;

  useEffect(() => {
    if (ouvert && !posee.current) {
      try { history.pushState({ ...(history.state ?? {}), carnetTiroir: true }, ""); posee.current = true; } catch { /* sans historique */ }
    } else if (!ouvert && posee.current) {
      posee.current = false;
      if (history.state?.carnetTiroir) history.back();
    }
  }, [ouvert]);

  useEffect(() => {
    const f = (e: PopStateEvent) => {
      const tiroir = Boolean(e.state?.carnetTiroir);
      if (posee.current && !tiroir) { posee.current = false; fermerRef.current(); }
      else if (!posee.current && tiroir) history.back(); // entrée orpheline : on la saute
    };
    window.addEventListener("popstate", f);
    return () => window.removeEventListener("popstate", f);
  }, []);
}
