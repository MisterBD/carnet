// Carnet : coquille de l'application (barre latérale, routes, dialogues, notifications).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Config, type Noeud } from "./api";
import { ContexteApp, ancetres, type App as AppType, type OptionsConfirmation, type OptionsTexte } from "./contexte-app";
import { ecouter } from "./evenements";
import { naviguer, useRoute } from "./navigation";
import { BarreLaterale } from "./composants/BarreLaterale";
import { PageVue } from "./composants/PageVue";
import { Accueil } from "./composants/Accueil";
import { Projets } from "./composants/Projets";
import { FichierVue } from "./composants/Fichier";
import { Recherche } from "./composants/Recherche";
import { PleinEcran } from "./composants/PleinEcran";
import { EcranHorsLigne, PastilleReseau } from "./composants/HorsLigne";
import { SquelettePage } from "./composants/Squelettes";
import { BarriereErreur } from "./composants/BarriereErreur";
import { classerErreur, retenirAideConnexion, sonderServeur, useGesteRetourTiroir, useMiseAJourServiceWorker, type Panne } from "./pwa";
import { DialogueTexte, DialogueConfirmation, DialogueActions, DialogueEmoji, DialogueArtefact, type ActionMenu } from "./composants/Dialogues";
import { VuesNavigation } from "./composants/VuesNavigation";
import { useActionsPages } from "./actions-pages";
import { diffuserTheme } from "./editeur/cadres";
import { nomDePage } from "../../shared/page.ts";

type Dialogue =
  | { type: "texte"; o: OptionsTexte; fin: (v: string | null) => void }
  | { type: "confirmation"; o: OptionsConfirmation; fin: (v: boolean) => void }
  | { type: "page"; titre: string; exclure?: string; fin: (v: string | null) => void }
  | { type: "recherche" }
  | { type: "artefact"; fin: (v: { chemin: string; titre: string } | null) => void }
  | { type: "emoji"; retrait: boolean; fin: (v: string | null) => void }
  | { type: "actions"; titre: string; items: ActionMenu[]; fin: (v: string | null) => void };

interface Toast { id: number; message: string; action?: { libelle: string; faire: () => void } }

function indexer(noeuds: Noeud[], index = new Map<string, Noeud>()): Map<string, Noeud> {
  for (const n of noeuds) { index.set(n.chemin, n); indexer(n.enfants, index); }
  return index;
}

const CLE_DEPLIES = "carnet:deplies";

