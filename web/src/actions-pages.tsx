// Carnet · actions sur les pages (chantier « navigation ») : nouvelle page sans dialogue (« Sans titre », curseur
// dans le titre), menu « … » ancré, renommer (une seule entrée : le titre), dupliquer, déplacer, monter / descendre,
// copier le lien, historique, imprimer, corbeille sans confirmation avec « Annuler » pendant 8 s.
// Branché dans App.tsx par `useActionsPages` (les fonctions restent stables : l'état courant est lu dans une réf).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown, ArrowUp, Copy, FilePlus, FolderInput, History, Link2, Pencil, Printer, Star, StarOff, Trash2,
} from "lucide-react";
import { api, type Noeud, type Position } from "./api";
import type { OptionsConfirmation, OptionsTexte } from "./contexte-app";
import { naviguer, renommerRecentes, urlDe, type Route } from "./navigation";
import { MenuPage, type ElementMenu } from "./composants/MenuPage";
import { tactile } from "./outils";
import { dossierDe, feuille, nomDePage } from "../../shared/page.ts";

export interface DependancesPages {
  route: Route;
  arbre: Noeud[];
  index: Map<string, Noeud>;
  favoris: string[];
  setFavoris: (f: (l: string[]) => string[]) => void;
  basculerFavori(chemin: string): void;
  basculer(chemin: string, ouvrir?: boolean): void;
  rechargerArbre(): Promise<void>;
  notifier(message: string, action?: { libelle: string; faire: () => void }, duree?: number): void;
  demanderTexte(o: OptionsTexte): Promise<string | null>;
  confirmer(o: OptionsConfirmation): Promise<boolean>;
  choisirPage(o?: { titre?: string; exclure?: string }): Promise<string | null>;
  fermerTiroir(): void;
}

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// ---------------------------------------------------------------------------------------------
// Clavier de l'iPhone : Safari n'ouvre le clavier que pour un focus donné PENDANT le geste. On donne le focus à un
// champ invisible dans le toucher, puis on le passe au titre de la nouvelle page quand elle est affichée : iOS garde
// alors le clavier ouvert.
// ---------------------------------------------------------------------------------------------

let fantome: HTMLInputElement | null = null;

export function preparerClavier(): void {
  if (!tactile) return;
  if (!fantome) {
    fantome = document.createElement("input");
    fantome.type = "text";
    fantome.className = "clavier-fantome";
    fantome.setAttribute("aria-hidden", "true");
    fantome.tabIndex = -1;
    fantome.autocomplete = "off";
    document.body.appendChild(fantome);
  }
  fantome.focus({ preventScroll: true });
}

function libererClavier(): void {
  if (fantome && document.activeElement === fantome) fantome.blur();
}

/**
 * Attend l'affichage du titre de la nouvelle page `chemin` (sa valeur est le nom du fichier : l'ancienne page peut
 * encore être à l'écran un instant), puis y met le curseur, texte sélectionné : on tape par-dessus.
 */
export function focaliserTitre(chemin: string, delaiMax = 4000): void {
  const t0 = performance.now();
  const url = urlDe({ vue: "page", chemin });
  const nom = feuille(chemin);
  const essayer = () => {
    if (location.pathname !== url) { libererClavier(); return; }
    const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>("main .titre-page");
    if (el && !el.closest("[hidden]") && (el.value === nom || el.value === "")) {
      el.focus({ preventScroll: true });
      el.select();
      return;
    }
    if (performance.now() - t0 > delaiMax) { libererClavier(); return; }
    window.setTimeout(essayer, 40);
  };
  essayer();
}

// ---------------------------------------------------------------------------------------------
// Dernier bouton touché : le menu « … » s'ancre dessous quand l'appelant ne fournit pas d'ancre (en-tête de page).
// ---------------------------------------------------------------------------------------------

let dernierAppui: { el: HTMLElement; t: number } | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("pointerdown", (e) => {
    const b = (e.target as Element | null)?.closest?.("button, [role=button]") as HTMLElement | null;
    if (b) dernierAppui = { el: b, t: performance.now() };
  }, true);
}

function ancreParDefaut(): HTMLElement | null {
  if (dernierAppui && performance.now() - dernierAppui.t < 1500 && dernierAppui.el.isConnected) return dernierAppui.el;
  const actif = document.activeElement as HTMLElement | null;
  return actif && actif.tagName === "BUTTON" ? actif : null;
}

