// Une page : en-tête (couverture, icône, titre, propriétés, rétroliens), éditeur en blocs, sous-pages.
// Enregistrement automatique (seulement si la personne a vraiment modifié quelque chose, et seuls les blocs touchés
// sont réécrits), mise à jour en direct quand un agent modifie le fichier, bandeau en cas de conflit.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FileQuestion, MoreHorizontal, Plus, Star, TriangleAlert } from "lucide-react";
import { api, ErreurApi, type Noeud } from "../api";
import { useApp, ancetres } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import type { EditeurCarnet } from "../editeur/creer";
import { fusionner } from "../editeur/fidelite";
import type { ContexteEditeur } from "../editeur/contexte";
import { themeCadres } from "../editeur/cadres";
import {
  decouper, remplacerTexteH1, poserChamp, lireChampSimple, dossierDe, nomDePage, feuille, resoudre, nomDeFichier, type Decoupe,
} from "../../../shared/page.ts";
import { liensWiki } from "../../../shared/navigation.ts";
import { Entete, type EtatEnregistrement, type MaillonFil } from "./Entete";
import { IconePage } from "./Icone";
import { EnTetePage } from "./EnTetePage";
import { EtatVide } from "./EtatVide";
import { SquelettePage } from "./Squelettes";
import { BarreClavier } from "./BarreClavier";
import { tactile, trace } from "../outils";

type SourceTitre = "h1" | "fm" | "nom";

interface Etat {
  original: string;
  decoupe: Decoupe;
  n0: string;
  etag: string | null;
  existe: boolean;
  interagi: boolean;
  titre: string;
  titreInitial: string;
  source: SourceTitre;
  fmModifie: boolean;
  enCours: boolean;
  aRefaire: boolean;
  minuterie: number | null;
  premierChangement: number | null;
  attenteReseau: number;
  ed: EditeurCarnet | null;
  detruit: boolean;
  /** Une écriture extérieure a été signalée pendant notre propre enregistrement : à vérifier ensuite. */
  distanteEnAttente: boolean;
}

/** Trouve la page désignée par un lien [[...]] : chemin complet, sinon nom de fichier unique (style Obsidian). */
export function resoudreLien(index: Map<string, Noeud>, nom: string, depuis: string): string {
  const n = nom.replace(/^\/+/, "").normalize("NFC");
  if (index.has(n + ".md")) return n + ".md";
  const rel = resoudre(dossierDe(depuis), n);
  if (rel && index.has(rel + ".md")) return rel + ".md";
  const suffixe = "/" + n + ".md";
  const candidats = [...index.keys()].filter((c) => c.endsWith(suffixe));
  if (candidats.length === 1) return candidats[0];
  return n + ".md";
}