export function App() {
  const route = useRoute();
  const [config, setConfig] = useState<Config | null>(null);
  const [arbre, setArbre] = useState<Noeud[]>([]);
  const [favoris, setFavoris] = useState<string[]>([]);
  const [dialogue, setDialogue] = useState<Dialogue | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [tiroir, setTiroir] = useState(false);
  const [plein, setPlein] = useState<{ chemin: string; titre: string } | null>(null);
  const [panne, setPanne] = useState<Panne | null>(null);
  const [arbreCharge, setArbreCharge] = useState(false);
  const [deplies, setDeplies] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(CLE_DEPLIES) ?? "[]")); } catch { return new Set(); }
  });
  const index = useMemo(() => indexer(arbre), [arbre]);

  // ---------- Données ----------
  const rechargerArbre = useCallback(async () => {
    try {
      const r = await api.arbre();
      setArbre(r.racine);
    } catch (e) {
      console.warn("arbre", e);
    } finally {
      setArbreCharge(true);
    }
  }, []);

  // Démarrage (et « Réessayer » de l'écran hors ligne) : configuration, arbre, favoris. Retourne vrai si le carnet répond.
  const demarrer = useCallback(async (): Promise<boolean> => {
    try {
      const c = await api.config();
      setConfig(c);
      retenirAideConnexion({ reseau: c.reseau ?? null, contact: c.contact ?? null });
      setPanne(null);
    } catch (e) {
      setPanne(classerErreur(e));
      return false;
    }
    void rechargerArbre();
    api.favoris().then((r) => setFavoris(r.chemins)).catch(() => {});
    return true;
  }, [rechargerArbre]);

  useEffect(() => { void demarrer(); }, [demarrer]);

  // Appli installée : nouvelle version du service worker au retour au premier plan ; geste « retour » = fermer le tiroir.
  useMiseAJourServiceWorker();
  useGesteRetourTiroir(tiroir, () => setTiroir(false));

  useEffect(() => {
    let m: number | null = null;
    return ecouter((e) => {
      if (e.type === "arbre" || (e.type === "connexion" && e.etat === "ouverte")) {
        if (m) window.clearTimeout(m);
        m = window.setTimeout(() => void rechargerArbre(), 150);
      }
    });
  }, [rechargerArbre]);

  // Thème des cadres isolés (artefacts, schémas) : suit le réglage du système
  useEffect(() => {
    const mq = matchMedia("(prefers-color-scheme: dark)");
    const f = () => diffuserTheme(mq.matches ? "sombre" : "clair");
    f();
    mq.addEventListener("change", f);
    return () => mq.removeEventListener("change", f);
  }, []);

  // Dépliage : ancêtres de la page ouverte, mémorisé
  useEffect(() => {
    if (route.vue !== "page" && route.vue !== "fichier") return;
    const a = ancetres(route.vue === "fichier" ? route.chemin.replace(/\.[^./]+$/, "") + ".md" : route.chemin);
    if (!a.length) return;
    setDeplies((d) => {
      if (a.every((c) => d.has(c))) return d;
      const n = new Set(d);
      a.forEach((c) => n.add(c));
      return n;
    });
  }, [route]);
  useEffect(() => {
    try { localStorage.setItem(CLE_DEPLIES, JSON.stringify([...deplies])); } catch { /* navigation privée */ }
  }, [deplies]);
  const basculer = useCallback((chemin: string, ouvrir?: boolean) => {
    setDeplies((d) => {
      const n = new Set(d);
      const ouvrirIci = ouvrir ?? !n.has(chemin);
      if (ouvrirIci) n.add(chemin); else n.delete(chemin);
      return n;
    });
  }, []);

  // ⌘K / Ctrl+K
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); setDialogue({ type: "recherche" }); }
    };
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, []);

  // Le tiroir se ferme quand on change de page
  useEffect(() => { setTiroir(false); }, [route]);
  useEffect(() => {
    document.documentElement.style.overflow = tiroir ? "hidden" : "";
  }, [tiroir]);

  // Titre de l'onglet
  useEffect(() => {
    const t = route.vue === "page" ? index.get(route.chemin)?.titre ?? nomDePage(route.chemin).split("/").pop()
      : route.vue === "historique" ? `Historique de ${index.get(route.chemin)?.titre ?? nomDePage(route.chemin).split("/").pop()}`
      : route.vue === "corbeille" ? "Corbeille"
      : route.vue === "projets" ? "Projets" : route.vue === "fichier" ? route.chemin.split("/").pop() : "Accueil";
    document.title = `${t} · Carnet`;
  }, [route, index]);

  // ---------- Notifications ----------
  const compteur = useRef(0);
  const notifier = useCallback((message: string, action?: Toast["action"], duree?: number) => {
    const id = ++compteur.current;
    setToasts((t) => [...t.slice(-2), { id, message, action }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), duree ?? (action ? 6000 : 3500));
  }, []);

  // ---------- Dialogues ----------
  const fermer = useCallback(() => setDialogue(null), []);
  const demanderTexte = useCallback((o: OptionsTexte) => new Promise<string | null>((fin) => setDialogue({ type: "texte", o, fin })), []);
  const confirmer = useCallback((o: OptionsConfirmation) => new Promise<boolean>((fin) => setDialogue({ type: "confirmation", o, fin })), []);
  const choisirPage = useCallback((o?: { titre?: string; exclure?: string }) =>
    new Promise<string | null>((fin) => setDialogue({ type: "page", titre: o?.titre ?? "Choisir une page", exclure: o?.exclure, fin })), []);
  const choisirArtefact = useCallback(() => new Promise<{ chemin: string; titre: string } | null>((fin) => setDialogue({ type: "artefact", fin })), []);
  const choisirEmoji = useCallback((retrait: boolean) => new Promise<string | null>((fin) => setDialogue({ type: "emoji", retrait, fin })), []);
  const actions = useCallback((titre: string, items: ActionMenu[]) => new Promise<string | null>((fin) => setDialogue({ type: "actions", titre, items, fin })), []);

  // ---------- Actions sur les pages (chantier navigation : actions-pages.tsx) ----------
  const basculerFavori = useCallback((chemin: string) => {
    setFavoris((f) => {
      const n = f.includes(chemin) ? f.filter((c) => c !== chemin) : [...f, chemin];
      api.poserFavoris(n).catch(() => notifier("Favoris non enregistrés"));
      return n;
    });
  }, [notifier]);

  const pages = useActionsPages({
    route, arbre, index, favoris, setFavoris, basculerFavori, basculer, rechargerArbre, notifier, demanderTexte, confirmer,
    choisirPage, fermerTiroir: () => setTiroir(false),
  });
  const { nouvellePage, menuPage, deplacerPage, placerPage, supprimerPage } = pages;

  const app: AppType = useMemo(() => ({
    config, arbre, arbreCharge, index, rechargerArbre, favoris, basculerFavori, demanderTexte, confirmer, choisirPage, choisirArtefact,
    choisirEmoji, actions, notifier,
    pleinEcran: (chemin: string, titre: string) => setPlein({ chemin, titre }),
    ouvrirRecherche: () => setDialogue({ type: "recherche" }),
    ouvrirTiroir: () => setTiroir(true),
    fermerTiroir: () => setTiroir(false),
    nouvellePage, menuPage, deplacerPage, placerPage, supprimerPage,
    deplier: (c: string) => basculer(c, true),
  }), [config, arbre, arbreCharge, index, rechargerArbre, favoris, basculerFavori, demanderTexte, confirmer, choisirPage, choisirArtefact,
    choisirEmoji, actions, notifier, nouvellePage, menuPage, deplacerPage, placerPage, supprimerPage, basculer]);

  // Carnet injoignable dès le démarrage (réseau privé coupé, serveur arrêté) : un écran clair, jamais une page blanche.
  if (panne && !config) return <EcranHorsLigne panne={panne} onReessayer={demarrer} />;

  return (
    <ContexteApp.Provider value={app}>
      <a className="lien-evitement" href="#contenu" onClick={(e) => { e.preventDefault(); document.getElementById("contenu")?.focus(); }}>Aller au contenu</a>
      <div className="coquille">
        <BarreLaterale route={route} ouverte={tiroir} deplies={deplies} basculer={basculer} />
        <div className="principal" id="contenu" tabIndex={-1}>
          {/* La configuration (origine des artefacts, prénom) arrive en quelques millisecondes : on l'attend avant
              d'ouvrir une page, pour que schémas et artefacts visent tout de suite la bonne origine. */}
          {!config && (
            <>
              <div className="entete-vide" />
              <main className="feuille" aria-busy="true"><SquelettePage /></main>
            </>
          )}
          {config && (
            <BarriereErreur cle={route.vue + ("chemin" in route ? route.chemin : "")} onAccueil={() => naviguer({ vue: "accueil" })}>
              {route.vue === "accueil" && <Accueil />}
              {route.vue === "projets" && <Projets />}
              {route.vue === "page" && <PageVue key={route.chemin} chemin={route.chemin} />}
              {route.vue === "fichier" && <FichierVue key={route.chemin} chemin={route.chemin} />}
              <VuesNavigation route={route} />
            </BarriereErreur>
          )}
        </div>
      </div>
      <PastilleReseau />

      {dialogue?.type === "recherche" && (
        <Recherche arbre={arbre} index={index} onFermer={fermer}
          onChoisir={(c) => { fermer(); naviguer(c.endsWith(".md") ? { vue: "page", chemin: c } : { vue: "fichier", chemin: c }); }} />
      )}
      {dialogue?.type === "page" && (
        <Recherche arbre={arbre} index={index} titre={dialogue.titre} choix exclure={dialogue.exclure}
          racine={dialogue.titre.startsWith("Déplacer")}
          onFermer={() => { dialogue.fin(null); fermer(); }}
          onChoisir={(c) => { dialogue.fin(c); fermer(); }} />
      )}
      {dialogue?.type === "texte" && (
        <DialogueTexte {...dialogue.o} onFermer={() => { dialogue.fin(null); fermer(); }} onValider={(v) => { dialogue.fin(v); fermer(); }} />
      )}
      {dialogue?.type === "confirmation" && (
        <DialogueConfirmation {...dialogue.o} onFermer={() => { dialogue.fin(false); fermer(); }} onValider={() => { dialogue.fin(true); fermer(); }} />
      )}
      {dialogue?.type === "actions" && (
        <DialogueActions titre={dialogue.titre} items={dialogue.items} onFermer={() => { dialogue.fin(null); fermer(); }} onChoisir={(c) => { dialogue.fin(c); fermer(); }} />
      )}
      {dialogue?.type === "emoji" && (
        <DialogueEmoji avecRetrait={dialogue.retrait} onFermer={() => { dialogue.fin(null); fermer(); }} onChoisir={(e) => { dialogue.fin(e); fermer(); }} />
      )}
      {dialogue?.type === "artefact" && (
        <DialogueArtefact onFermer={() => { dialogue.fin(null); fermer(); }} onChoisir={(a) => { dialogue.fin(a); fermer(); }} />
      )}
      {plein && <PleinEcran chemin={plein.chemin} titre={plein.titre} onFermer={() => setPlein(null)} />}
      {pages.couche}

      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast">
            <span>{t.message}</span>
            {t.action && <button type="button" onClick={() => { t.action!.faire(); setToasts((x) => x.filter((y) => y.id !== t.id)); }}>{t.action.libelle}</button>}
          </div>
        ))}
      </div>
    </ContexteApp.Provider>
  );
}