/** Copie un texte, dans le geste de l'utilisateur (repli execCommand pour les vieux Safari). */
export function copierTexte(texte: string): boolean {
  try {
    if (navigator.clipboard?.writeText) {
      void navigator.clipboard.writeText(texte).catch(() => copierAncien(texte));
      return true;
    }
  } catch { /* repli */ }
  return copierAncien(texte);
}

function copierAncien(texte: string): boolean {
  const t = document.createElement("textarea");
  t.value = texte;
  t.setAttribute("readonly", "");
  t.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
  document.body.appendChild(t);
  t.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  t.remove();
  return ok;
}

/** Signale à l'arbre une ligne à faire clignoter (après un déplacement, une restauration…). */
export function signalerLigne(chemin: string): void {
  window.dispatchEvent(new CustomEvent("carnet:clignoter", { detail: chemin }));
}

// Titre du PDF (nom de fichier proposé par le navigateur) : le titre de la page, sans « · Carnet ».
let titreAvantImpression: string | null = null;
if (typeof window !== "undefined") {
  window.addEventListener("beforeprint", () => {
    titreAvantImpression = document.title;
    document.title = document.title.replace(/ · Carnet$/, "");
  });
  window.addEventListener("afterprint", () => {
    if (titreAvantImpression !== null) document.title = titreAvantImpression;
    titreAvantImpression = null;
  });
}

interface EtatMenu { chemin: string; ancre: HTMLElement | null }