export function PageVue({ chemin }: { chemin: string }) {
  const app = useApp();
  const noeud = app.index.get(chemin);
  const [statut, setStatut] = useState<"chargement" | "pret" | "introuvable" | "erreur">("chargement");
  const [messageErreur, setMessageErreur] = useState("");
  const [titre, setTitre] = useState("");
  const [yaml, setYaml] = useState("");
  const [etatEnr, setEtatEnr] = useState<EtatEnregistrement>("repos");
  const [conflit, setConflit] = useState<null | { etag: string; contenu?: string; externe: boolean }>(null);
  const [focus, setFocus] = useState(false);
  const [edPret, setEdPret] = useState<EditeurCarnet | null>(null);
  const racineEditeur = useRef<HTMLDivElement>(null);
  const s = useRef<Etat>({
    original: "", decoupe: decouper(""), n0: "", etag: null, existe: true, interagi: false, titre: "", titreInitial: "",
    source: "nom", fmModifie: false, enCours: false, aRefaire: false, minuterie: null, premierChangement: null,
    attenteReseau: 2000, ed: null, detruit: false, distanteEnAttente: false,
  }).current;
  const appRef = useRef(app);
  appRef.current = app;

  // ---------- Enregistrement ----------
  const modifie = useCallback((): boolean => {
    const md = s.ed && s.interagi ? s.ed.getMarkdown() : s.n0;
    return md !== s.n0 || s.titre !== s.titreInitial || s.fmModifie;
  }, [s]);

  const enregistrer = useCallback(async (): Promise<void> => {
    if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
    s.premierChangement = null;
    const ed = s.ed;
    if (!ed) return;
    if (s.enCours) { s.aRefaire = true; return; }
    if (!modifie()) { if (!s.detruit) setEtatEnr((e) => (e === "modifie" ? "enregistre" : e)); return; }
    const md = ed.getMarkdown();
    const d = s.decoupe;
    const corps = md === s.n0 ? d.corps : fusionner(d.corps, s.n0, md, ed.analyser);
    let fm = d.frontmatter;
    let blocTitre = d.blocTitre;
    let titreH1 = d.titreH1;
    const t = s.titre.trim();
    if (s.source === "h1" && t && t !== d.titreH1) { blocTitre = remplacerTexteH1(blocTitre, t); titreH1 = t; }
    if (s.source === "fm" && t && t !== s.titreInitial) fm = poserChamp(fm, "title", t);
    const contenu = fm + blocTitre + corps;
    if (contenu === s.original && s.existe) { s.n0 = md; s.titreInitial = s.titre; s.fmModifie = false; if (!s.detruit) setEtatEnr("enregistre"); return; }
    s.enCours = true;
    if (!s.detruit) setEtatEnr("enregistrement");
    try {
      const r = await api.ecrire(chemin, contenu, s.existe ? s.etag : null);
      trace("écrit", r.etag, "distante en attente", s.distanteEnAttente);
      s.etag = r.etag;
      s.original = contenu;
      const etaitAbsente = !s.existe;
      s.existe = true;
      s.decoupe = { ...d, frontmatter: fm, blocTitre, titreH1, corps };
      s.n0 = md;
      if (s.source !== "nom") s.titreInitial = s.titre;
      s.fmModifie = false;
      s.attenteReseau = 2000;
      if (!s.detruit) { setEtatEnr("enregistre"); setYaml(s.decoupe.yaml || decouper(contenu).yaml); }
      if (etaitAbsente || s.source !== "nom") void appRef.current.rechargerArbre();
    } catch (e) {
      if (e instanceof ErreurApi && e.statut === 412) {
        if (!s.detruit) {
          setConflit({ etag: String(e.corps.etag ?? ""), contenu: typeof e.corps.contenu === "string" ? e.corps.contenu : undefined, externe: false });
          setEtatEnr("conflit");
        }
      } else if (e instanceof ErreurApi) {
        if (!s.detruit) setEtatEnr("erreur");
        appRef.current.notifier(`Page non enregistrée : ${e.message}`);
      } else {
        // réseau : on réessaie
        if (!s.detruit) setEtatEnr("hors-ligne");
        const attente = s.attenteReseau;
        s.attenteReseau = Math.min(attente * 2, 30000);
        s.minuterie = window.setTimeout(() => { void enregistrer(); }, attente);
      }
    } finally {
      s.enCours = false;
      if (s.aRefaire) { s.aRefaire = false; void enregistrer(); }
      else if (s.distanteEnAttente && !s.detruit) { s.distanteEnAttente = false; void verifierDistant.current(); }
    }
  }, [chemin, s, modifie]);
  const verifierDistant = useRef<() => Promise<void>>(async () => {});

  const planifier = useCallback(() => {
    if (!s.detruit) setEtatEnr("modifie");
    const maintenant = Date.now();
    if (!s.premierChangement) s.premierChangement = maintenant;
    if (s.minuterie) window.clearTimeout(s.minuterie);
    // 700 ms après la dernière frappe, ou au plus tard 4 s après la première
    const delai = Math.max(0, Math.min(700, 4000 - (maintenant - s.premierChangement)));
    const tenter = () => {
      // Menu « / » ouvert : le « /filtre » tapé n'est pas du contenu, on attend le choix de la personne.
      if (s.ed?.menuOuvert()) {
        s.minuterie = window.setTimeout(tenter, 500);
        return;
      }
      void enregistrer();
    };
    s.minuterie = window.setTimeout(tenter, delai);
  }, [s, enregistrer]);

  // ---------- Application d'un contenu (chargement, mise à jour en direct) ----------
  const appliquer = useCallback((contenu: string, etag: string | null, existe: boolean) => {
    const d = decouper(contenu);
    s.original = contenu;
    s.etag = etag;
    s.existe = existe;
    s.fmModifie = false;
    let source: SourceTitre = "nom";
    const n = appRef.current.index.get(chemin);
    let t = n?.nom ?? feuille(chemin);
    if (d.titreH1 != null) { source = "h1"; t = d.titreH1; }
    else {
      const tf = lireChampSimple(d.yaml, "title");
      if (tf) { source = "fm"; t = tf; }
    }
    if (!existe) {
      // page « dossier » sans fichier : elle naîtra avec un titre
      const nom = n?.nom ?? feuille(chemin);
      const nd = decouper(`# ${nom}\n\n`);
      s.decoupe = nd;
      source = "h1";
      t = nom;
    } else {
      s.decoupe = d;
    }
    s.source = source;
    s.titre = t;
    s.titreInitial = t;
    setTitre(t);
    setYaml(d.yaml);
    // Dépendances volontairement stables : un rafraîchissement de l'arbre ne doit JAMAIS relancer le chargement
    // (il remplacerait l'état de référence sans mettre à jour l'éditeur).
  }, [s, chemin]);

  // Chargement initial
  useEffect(() => {
    let annule = false;
    api.page(chemin).then((p) => {
      if (annule) return;
      if (p.absente && !p.dossier && !appRef.current.index.get(chemin)?.enfants.length) { setStatut("introuvable"); return; }
      appliquer(p.contenu, p.etag, !p.absente);
      setStatut("pret");
    }).catch((e) => {
      if (annule) return;
      setMessageErreur((e as Error).message);
      setStatut("erreur");
    });
    return () => { annule = true; };
  }, [chemin, appliquer]);

  // Création de l'éditeur
  useEffect(() => {
    if (statut !== "pret" || !racineEditeur.current) return;
    const racine = racineEditeur.current;
    let ed: EditeurCarnet | null = null;
    let fini = false;
    const contexte: ContexteEditeur = {
      chemin,
      dossier: dossierDe(chemin),
      artBase: appRef.current.config?.artBase ?? "",
      urlFichier: (u: string) => {
        if (!u || /^(data:|blob:)/i.test(u)) return u;
        if (/^https?:/i.test(u) || u.startsWith("//")) return u; // externe : bloqué par la CSP, affiché comme lien cassé
        if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ""; // javascript:, file:… : jamais chargés
        const r = resoudre(dossierDe(chemin), u);
        return r ? `/api/fichier?chemin=${encodeURIComponent(r)}` : u;
      },
      ouvrirPage: (nom: string) => naviguer({ vue: "page", chemin: resoudreLien(appRef.current.index, nom, chemin) }),
      titreDe: (nom: string) => appRef.current.index.get(resoudreLien(appRef.current.index, nom, chemin))?.titre ?? null,
      televerserImage: async (f: File) => {
        s.interagi = true;
        try {
          const r = await api.televerser(chemin, f);
          return r.relatif;
        } catch (e) {
          appRef.current.notifier(`Image refusée : ${(e as Error).message}`);
          throw e;
        }
      },
      creerSousPage: async () => {
        s.interagi = true;
        const t = await appRef.current.demanderTexte({ titre: "Nouvelle sous-page", placeholder: "Nom de la page", bouton: "Créer la sous-page" });
        if (!t) return null;
        try {
          const r = await api.creer(chemin, t);
          appRef.current.deplier(chemin);
          await appRef.current.rechargerArbre();
          return nomDePage(r.chemin);
        } catch (e) {
          appRef.current.notifier(`Sous-page non créée : ${(e as Error).message}`);
          return null;
        }
      },
      choisirPage: async () => {
        s.interagi = true;
        const c = await appRef.current.choisirPage({ titre: "Lier une page", exclure: chemin });
        return c ? nomDePage(c) : null;
      },
      choisirArtefact: () => { s.interagi = true; return appRef.current.choisirArtefact(); },
      pleinEcranArtefact: (c, t) => appRef.current.pleinEcran(c, t),
      theme: () => themeCadres(),
      notifier: (m: string) => appRef.current.notifier(m),
    };
    const interaction = () => { s.interagi = true; };
    const evts = ["keydown", "beforeinput", "paste", "drop", "pointerdown", "compositionstart"] as const;
    evts.forEach((t) => racine.addEventListener(t, interaction, true));
    const surFocus = () => setFocus(true);
    const surPerte = () => window.setTimeout(() => {
      const actif = document.activeElement;
      // la barre au-dessus du clavier et les menus de l'éditeur font partie de l'édition
      if (!racine.contains(actif) && !actif?.closest?.(".carnet-barre-clavier, .carnet-interface")) setFocus(false);
    }, 120);
    racine.addEventListener("focusin", surFocus);
    racine.addEventListener("focusout", surPerte);

    import("../editeur/creer").then(({ creerEditeur }) => creerEditeur(racine, s.decoupe.corps, contexte, {
      surInteraction: interaction,
      surModification: (md: string) => {
        if (!s.interagi) { s.n0 = md; return; } // normalisation au chargement : pas une modification
        if (md === s.n0 && s.titre === s.titreInitial && !s.fmModifie) { setEtatEnr((e) => (e === "modifie" ? "enregistre" : e)); return; }
        planifier();
      },
    })).then((e) => {
      if (fini) { void e.detruire(); return; }
      ed = e;
      s.ed = e;
      s.n0 = e.getMarkdown();
      setEdPret(e);
    }).catch((err) => {
      console.error(err);
      setMessageErreur(String(err?.message ?? err));
      setStatut("erreur");
    });

    return () => {
      fini = true;
      evts.forEach((t) => racine.removeEventListener(t, interaction, true));
      racine.removeEventListener("focusin", surFocus);
      racine.removeEventListener("focusout", surPerte);
      if (ed) {
        // Dernier enregistrement (synchrone pour le calcul, la requête part même si la page se ferme)
        if (modifie()) void enregistrer();
        void ed.detruire();
      }
      s.ed = null;
    };
  }, [statut, chemin, s, planifier, enregistrer, modifie]);

  // Démontage : plus de mises à jour d'état
  useEffect(() => () => { s.detruit = true; }, [s]);

  // Enregistrer avant de quitter l'appli (iPhone : changement d'appli, verrouillage)
  useEffect(() => {
    const f = () => { if (document.visibilityState === "hidden" && modifie()) void enregistrer(); };
    const g = () => { if (modifie()) void enregistrer(); };
    document.addEventListener("visibilitychange", f);
    window.addEventListener("pagehide", g);
    return () => { document.removeEventListener("visibilitychange", f); window.removeEventListener("pagehide", g); };
  }, [modifie, enregistrer]);

  // ---------- Mise à jour en direct ----------
  const recharger = useCallback(async (contenuConnu?: string, etagConnu?: string) => {
    let contenu = contenuConnu;
    let etag = etagConnu ?? null;
    if (contenu === undefined) {
      const p = await api.page(chemin).catch(() => null);
      if (!p || p.absente) return;
      contenu = p.contenu;
      etag = p.etag;
    }
    const y = window.scrollY;
    appliquer(contenu, etag, true);
    if (s.ed) {
      s.ed.remplacer(s.decoupe.corps);
      s.n0 = s.ed.getMarkdown();
    }
    s.interagi = false;
    setConflit(null);
    setEtatEnr("repos");
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [chemin, appliquer, s]);

  // Synchronisation avec le disque, sérialisée (jamais deux à la fois : une réponse plus ancienne ne doit pas
  // écraser une plus récente). Appelée par les événements en direct et après chacun de nos enregistrements.
  const synchro = useRef({ enCours: false, encore: false, annonce: null as string | null, essais: 0 });
  const synchroniser = useCallback(async (): Promise<void> => {
    const sy = synchro.current;
    if (sy.enCours) { sy.encore = true; return; }
    sy.enCours = true;
    try {
      do {
        sy.encore = false;
        if (s.enCours) { s.distanteEnAttente = true; break; } // repris à la fin de notre écriture
        const p = await api.page(chemin).catch(() => null);
        trace("synchro lu", p?.etag, "local", s.etag, "annonce", sy.annonce, "modifie", modifie(), "enCours", s.enCours);
        if (!p || p.absente || s.detruit) continue;
        if (p.etag === s.etag) {
          // Un événement a annoncé une autre version que celle lue : le disque n'a pas fini, on relit un peu après.
          if (sy.annonce && sy.annonce !== s.etag && sy.essais < 6) {
            sy.essais++;
            await new Promise((r) => window.setTimeout(r, 300));
            sy.encore = true;
          } else {
            sy.annonce = null;
            sy.essais = 0;
          }
          continue;
        }
        sy.annonce = null;
        sy.essais = 0;
        if (s.enCours) { s.distanteEnAttente = true; break; }
        if (!modifie()) {
          // rien de neuf de notre côté (une minuterie peut tourner pour un changement déjà annulé) : on recharge
          if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
          await recharger(p.contenu, p.etag ?? undefined);
        }
        else setConflit({ etag: p.etag ?? "", contenu: p.contenu, externe: true });
      } while (sy.encore);
    } finally {
      sy.enCours = false;
    }
  }, [chemin, s, modifie, recharger]);
  verifierDistant.current = synchroniser;

  useEffect(() => ecouter((ev) => {
    if (ev.type !== "modif" || ev.chemin !== chemin) return;
    trace("sse", ev.etag, "local", s.etag, "enCours", s.enCours);
    if (ev.etag && ev.etag === s.etag) return; // notre propre écriture
    synchro.current.annonce = ev.etag || null;
    synchro.current.essais = 0;
    if (s.enCours) { s.distanteEnAttente = true; return; } // on vérifiera à la fin de notre écriture
    void synchroniser();
  }), [chemin, s, synchroniser]);

  // Retour au premier plan (iPhone) : le flux d'événements a pu dormir, on vérifie la version du disque.
  useEffect(() => {
    const f = () => { if (document.visibilityState === "visible" && s.ed) void synchroniser(); };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [s, synchroniser]);

  // ---------- Titre ----------
  const surTitre = (v: string) => {
    const propre = v.replace(/\n/g, " ");
    s.interagi = true;
    s.titre = propre;
    setTitre(propre);
    if (s.source !== "nom") planifier();
  };

  const renommageEnCours = useRef(false);
  const validerTitre = async () => {
    if (renommageEnCours.current) return;
    if (s.source !== "nom") {
      const t = s.titre.trim();
      // Le nom du fichier suivait le titre (« Courses.md » / « # Courses ») : il le suit encore.
      const suit = t && t !== s.titreInitial && s.existe && nomDeFichier(s.titreInitial) === feuille(chemin) && nomDeFichier(t) !== feuille(chemin);
      if (modifie()) await enregistrer();
      if (!suit) return;
      renommageEnCours.current = true;
      try {
        const r = await api.renommer(chemin, t);
        await appRef.current.rechargerArbre();
        naviguer({ vue: "page", chemin: r.chemin }, true);
      } catch (e) {
        appRef.current.notifier(`Titre enregistré, fichier non renommé : ${(e as Error).message}`);
      } finally {
        renommageEnCours.current = false;
      }
      return;
    }
    const t = s.titre.trim();
    if (!t || t === s.titreInitial) { s.titre = s.titreInitial; setTitre(s.titreInitial); return; }
    if (!s.existe) return;
    renommageEnCours.current = true;
    try {
      if (modifie()) await enregistrer();
      const r = await api.renommer(chemin, t);
      await appRef.current.rechargerArbre();
      naviguer({ vue: "page", chemin: r.chemin }, true);
      if (r.liensMisAJour) appRef.current.notifier(`Page renommée, ${r.liensMisAJour} lien${r.liensMisAJour > 1 ? "s" : ""} mis à jour`);
    } catch (e) {
      appRef.current.notifier(`Renommage impossible : ${(e as Error).message}`);
      s.titre = s.titreInitial;
      setTitre(s.titreInitial);
    } finally {
      renommageEnCours.current = false;
    }
  };

  // ---------- Frontmatter (icône, couverture) : une ligne chacun ----------
  const poserChamps = (champs: Record<string, string | null>) => {
    s.interagi = true;
    let fm = s.decoupe.frontmatter;
    for (const [k, v] of Object.entries(champs)) fm = poserChamp(fm, k, v || null);
    s.decoupe = { ...s.decoupe, frontmatter: fm, yaml: decouper(fm + "\n").yaml };
    s.fmModifie = true;
    setYaml(s.decoupe.yaml);
    void enregistrer();
  };

  // ---------- Conflit ----------
  const garderLaMienne = async () => {
    if (!conflit) return;
    let etag = conflit.etag;
    if (!etag) {
      const p = await api.page(chemin).catch(() => null);
      if (!p) { appRef.current.notifier("Carnet ne répond pas : réessaie dans un instant."); return; }
      etag = p.etag ?? "";
    }
    s.etag = etag;
    setConflit(null);
    s.fmModifie = true; // force l'écriture
    void enregistrer();
  };

  // ---------- Rendu ----------
  const fil: MaillonFil[] = useMemo(() => {
    const m: MaillonFil[] = ancetres(chemin).map((c) => ({ titre: app.index.get(c)?.titre ?? feuille(c), route: { vue: "page", chemin: c } }));
    m.push({ titre: titre || noeud?.titre || feuille(chemin) });
    return m;
  }, [chemin, app.index, titre, noeud]);

  const favori = app.favoris.includes(chemin);
  // Sous-pages déjà liées dans le corps (« / » → Sous-page) : pas de doublon en bas de page (liens dans le code ignorés)
  const liees = useMemo(() => {
    const res = new Set<string>();
    for (const nom of liensWiki(s.decoupe.corps || "")) res.add(resoudreLien(app.index, nom, chemin));
    return res;
  }, [app.index, chemin, etatEnr, statut]); // eslint-disable-line react-hooks/exhaustive-deps
  const tousEnfants = noeud?.enfants ?? [];
  const enfants = tousEnfants.filter((e) => !liees.has(e.chemin));

  const actions = (
    <>
      <button type="button" className="bouton-icone" onClick={() => app.basculerFavori(chemin)} aria-pressed={favori}
        aria-label={favori ? "Retirer des favoris" : "Ajouter aux favoris"} title={favori ? "Retirer des favoris" : "Ajouter aux favoris"}>
        <Star size={19} fill={favori ? "currentColor" : "none"} color={favori ? "var(--ambre)" : undefined} />
      </button>
      <button type="button" className="bouton-icone" onClick={(e) => void app.menuPage(chemin, e.currentTarget)} aria-label="Actions de la page" aria-haspopup="menu" title="Renommer, déplacer, supprimer…">
        <MoreHorizontal size={20} />
      </button>
    </>
  );

  if (statut === "introuvable") {
    return (
      <>
        <Entete fil={fil} />
        <main className="feuille">
          <EtatVide
            icone={<FileQuestion size={26} />}
            titre="Cette page n'existe pas"
            texte={<>Elle a pu être renommée, déplacée ou mise à la corbeille : <strong>{nomDePage(chemin)}</strong>.</>}
            actions={<>
              <button type="button" className="bouton" onClick={() => naviguer({ vue: "accueil" })}>Revenir à l'accueil</button>
              <button type="button" className="bouton bouton--primaire" onClick={async () => {
                try {
                  await api.ecrire(chemin, `# ${feuille(chemin)}\n\n`, null);
                  await app.rechargerArbre();
                  setStatut("chargement");
                  const p = await api.page(chemin);
                  appliquer(p.contenu, p.etag, true);
                  setStatut("pret");
                } catch (e) { app.notifier(`Création impossible : ${(e as Error).message}`); }
              }}>Créer cette page</button>
            </>}
          />
        </main>
      </>
    );
  }

  return (
    <>
      <Entete fil={fil} etat={etatEnr} actions={actions} />
      <main className="feuille" lang="fr">
        {statut === "chargement" && <SquelettePage />}
        {statut === "erreur" && (
          <EtatVide
            icone={<TriangleAlert size={26} />}
            titre="Impossible d'ouvrir cette page"
            texte={messageErreur || "Carnet n'a pas répondu."}
            actions={<button type="button" className="bouton bouton--primaire" onClick={() => window.location.reload()}>Réessayer</button>}
          />
        )}
        {statut === "pret" && (
          <>
            {conflit && (
              <div className="bandeau" role="alert">
                <p>{conflit.externe ? "Cette page vient d'être modifiée ailleurs (un agent ?), pendant que tu écrivais." : "Cette page a changé sur le disque depuis ton ouverture."}</p>
                <button type="button" className="primaire" onClick={() => void recharger(conflit.contenu, conflit.etag || undefined)}>Recharger leur version</button>
                <button type="button" onClick={() => void garderLaMienne()}>Garder la mienne</button>
              </div>
            )}
            <EnTetePage
              chemin={chemin}
              titre={titre}
              yaml={yaml}
              lectureSeule={Boolean(noeud?.lectureSeule)}
              surTitre={surTitre}
              validerTitre={() => void validerTitre()}
              // Entrée, Tab ou ↓ en fin de titre : curseur au début du premier bloc (créé au besoin)
              versCorps={() => s.ed?.focusDebut()}
              poserChamps={poserChamps}
            />
          </>
        )}
        <div className="editeur" ref={racineEditeur} hidden={statut !== "pret"} />
        {statut === "pret" && (
          <section className="sous-pages" aria-label="Sous-pages">
            {enfants.length > 0 && (
              <>
                <h2 className="sous-pages__titre">{enfants.length < tousEnfants.length ? "Autres sous-pages" : "Sous-pages"}</h2>
                <ul>
                  {enfants.map((e) => {
                    const route = e.type === "fichier" ? { vue: "fichier" as const, chemin: e.chemin } : { vue: "page" as const, chemin: e.chemin };
                    return (
                      <li key={e.chemin}>
                        <a className="ligne-page" href={urlDe(route)} onClick={(ev) => surLienInterne(ev, route)}>
                          <span className="ligne-page__icone"><IconePage icone={e.icone} dossier={!e.existe} fichier={e.type === "fichier"} ext={e.ext} /></span>
                          <span className="ligne-page__titre">{e.titre}</span>
                        </a>
                      </li>
                    );
                  })}
                </ul>
              </>
            )}
            <button type="button" className="ajout-sous-page" onClick={() => void app.nouvellePage(chemin)}>
              <Plus size={17} /> Ajouter une sous-page
            </button>
          </section>
        )}
      </main>
      {tactile && focus && edPret && <BarreClavier ed={edPret} surAction={() => { s.interagi = true; }} />}
    </>
  );
}