export function useActionsPages(d: DependancesPages): {
  nouvellePage(parent: string): Promise<string | null>;
  menuPage(chemin: string, ancre?: HTMLElement | null): Promise<void>;
  deplacerPage(source: string, parent: string): Promise<string | null>;
  placerPage(source: string, cible: string, position: Position): Promise<void>;
  supprimerPage(chemin: string): Promise<void>;
  couche: ReactNode;
} {
  const deps = useRef(d);
  deps.current = d;
  const [menu, setMenu] = useState<EtatMenu | null>(null);

  const routeDansSousArbre = useCallback((racine: string): boolean => {
    const route = deps.current.route;
    if (route.vue !== "page" && route.vue !== "fichier" && route.vue !== "historique") return false;
    const base = racine.replace(/\.md$/i, "");
    return route.chemin === racine || route.chemin.startsWith(base + "/");
  }, []);

  /** Après un renommage ou un déplacement de `ancien` vers `nouveau` : favoris, récentes et page ouverte suivent. */
  const suivre = useCallback((ancien: string, nouveau: string) => {
    if (ancien === nouveau) return;
    const a = ancien.replace(/\.md$/i, "");
    const n = nouveau.replace(/\.md$/i, "");
    const f = (c: string) => (c === ancien ? nouveau : c.startsWith(a + "/") ? n + c.slice(a.length) : c);
    deps.current.setFavoris((l) => l.map(f));
    renommerRecentes(f);
    const route = deps.current.route;
    if ((route.vue === "page" || route.vue === "historique" || route.vue === "fichier") && routeDansSousArbre(ancien)) {
      naviguer({ ...route, chemin: f(route.chemin) }, true);
    }
  }, [routeDansSousArbre]);

  const nouvellePage = useCallback(async (parent: string): Promise<string | null> => {
    preparerClavier();
    const x = deps.current;
    try {
      const r = await api.creer(parent, "Sans titre", "");
      if (parent) x.basculer(parent, true);
      await x.rechargerArbre();
      naviguer({ vue: "page", chemin: r.chemin });
      x.fermerTiroir();
      focaliserTitre(r.chemin);
      return r.chemin;
    } catch (e) {
      libererClavier();
      x.notifier(`Page non créée : ${msg(e)}`);
      return null;
    }
  }, []);

  const deplacerPage = useCallback(async (source: string, parent: string): Promise<string | null> => {
    const x = deps.current;
    const r = await api.deplacer(source, parent);
    if (parent) x.basculer(parent, true);
    await x.rechargerArbre();
    suivre(source, r.chemin);
    signalerLigne(r.chemin);
    const dest = parent ? x.index.get(parent)?.titre ?? nomDePage(parent) : "la racine";
    return `Déplacée dans ${dest}${r.liensMisAJour ? `, ${r.liensMisAJour} lien${r.liensMisAJour > 1 ? "s" : ""} mis à jour` : ""}`;
  }, [suivre]);

  const placerPage = useCallback(async (source: string, cible: string, position: Position): Promise<void> => {
    const x = deps.current;
    try {
      const avant = dossierDe(source);
      const r = await api.placer(source, cible, position);
      if (position === "dans" && cible) x.basculer(cible, true);
      await x.rechargerArbre();
      suivre(source, r.chemin);
      signalerLigne(r.chemin);
      if (dossierDe(r.chemin) !== avant) {
        const parent = dossierDe(r.chemin);
        const dest = parent ? x.index.get(parent + ".md")?.titre ?? feuille(parent) : "la racine";
        x.notifier(`Déplacée dans ${dest}${r.liensMisAJour ? `, ${r.liensMisAJour} lien${r.liensMisAJour > 1 ? "s" : ""} mis à jour` : ""}`);
      }
    } catch (e) {
      x.notifier(`Déplacement impossible : ${msg(e)}`);
      await x.rechargerArbre();
    }
  }, [suivre]);

  const supprimerPage = useCallback(async (chemin: string): Promise<void> => {
    const x = deps.current;
    const n = x.index.get(chemin);
    const titre = n?.titre ?? feuille(chemin);
    const base = chemin.replace(/\.md$/i, "");
    const favorisAvant = x.favoris;
    const ouverte = routeDansSousArbre(chemin);
    const routeAvant = x.route;
    let r: { id: string };
    try {
      r = await api.supprimer(chemin);
    } catch (e) {
      x.notifier(`Mise à la corbeille impossible : ${msg(e)}`);
      return;
    }
    x.setFavoris((l) => l.filter((c) => c !== chemin && !c.startsWith(base + "/")));
    await x.rechargerArbre();
    if (ouverte) {
      const parent = dossierDe(chemin);
      naviguer(parent ? { vue: "page", chemin: parent + ".md" } : { vue: "accueil" }, true);
    }
    const annuler = async () => {
      try {
        const rr = await api.restaurer(r.id);
        await deps.current.rechargerArbre();
        if (rr.chemin === chemin) {
          const garder = favorisAvant.filter((c) => c === chemin || c.startsWith(base + "/"));
          if (garder.length) {
            deps.current.setFavoris((l) => [...new Set([...l, ...garder])]);
            void api.poserFavoris([...new Set([...deps.current.favoris, ...garder])]).catch(() => {});
          }
        }
        if (ouverte && (routeAvant.vue === "page" || routeAvant.vue === "historique")) {
          naviguer(rr.chemin === chemin ? routeAvant : { vue: "page", chemin: rr.chemin }, true);
        }
        signalerLigne(rr.chemin);
        deps.current.notifier(rr.renomme ? `Restaurée sous le nom « ${feuille(rr.chemin)} »` : "Page restaurée");
      } catch (e) {
        deps.current.notifier(`Restauration impossible : ${msg(e)}`);
      }
    };
    x.notifier(`« ${titre} » est dans la corbeille`, { libelle: "Annuler", faire: () => void annuler() }, 8000);
  }, [routeDansSousArbre]);

  const renommer = useCallback(async (chemin: string) => {
    const x = deps.current;
    const n = x.index.get(chemin);
    const titre = await x.demanderTexte({
      titre: "Renommer",
      valeur: n?.titre ?? feuille(chemin),
      placeholder: "Titre de la page",
      bouton: "Renommer",
    });
    if (!titre || titre === n?.titre) return;
    try {
      const r = await api.renommerTitre(chemin, titre);
      await deps.current.rechargerArbre();
      suivre(chemin, r.chemin);
      signalerLigne(r.chemin);
      deps.current.notifier(`Renommée${r.liensMisAJour ? `, ${r.liensMisAJour} lien${r.liensMisAJour > 1 ? "s" : ""} mis à jour` : ""}`);
    } catch (e) {
      deps.current.notifier(`Renommage impossible : ${msg(e)}`);
    }
  }, [suivre]);

  const dupliquer = useCallback(async (chemin: string) => {
    try {
      const r = await api.dupliquer(chemin);
      await deps.current.rechargerArbre();
      signalerLigne(r.chemin);
      deps.current.notifier("Copie créée", { libelle: "Ouvrir", faire: () => naviguer({ vue: "page", chemin: r.chemin }) });
    } catch (e) {
      deps.current.notifier(`Duplication impossible : ${msg(e)}`);
    }
  }, []);

  const deplacerVers = useCallback(async (chemin: string) => {
    const x = deps.current;
    const titre = x.index.get(chemin)?.titre ?? feuille(chemin);
    const cible = await x.choisirPage({ titre: `Déplacer « ${titre} » dans…`, exclure: chemin });
    if (cible === null) return;
    try {
      const m = await deplacerPage(chemin, cible === "__racine__" ? "" : cible);
      if (m) deps.current.notifier(m);
    } catch (e) {
      deps.current.notifier(`Déplacement impossible : ${msg(e)}`);
    }
  }, [deplacerPage]);

  /** Pages sœurs (même dossier), dans l'ordre affiché. */
  const soeurs = useCallback((chemin: string): Noeud[] => {
    const x = deps.current;
    const parent = dossierDe(chemin);
    const l = parent ? x.index.get(parent + ".md")?.enfants ?? [] : x.arbre;
    return l.filter((n) => n.type === "page");
  }, []);

  const menuPage = useCallback(async (chemin: string, ancre?: HTMLElement | null): Promise<void> => {
    setMenu({ chemin, ancre: ancre ?? ancreParDefaut() });
  }, []);
  const fermerMenu = useCallback(() => setMenu(null), []);

  // Échap du menu ou navigation : fermé.
  useEffect(() => { setMenu(null); }, [d.route]);

  let couche: ReactNode = null;
  if (menu) {
    const x = d;
    const chemin = menu.chemin;
    const n = x.index.get(chemin);
    const titre = n?.titre ?? feuille(chemin);
    const existe = n ? n.existe : true;
    const favori = x.favoris.includes(chemin);
    const ouverte = x.route.vue === "page" && x.route.chemin === chemin;
    const l = soeurs(chemin);
    const i = l.findIndex((s) => s.chemin === chemin);
    const elements: ElementMenu[] = [
      { cle: "sous-page", libelle: "Ajouter une sous-page", icone: <FilePlus size={18} />, faire: () => { x.basculer(chemin, true); void nouvellePage(chemin); } },
      { cle: "favori", libelle: favori ? "Retirer des favoris" : "Ajouter aux favoris", icone: favori ? <StarOff size={18} /> : <Star size={18} />, faire: () => x.basculerFavori(chemin) },
    ];
    if (existe) {
      elements.push(
        { cle: "renommer", libelle: "Renommer", icone: <Pencil size={18} />, separateurAvant: true, faire: () => void renommer(chemin) },
        { cle: "dupliquer", libelle: "Dupliquer", icone: <Copy size={18} />, faire: () => void dupliquer(chemin) },
        { cle: "deplacer", libelle: "Déplacer vers…", icone: <FolderInput size={18} />, faire: () => void deplacerVers(chemin) },
      );
      if (tactile && i > 0) elements.push({ cle: "monter", libelle: "Monter", icone: <ArrowUp size={18} />, faire: () => void placerPage(chemin, l[i - 1].chemin, "avant") });
      if (tactile && i !== -1 && i < l.length - 1) elements.push({ cle: "descendre", libelle: "Descendre", icone: <ArrowDown size={18} />, faire: () => void placerPage(chemin, l[i + 1].chemin, "apres") });
    }
    elements.push({
      cle: "lien", libelle: "Copier le lien", icone: <Link2 size={18} />, separateurAvant: !existe,
      faire: () => {
        const ok = copierTexte(location.origin + urlDe({ vue: "page", chemin }));
        x.notifier(ok ? "Lien copié" : "Copie impossible : le navigateur l'a refusée");
      },
    });
    if (existe) {
      elements.push({ cle: "historique", libelle: "Historique des versions", icone: <History size={18} />, faire: () => naviguer({ vue: "historique", chemin }) });
      if (ouverte) elements.push({ cle: "imprimer", libelle: "Imprimer ou exporter en PDF", icone: <Printer size={18} />, faire: () => window.print() });
      elements.push({ cle: "corbeille", libelle: "Mettre à la corbeille", icone: <Trash2 size={18} />, danger: true, separateurAvant: true, faire: () => void supprimerPage(chemin) });
    }
    const parent = dossierDe(chemin);
    const sousTitre = parent ? `Dans ${parent.split("/").map((s, k, t) => x.index.get(t.slice(0, k + 1).join("/") + ".md")?.titre ?? s).join(" › ")}` : undefined;
    couche = (
      <MenuPage key={chemin} titre={titre} icone={n?.icone} sousTitre={sousTitre} elements={elements} ancre={menu.ancre}
        onFermer={fermerMenu} />
    );
  }

  return { nouvellePage, menuPage, deplacerPage, placerPage, supprimerPage, couche };
}

