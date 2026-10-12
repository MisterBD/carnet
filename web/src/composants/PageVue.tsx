// Une page : en-tête (couverture, icône, titre, propriétés, rétroliens), éditeur en blocs, sous-pages.
// Enregistrement automatique (seulement si la personne a vraiment modifié quelque chose, et seuls les blocs touchés
// sont réécrits), mise à jour en direct quand un agent modifie le fichier, bandeau en cas de conflit.
//
// Lot 4 (corrections) :
// - K2-01 : un « # Titre » tapé en tête du corps d'une page dont le titre n'est pas écrit en « # » (titre = nom du
//   fichier ou `title:`) n'est plus relu comme titre de la page : le titre de la page est écrit en « # » juste avant.
// - K2-02 / #9 : une seule file d'écriture par page. Renommer depuis le titre attend l'écriture en cours, écrit ce qui
//   attend à l'ancien chemin, PUIS renomme ; pendant le renommage, ni écriture ni relecture (reprises ensuite au
//   nouveau chemin). La vue reste la même (clé stable, navigation.ts : renommerSurPlace) : curseur et saisie gardés.
//   Une écriture refusée après fermeture de la page n'est jamais silencieuse (message + « Copier mon texte »).
// - #10 : adresse d'une page mise à la corbeille : « Cette page est dans la corbeille » + Restaurer.
// - #5 : ancre de l'adresse (« #Cette%20semaine ») : défilement jusqu'au titre une fois l'éditeur rempli.
//
// Lot 5 (fiabilité) :
// - toute saisie non confirmée par le serveur est gardée dans un BROUILLON DURABLE du navigateur (brouillons.ts), avec
//   sa révision de base et l'identifiant du geste (X-Carnet-Requete) ; au rechargement, il est rouvert tel quel et
//   renvoyé avec le MÊME identifiant (réponse perdue puis renvoi = une seule écriture) ; « Non enregistré » visible ;
// - erreur 5xx (serveur arrêté derrière le relais) traitée comme une coupure : nouvel essai, même identifiant ;
// - conflit : rien n'est fusionné ; comparaison, copie de conflit, leur version ou la mienne, au choix de la personne.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import "../styles/corrections.css";
import { FileQuestion, MoreHorizontal, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { api, apiBases, apiFiabilite, ErreurApi, nouvelleRequete, type Noeud } from "../api";
import * as brouillons from "../brouillons";
import { abandonnerRefus, BandeauBrouillon, BandeauConflit, BandeauRefus, copierRefus, creerCopieRefus, type NonEnregistre } from "./Fiabilite";
import type { EcrirePropriete } from "../bases/PanneauProprietes";
import { useApp, ancetres } from "../contexte-app";
import { ecouter } from "../evenements";
import { ancreCourante, lireRoute, naviguer, renommerRecentes, renommerSurPlace, surLienInterne, urlDe } from "../navigation";
import { inscrirePage } from "../enregistrement";
import { copierTexte } from "../actions-pages";
import type { EditeurCarnet } from "../editeur/creer";
import { fusionner, type Analyseur } from "../editeur/fidelite";
import type { ContexteEditeur } from "../editeur/contexte";
import { themeCadres } from "../editeur/cadres";
import {
  decouper, remplacerTexteH1, poserChamp, lireChampSimple, dossierDe, nomDePage, feuille, resoudre, nomDeFichier, commenceParH1,
  type Decoupe,
} from "../../../shared/page.ts";
import { liensWiki } from "../../../shared/navigation.ts";
import { Entete, type EtatEnregistrement, type MaillonFil } from "./Entete";
import { IconePage } from "./Icone";
import { EnTetePage } from "./EnTetePage";
import { BandeauxAgents, creerDemandeDecision } from "./BandeauxAgents";
import { EtatVide } from "./EtatVide";
import { SquelettePage } from "./Squelettes";
import { BarreClavier } from "./BarreClavier";
import { BandeauxPage, drapeaux, libelleGeste, messageFait, type Drapeau } from "../pages-drapeaux"; // lot 6
import { SurCettePage } from "./SurCettePage";
import { titreVise, defilerVersTitre } from "../ancres";
import { EntreePreparation, estPreparation } from "./PreparationEntree";
import { ilYA, tactile, trace } from "../outils";

type SourceTitre = "h1" | "fm" | "nom";

interface Etat {
  /** Chemin courant de la page (change quand elle est renommée depuis son titre). */
  chemin: string;
  original: string;
  decoupe: Decoupe;
  n0: string;
  etag: string | null;
  existe: boolean;
  interagi: boolean;
  titre: string;
  titreInitial: string;
  source: SourceTitre;
  /** Le nom du fichier suit le titre (page sans titre écrit, ou « Courses.md » / « # Courses ») : renommer le titre renomme le fichier. */
  nomSuit: boolean;
  fmModifie: boolean;
  enCours: boolean;
  /** Écriture en cours (un renommage attend sa fin) ; vrai = enregistrée. */
  ecriture: Promise<boolean> | null;
  /** > 0 : renommage ou opération de menu en cours : ni écriture ni relecture du disque (reprises ensuite). */
  bloque: number;
  aRefaire: boolean;
  minuterie: number | null;
  premierChangement: number | null;
  attenteReseau: number;
  ed: EditeurCarnet | null;
  /** Analyseur de blocs de l'éditeur, gardé après sa destruction (dernier enregistrement). */
  analyser: Analyseur | null;
  /** Markdown de l'éditeur figé à sa destruction : le dernier enregistrement part même page fermée. */
  mdFige: string | null;
  detruit: boolean;
  /** Une écriture extérieure a été signalée pendant notre propre enregistrement : à vérifier ensuite. */
  distanteEnAttente: boolean;
  /** « Garder la mienne » demandé : le prochain enregistrement écrase la version du conflit (instantané côté serveur). */
  ecraser: boolean;
  /** Identifiant d'idempotence de l'enregistrement en cours, réutilisé pour ses relances réseau (même page, même
   * contenu, même etag). Intégration lots 0 et 4 : le chemin en fait partie (renommage sur place du lot 4). */
  requete: { id: string; chemin: string; contenu: string; etag: string | null; ecraser: boolean } | null;
  /** Entrée dans le titre avant que l'éditeur soit prêt : le curseur ira au début du corps dès qu'il l'est. */
  versCorpsEnAttente: boolean;
  /** Lot 5 : brouillon rouvert au chargement (saisie non confirmée) : à renvoyer tel quel, même identifiant. */
  brouillonEnAttente: boolean;
  /** Lot 5 : contenu du fichier à la révision de base (`etag`), pour le brouillon. */
  baseContenu: string | null;
  minuterieBrouillon: number | null;
  /** Dernier état connu de la saisie (« conflit » gardé quand la page se ferme, pour l'écran Écritures en attente). */
  etatBrouillon: brouillons.EtatBrouillon;
}

interface Conflit { etag: string; contenu?: string; externe: boolean; absente?: boolean }

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
  const [essai, setEssai] = useState(0);
  const [messageErreur, setMessageErreur] = useState("");
  const [titre, setTitre] = useState("");
  const [yaml, setYaml] = useState("");
  const [etatEnr, setEtatEnr] = useState<EtatEnregistrement>("repos");
  const [conflit, setConflit] = useState<Conflit | null>(null);
  /** Finale V3 : saisie refusée (page verrouillée), gardée jusqu'à « Copier » ou « Jeter » (jamais abandonnée en silence). */
  const [refus, setRefus] = useState<{ chemin: string; texte: string; contenu: string; cle: string } | null>(null);
  const [focus, setFocus] = useState(false);
  const [edPret, setEdPret] = useState<EditeurCarnet | null>(null);
  const [enCorbeille, setEnCorbeille] = useState<null | { id: string; titre: string; date: number; avec: string | null; origine: string }>(null);
  const racineEditeur = useRef<HTMLDivElement>(null);
  const s = useRef<Etat>({
    chemin, original: "", decoupe: decouper(""), n0: "", etag: null, existe: true, interagi: false, titre: "", titreInitial: "",
    source: "nom", nomSuit: true, fmModifie: false, enCours: false, ecriture: null, bloque: 0, aRefaire: false, minuterie: null,
    premierChangement: null, attenteReseau: 2000, ed: null, analyser: null, mdFige: null, detruit: false, distanteEnAttente: false,
    versCorpsEnAttente: false, ecraser: false, requete: null, brouillonEnAttente: false, baseContenu: null, minuterieBrouillon: null, etatBrouillon: "en-attente",
  }).current;
  const [nonEnregistre, setNonEnregistre] = useState<NonEnregistre | null>(null);
  const espace = (): string => appRef.current.config?.espace ?? "";
  const appRef = useRef(app);
  appRef.current = app;
  // La vue est gardée quand la page est renommée depuis son titre : le chemin courant suit l'adresse.
  if (chemin !== s.chemin && !s.bloque) s.chemin = chemin;

  // ---------- Enregistrement ----------
  const mdCourant = useCallback((): string => (s.ed ? s.ed.getMarkdown() : s.mdFige ?? s.n0), [s]);

  const modifie = useCallback((): boolean => {
    const md = s.interagi ? mdCourant() : s.n0;
    // page sans titre écrit : son titre est le nom du fichier, il ne change qu'au renommage (validerTitre)
    return md !== s.n0 || (s.source !== "nom" && s.titre !== s.titreInitial) || s.fmModifie || s.brouillonEnAttente;
  }, [s, mdCourant]);

  /** Écriture refusée alors que la page n'est plus à l'écran : jamais en silence. */
  const signalerPerte = useCallback((texte: string, raison: string) => {
    const t = s.titre.trim() || feuille(s.chemin);
    appRef.current.notifier(`Dernières modifications de « ${t} » non enregistrées : ${raison}.`, {
      libelle: "Copier mon texte",
      faire: () => { appRef.current.notifier(copierTexte(texte) ? "Texte copié : colle-le dans la page." : "Copie refusée par le navigateur."); },
    }, 20000);
  }, [s]);

  const verifierDistant = useRef<() => Promise<void>>(async () => {});
  /** Relecture du disque (définie plus bas) : après un refus 423, la saisie refusée est abandonnée (lots 5 × 6). */
  const rechargerRef = useRef<() => Promise<void>>(async () => {});
  const enregistrerRef = useRef<() => Promise<boolean>>(async () => true);

  /** La page est-elle encore celle de l'adresse ? (après un déplacement ou une suppression, l'adresse change avant
   *  que la vue ne disparaisse : on ne relit plus alors l'ancien chemin, #9). */
  const affichee = useCallback((): boolean => {
    const r = lireRoute();
    return r.vue === "page" && r.chemin === s.chemin;
  }, [s]);

  /** Reprend ce qui a attendu la fin d'une écriture, d'un renommage ou d'une opération de menu. */
  const reprendre = useCallback(() => {
    if (s.bloque > 0 || s.enCours) return;
    if (s.aRefaire) { s.aRefaire = false; void enregistrerRef.current(); }
    else if (s.distanteEnAttente && !s.detruit) { s.distanteEnAttente = false; void verifierDistant.current(); }
  }, [s]);

  /** Ce qu'un enregistrement écrirait maintenant : calcul pur depuis l'état de la page (aucun effet). */
  const preparer = useCallback(() => {
    const md = s.interagi ? mdCourant() : s.n0;
    const d = s.decoupe;
    const analyser = s.ed?.analyser ?? s.analyser;
    const corps = md === s.n0 || !analyser ? (md === s.n0 ? d.corps : md) : fusionner(d.corps, s.n0, md, analyser);
    let fm = d.frontmatter;
    let blocTitre = d.blocTitre;
    let titreH1 = d.titreH1;
    let source = s.source;
    const t = s.titre.trim();
    if (source === "h1" && t) {
      if (!blocTitre) {
        // le titre devient une ligne « # » (titre qu'un nom de fichier ne sait pas porter, « Réunion : budget »)
        blocTitre = `# ${t}\n\n`;
        titreH1 = t;
      } else if (t !== d.titreH1) {
        blocTitre = remplacerTexteH1(blocTitre, t);
        // `title:` identique au « # Titre » : il suit (l'arbre et la recherche lisent `title:` en premier)
        const tf = lireChampSimple(d.yaml, "title");
        if (tf != null && d.titreH1 != null && tf.trim() === d.titreH1.trim()) fm = poserChamp(fm, "title", t);
        titreH1 = t;
      }
    }
    if (source === "fm" && t && t !== s.titreInitial) fm = poserChamp(fm, "title", t);
    // K2-01 : un « # Titre » en tête du corps serait relu comme titre de la page ; on écrit le titre de la page avant.
    // Page sans titre écrit : c'est le titre actuel (nom du fichier) ; un titre tapé mais pas encore validé suivra au
    // renommage. Page à `title:` : le même titre, en « # » (l'arbre lit `title:`, la page lit le « # » : ils concordent).
    if (source !== "h1" && commenceParH1(corps)) {
      const tp = (source === "fm" && t && t !== s.titreInitial ? t : s.titreInitial).replace(/\s*\n\s*/g, " ").trim() || feuille(s.chemin);
      blocTitre = `# ${tp}\n\n`;
      titreH1 = tp;
      source = "h1";
    }
    const contenu = fm + blocTitre + corps;
    const yamlNouveau = fm === d.frontmatter ? d.yaml : decouper(fm + "\n").yaml;
    return { md, d, corps, fm, blocTitre, titreH1, source, t, contenu, yamlNouveau };
  }, [s, mdCourant]);

  /** Identifiant d'idempotence du geste : le même tant que page, contenu, révision et « écraser » ne changent pas. */
  const requetePour = useCallback((cible: string, contenu: string, etagEnvoye: string | null) => {
    const rq = s.requete;
    if (!rq || rq.chemin !== cible || rq.contenu !== contenu || rq.etag !== etagEnvoye || rq.ecraser !== s.ecraser) {
      s.requete = { id: nouvelleRequete(), chemin: cible, contenu, etag: etagEnvoye, ecraser: s.ecraser };
    }
    return s.requete!;
  }, [s]);

  /** Lot 5 : brouillon durable de la saisie en cours (hors de l'espace, dans ce navigateur). */
  const brouillonDe = useCallback((cible: string, contenu: string, texte: string, rq: { id: string; etag: string | null; ecraser: boolean },
    etat: brouillons.EtatBrouillon = s.etatBrouillon, erreur?: string): brouillons.Brouillon => ({
    cle: brouillons.cleBrouillon(espace(), cible), onglet: brouillons.ONGLET, espace: espace(), chemin: cible, base: rq.etag, original: rq.etag === null ? null : s.baseContenu,
    contenu, texte, requete: rq.id, ecraser: rq.ecraser, titre: s.titre.trim() || feuille(cible), t: Date.now(), etat, ...(erreur ? { erreur } : {}),
  }), [s]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Garde la saisie en cours comme brouillon (ou le retire si elle ne diffère plus du fichier). */
  const memoriser = useCallback(async (): Promise<void> => {
    if (s.minuterieBrouillon) { window.clearTimeout(s.minuterieBrouillon); s.minuterieBrouillon = null; }
    if ((!s.ed && s.mdFige === null) || s.bloque > 0 || !espace()) return;
    if (!modifie()) return;
    // Lots 5 × 6 : aucun brouillon sur une page verrouillée (l'éditeur est en lecture seule, le serveur refuserait : 423)
    if (drapeaux(s.decoupe.yaml).verrou) return;
    const p = preparer();
    if (p.contenu === s.original && s.existe && !s.brouillonEnAttente) { void brouillons.retirer(espace(), s.chemin); return; }
    const rq = requetePour(s.chemin, p.contenu, s.existe ? s.etag : null);
    await brouillons.poser(brouillonDe(s.chemin, p.contenu, p.md, rq));
  }, [s, modifie, preparer, requetePour, brouillonDe]); // eslint-disable-line react-hooks/exhaustive-deps

  const enregistrer = useCallback(async (): Promise<boolean> => {
    if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
    s.premierChangement = null;
    if (!s.ed && s.mdFige === null) return true;
    if (s.enCours || s.bloque > 0) { s.aRefaire = true; return false; }
    if (!modifie()) { if (!s.detruit) setEtatEnr((e) => (e === "modifie" ? "enregistre" : e)); return true; }
    const { md, d, corps, fm, blocTitre, titreH1, source, t, contenu, yamlNouveau } = preparer();
    const accepter = () => {
      s.decoupe = { frontmatter: fm, yaml: yamlNouveau, blocTitre, titreH1, corps };
      s.source = source;
      s.n0 = md;
      if (source === "h1") s.titreInitial = titreH1 ?? s.titreInitial;
      else if (source === "fm" && t) s.titreInitial = t;
      // page sans titre écrit : le titre ne change qu'avec le nom du fichier (renommage)
      s.fmModifie = false;
    };
    if (contenu === s.original && s.existe && !s.brouillonEnAttente) {
      accepter();
      if (!s.detruit) setEtatEnr("enregistre");
      if (espace()) void brouillons.retirer(espace(), s.chemin);
      return true;
    }
    s.enCours = true;
    if (!s.detruit) setEtatEnr("enregistrement");
    const cible = s.chemin;
    // Socle : un identifiant d'idempotence par geste, réutilisé tel quel pour les relances réseau du même envoi.
    const etagEnvoye = s.existe ? s.etag : null;
    const requete = requetePour(cible, contenu, etagEnvoye);
    if (s.minuterieBrouillon) { window.clearTimeout(s.minuterieBrouillon); s.minuterieBrouillon = null; }
    const ecriture = (async (): Promise<boolean> => {
      // Lot 5 : le brouillon (avec l'identifiant du geste) est gardé AVANT l'envoi ; jamais bloquant plus de 400 ms.
      if (espace()) {
        await Promise.race([brouillons.poser(brouillonDe(cible, contenu, md, requete)), new Promise((r) => window.setTimeout(r, 400))]);
      }
      try {
        const r = await api.ecrire(cible, contenu, etagEnvoye, { requete: requete.id, ecraser: requete.ecraser });
        s.requete = null;
        s.ecraser = false;
        s.brouillonEnAttente = false;
        s.etatBrouillon = "en-attente";
        s.baseContenu = contenu;
        if (espace()) void brouillons.retirer(espace(), cible, requete.id);
        if (!s.detruit) setNonEnregistre(null);
        // Renvoi d'un geste déjà enregistré (réponse perdue) : le fichier a pu changer depuis, on relit le disque.
        if (r.rejoue) s.distanteEnAttente = true;
        trace("écrit", cible, r.etag, "distante en attente", s.distanteEnAttente);
        s.etag = r.etag;
        s.original = contenu;
        const etaitAbsente = !s.existe;
        s.existe = true;
        const changeTitre = source !== s.source || blocTitre !== d.blocTitre || fm !== d.frontmatter;
        accepter();
        s.attenteReseau = 2000;
        if (!s.detruit) { setEtatEnr("enregistre"); setYaml(s.decoupe.yaml); }
        if (etaitAbsente || changeTitre) void appRef.current.rechargerArbre();
        return true;
      } catch (e) {
        // 5xx (serveur arrêté derrière le relais, redémarrage) : traité comme une coupure, même identifiant au renvoi.
        const definitive = e instanceof ErreurApi && e.statut < 500;
        if (definitive) { s.requete = null; s.ecraser = false; }
        const verrou = definitive && (e as ErreurApi).statut === 423;
        if (espace() && verrou) {
          // 423 : rien à renvoyer, le brouillon posé avant l'envoi est retiré ; finale V3 : le TEXTE refusé est gardé à
          // part (« refusée », jamais renvoyé) jusqu'à ce que l'utilisateur le copie ou le jette.
          s.brouillonEnAttente = false;
          s.etatBrouillon = "en-attente";
          void brouillons.poserRefus(brouillonDe(cible, contenu, md, requete, "refuse", "page verrouillée"));
          void brouillons.retirer(espace(), cible);
        } else if (espace()) {
          const etatB: brouillons.EtatBrouillon = definitive && (e as ErreurApi).statut === 412 ? "conflit" : "echec";
          s.etatBrouillon = etatB;
          void brouillons.poser(brouillonDe(cible, contenu, md, requete, etatB, definitive ? (e as Error).message : "Carnet ne répond pas"));
        }
        if (definitive && (e as ErreurApi).statut === 412) {
          // page absente : déplacée ou mise à la corbeille pendant la saisie
          const absente = e.corps.etag === null && e.corps.contenu === null;
          if (!s.detruit) {
            setConflit({ etag: String(e.corps.etag ?? ""), contenu: typeof e.corps.contenu === "string" ? e.corps.contenu : undefined, externe: false, absente });
            setEtatEnr(absente ? "erreur" : "conflit");
          } else signalerPerte(md, absente ? "la page a été déplacée ou mise à la corbeille" : "la page a changé ailleurs entre-temps");
        } else if (verrou) {
          // Lots 5 × 6 : page verrouillée entre-temps (ailleurs) = REFUS DÉFINITIF. Jamais rejoué, jamais gardé comme
          // brouillon à renvoyer : le texte se copie (notification), puis la page se relit (lecture seule).
          s.aRefaire = false;
          if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
          if (s.detruit) signalerPerte(md, espace() ? "la page a été verrouillée (ton texte reste dans « Écritures en attente »)" : "la page a été verrouillée");
          else {
            setEtatEnr("erreur");
            setNonEnregistre(null);
            setRefus({ chemin: cible, texte: md, contenu, cle: brouillons.cleRefus(espace(), cible) });
            window.setTimeout(() => { if (!s.detruit) void rechargerRef.current(); }, 0);
          }
        } else if (definitive) {
          const m = (e as Error).message;
          if (!s.detruit) { setEtatEnr("erreur"); setNonEnregistre({ genre: "erreur", message: m }); }
          if (s.detruit) signalerPerte(md, m);
          else appRef.current.notifier(`Page non enregistrée : ${m}`);
        } else {
          // réseau : on réessaie (même page fermée : le texte figé part dès que Carnet répond)
          if (!s.detruit) { setEtatEnr("hors-ligne"); setNonEnregistre((x) => (x?.genre === "restaure" ? x : { genre: "reseau" })); }
          const attente = s.attenteReseau;
          s.attenteReseau = Math.min(attente * 2, 30000);
          s.minuterie = window.setTimeout(() => { void enregistrerRef.current(); }, attente);
        }
        return false;
      } finally {
        s.enCours = false;
        s.ecriture = null;
        reprendre();
      }
    })();
    s.ecriture = ecriture;
    return ecriture;
  }, [s, modifie, preparer, requetePour, brouillonDe, signalerPerte, reprendre]); // eslint-disable-line react-hooks/exhaustive-deps
  enregistrerRef.current = enregistrer;

  /** Écrit tout ce qui attend (écriture en cours comprise) ; vrai si la page est à jour sur le disque. */
  const vider = useCallback(async (): Promise<boolean> => {
    for (let k = 0; k < 8; k++) {
      if (s.ecriture) { if (!(await s.ecriture)) return false; continue; }
      if (s.bloque > 0) return !modifie();
      if (!modifie()) return true;
      if (!(await enregistrer()) && !s.ecriture) return !modifie();
    }
    return !modifie();
  }, [s, modifie, enregistrer]);

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
    // Lot 5 : la saisie est gardée dans le navigateur dès maintenant (brouillon), avant même l'envoi.
    if (s.minuterieBrouillon) window.clearTimeout(s.minuterieBrouillon);
    s.minuterieBrouillon = window.setTimeout(() => { void memoriser(); }, 250);
  }, [s, enregistrer, memoriser]);

  // ---------- Application d'un contenu (chargement, mise à jour en direct) ----------
  const appliquer = useCallback((contenu: string, etag: string | null, existe: boolean) => {
    const d = decouper(contenu);
    s.original = contenu;
    s.baseContenu = existe ? contenu : null;
    s.etag = etag;
    s.existe = existe;
    s.fmModifie = false;
    let source: SourceTitre = "nom";
    const n = appRef.current.index.get(s.chemin);
    let t = n?.nom ?? feuille(s.chemin);
    if (d.titreH1 != null) { source = "h1"; t = d.titreH1; }
    else {
      const tf = lireChampSimple(d.yaml, "title");
      if (tf) { source = "fm"; t = tf; }
    }
    if (!existe) {
      // page « dossier » sans fichier : elle naîtra avec un titre
      const nom = n?.nom ?? feuille(s.chemin);
      const nd = decouper(`# ${nom}\n\n`);
      s.decoupe = nd;
      source = "h1";
      t = nom;
    } else {
      s.decoupe = d;
    }
    s.source = source;
    s.nomSuit = source === "nom" || nomDeFichier(t) === feuille(s.chemin);
    s.titre = t;
    s.titreInitial = t;
    setTitre(t);
    setYaml(d.yaml);
    // Dépendances volontairement stables : un rafraîchissement de l'arbre ne doit JAMAIS relancer le chargement
    // (il remplacerait l'état de référence sans mettre à jour l'éditeur).
  }, [s]);

  // Chargement initial (et après une restauration depuis la corbeille)
  useEffect(() => {
    let annule = false;
    api.page(s.chemin).then(async (p) => {
      if (annule) return;
      if (p.absente && !p.dossier && !appRef.current.index.get(s.chemin)?.enfants.length) { setStatut("introuvable"); return; }
      // Lot 5 : une saisie non confirmée de cette page attend dans le navigateur ?
      let b = espace() ? await brouillons.lire(espace(), s.chemin).catch(() => null) : null;
      if (annule) return;
      if (!b && espace()) {
        // K11-02 : saisie laissée par un AUTRE onglet de ce navigateur qui n'est plus ouvert (fermé, planté) : reprise
        // ici, telle quelle (même geste). Celle d'un onglet encore ouvert n'est jamais prise : on le signale.
        const o = await brouillons.orphelins(espace(), s.chemin).catch(() => ({ orphelins: [] as brouillons.Brouillon[], autresVivants: [] as brouillons.Brouillon[] }));
        if (annule) return;
        if (o.orphelins.length) {
          b = await brouillons.adopter(o.orphelins[0]).catch(() => o.orphelins[0]);
          if (annule) return;
          if (o.orphelins.length > 1) appRef.current.notifier(`${o.orphelins.length - 1} autre${o.orphelins.length > 2 ? "s" : ""} saisie${o.orphelins.length > 2 ? "s" : ""} non enregistrée${o.orphelins.length > 2 ? "s" : ""} de cette page dans « Écritures en attente ».`, undefined, 12000);
        } else if (o.autresVivants.length) {
          appRef.current.notifier("Une saisie non enregistrée de cette page attend dans un autre onglet ouvert : termine-la là-bas (ou vois « Écritures en attente »).", undefined, 12000);
        }
      }
      if (b && !p.absente && p.contenu === b.contenu) {
        // déjà enregistrée (réponse perdue) : rien à renvoyer
        void brouillons.retirer(espace(), s.chemin, b.requete);
        b = null;
      }
      if (b && !p.absente && drapeaux(decouper(p.contenu).yaml).verrou) {
        // Lots 5 × 6 : la page a été verrouillée depuis la saisie : refus définitif, le brouillon n'est PAS renvoyé.
        // Finale V3 : son texte est gardé (« refusée ») jusqu'à « Copier » ou « Jeter », jamais abandonné en silence.
        // K11-01 : JAMAIS supprimé sans geste : gardé « refusé » (sans renvoi) jusqu'à Copier / Créer une copie / Abandonner.
        await brouillons.poserRefus({ ...b, erreur: "page verrouillée depuis ta saisie" });
        void brouillons.retirer(espace(), s.chemin);
        if (annule) return;
        setRefus({ chemin: s.chemin, texte: b.texte, contenu: b.contenu, cle: brouillons.cleRefus(espace(), s.chemin) });
        b = null;
      } else if (espace()) {
        const r = (await brouillons.refusDe(espace(), s.chemin).catch(() => [] as brouillons.Brouillon[]))[0];
        if (annule) return;
        if (r) setRefus({ chemin: s.chemin, texte: r.texte, contenu: r.contenu, cle: r.cle });
      }
      if (b) {
        // Rouverte telle quelle, sur SA révision de base, et renvoyée avec le même identifiant : si le serveur l'a déjà
        // reçue, il rejoue sa réponse ; sinon la révision attendue décide (écrite, ou conflit visible).
        appliquer(b.contenu, b.base, true);
        if (b.base === null) s.existe = false;
        s.baseContenu = b.original ?? (p.etag === b.base ? p.contenu : null);
        s.brouillonEnAttente = true;
        s.etatBrouillon = b.etat === "conflit" ? "conflit" : "en-attente";
        s.ecraser = b.ecraser;
        s.requete = { id: b.requete, chemin: s.chemin, contenu: b.contenu, etag: b.base, ecraser: b.ecraser };
        setNonEnregistre({ genre: "restaure", t: b.t });
        setEtatEnr("modifie");
      } else appliquer(p.contenu, p.etag, !p.absente);
      setEnCorbeille(null);
      setStatut("pret");
    }).catch((e) => {
      if (annule) return;
      setMessageErreur((e as Error).message);
      setStatut("erreur");
    });
    return () => { annule = true; };
  }, [s, appliquer, essai]);

  // Création de l'éditeur
  useEffect(() => {
    if (statut !== "pret" || !racineEditeur.current) return;
    const racine = racineEditeur.current;
    let ed: EditeurCarnet | null = null;
    let fini = false;
    s.mdFige = null;
    // Les accès au chemin passent par s.chemin : la page peut être renommée sans que l'éditeur soit recréé.
    const contexte: ContexteEditeur = {
      get chemin() { return s.chemin; },
      get dossier() { return dossierDe(s.chemin); },
      artBase: appRef.current.config?.artBase ?? "",
      urlFichier: (u: string) => {
        if (!u || /^(data:|blob:)/i.test(u)) return u;
        if (/^https?:/i.test(u) || u.startsWith("//")) return u; // externe : bloqué par la CSP, affiché comme lien cassé
        if (/^[a-z][a-z0-9+.-]*:/i.test(u)) return ""; // javascript:, file:… : jamais chargés
        const r = resoudre(dossierDe(s.chemin), u);
        return r ? `/api/fichier?chemin=${encodeURIComponent(r)}` : u;
      },
      ouvrirPage: (nom: string, ancre?: string | null) => {
        if (!nom && ancre) { naviguer({ vue: "page", chemin: s.chemin }, false, ancre); return; }
        naviguer({ vue: "page", chemin: resoudreLien(appRef.current.index, nom, s.chemin) }, false, ancre ?? null);
      },
      titreDe: (nom: string) => appRef.current.index.get(resoudreLien(appRef.current.index, nom, s.chemin))?.titre ?? null,
      televerserImage: async (f: File) => {
        s.interagi = true;
        try {
          const r = await api.televerser(s.chemin, f);
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
          const r = await api.creer(s.chemin, t);
          appRef.current.deplier(s.chemin);
          await appRef.current.rechargerArbre();
          return nomDePage(r.chemin);
        } catch (e) {
          appRef.current.notifier(`Sous-page non créée : ${(e as Error).message}`);
          return null;
        }
      },
      choisirPage: async () => {
        s.interagi = true;
        const c = await appRef.current.choisirPage({ titre: "Lier une page", exclure: s.chemin });
        return c ? nomDePage(c) : null;
      },
      choisirArtefact: () => { s.interagi = true; return appRef.current.choisirArtefact(); },
      creerDecision: () => { s.interagi = true; return creerDemandeDecision(appRef.current, chemin); },
      creerDepuisModele: () => { s.interagi = true; return appRef.current.nouvelleDepuisModele(s.chemin, false).then((c) => (c ? nomDePage(c) : null)); }, // lot 6
      pleinEcranArtefact: (c, t) => appRef.current.pleinEcran(c, t),
      theme: () => themeCadres(),
      notifier: (m: string) => appRef.current.notifier(m),
      demanderTexte: (o) => { s.interagi = true; return appRef.current.demanderTexte(o); },
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
      s.analyser = e.analyser;
      s.n0 = e.getMarkdown();
      setEdPret(e);
      if (s.versCorpsEnAttente) { s.versCorpsEnAttente = false; e.focusDebut(); }
      if (s.brouillonEnAttente) void enregistrerRef.current(); // lot 5 : brouillon rouvert, renvoyé tout de suite
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
        // Dernier enregistrement : le texte est figé AVANT la destruction de l'éditeur, il part même si une écriture
        // est encore en cours (elle sera suivie de celle-ci) ou si Carnet ne répond pas tout de suite.
        s.mdFige = ed.getMarkdown();
        s.analyser = ed.analyser;
        s.ed = null;
        if (modifie()) void enregistrer();
        void ed.detruire();
      }
      setEdPret(null);
    };
  }, [statut, s, planifier, enregistrer, modifie]);

  // Démontage : plus de mises à jour d'état
  useEffect(() => () => { s.detruit = true; }, [s]);

  // Enregistrer avant de quitter l'appli (iPhone : changement d'appli, verrouillage)
  useEffect(() => {
    // Lot 5 : copie SYNCHRONE du brouillon (localStorage) : une écriture IndexedDB peut ne pas aboutir à la fermeture.
    const garder = () => {
      if (!espace() || (!s.ed && s.mdFige === null)) return;
      if (drapeaux(s.decoupe.yaml).verrou) return; // lots 5 × 6 : pas de brouillon sur une page verrouillée
      const p = preparer();
      if (p.contenu === s.original && s.existe && !s.brouillonEnAttente) return;
      brouillons.poserSync(brouillonDe(s.chemin, p.contenu, p.md, requetePour(s.chemin, p.contenu, s.existe ? s.etag : null)));
    };
    const f = () => { if (document.visibilityState === "hidden" && modifie()) { garder(); void enregistrer(); } };
    const g = () => { if (modifie()) { garder(); void enregistrer(); } };
    document.addEventListener("visibilitychange", f);
    window.addEventListener("pagehide", g);
    return () => { document.removeEventListener("visibilitychange", f); window.removeEventListener("pagehide", g); };
  }, [modifie, enregistrer, preparer, brouillonDe, requetePour, s]); // eslint-disable-line react-hooks/exhaustive-deps

  // ---------- Mise à jour en direct ----------
  const recharger = useCallback(async (contenuConnu?: string, etagConnu?: string) => {
    let contenu = contenuConnu;
    let etag = etagConnu ?? null;
    if (contenu === undefined) {
      const p = await api.page(s.chemin).catch(() => null);
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
    // Lot 5 : la version du fichier est reprise : la saisie abandonnée n'est plus un brouillon en attente.
    if (s.brouillonEnAttente || s.requete) { s.brouillonEnAttente = false; s.requete = null; s.ecraser = false; }
    s.etatBrouillon = "en-attente";
    if (espace()) void brouillons.retirer(espace(), s.chemin);
    setNonEnregistre(null);
    setConflit(null);
    setEtatEnr("repos");
    requestAnimationFrame(() => window.scrollTo(0, y));
  }, [appliquer, s]); // eslint-disable-line react-hooks/exhaustive-deps

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
        // écriture, renommage ou opération de menu en cours : repris à la fin (jamais de lecture à un chemin qui change)
        if (s.enCours || s.bloque > 0) { s.distanteEnAttente = true; break; }
        if (!affichee() || s.detruit) break;
        const p = await api.page(s.chemin).catch(() => null);
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
        if (s.enCours || s.bloque > 0) { s.distanteEnAttente = true; break; }
        if (!modifie()) {
          // rien de neuf de notre côté (une minuterie peut tourner pour un changement déjà annulé) : on recharge
          if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
          await recharger(p.contenu, p.etag ?? undefined);
        }
        else {
          setConflit({ etag: p.etag ?? "", contenu: p.contenu, externe: true });
          // Finale V3 : le conflit prend le relais d'une coupure : la pastille ne dit plus « Hors ligne, nouvel essai… ».
          // Le renvoi automatique en attente est GARDÉ (même identifiant : une réponse perdue se rejoue sans doublon).
          setEtatEnr("conflit");
        }
      } while (sy.encore);
    } finally {
      sy.enCours = false;
    }
  }, [s, modifie, recharger, affichee]);
  verifierDistant.current = synchroniser;
  rechargerRef.current = () => recharger();

  useEffect(() => ecouter((ev) => {
    if (ev.type !== "modif" || ev.chemin !== s.chemin) return;
    trace("sse", ev.etag, "local", s.etag, "enCours", s.enCours, "bloque", s.bloque);
    if (ev.etag && ev.etag === s.etag) return; // notre propre écriture
    synchro.current.annonce = ev.etag || null;
    synchro.current.essais = 0;
    if (s.enCours || s.bloque > 0) { s.distanteEnAttente = true; return; } // on vérifiera à la fin
    void synchroniser();
  }), [s, synchroniser]);

  // Retour au premier plan (iPhone) : le flux d'événements a pu dormir, on vérifie la version du disque.
  useEffect(() => {
    const f = () => { if (document.visibilityState === "visible" && s.ed) void synchroniser(); };
    document.addEventListener("visibilitychange", f);
    return () => document.removeEventListener("visibilitychange", f);
  }, [s, synchroniser]);

  // Inscription au registre des pages ouvertes : les menus (renommer, déplacer, corbeille…) écrivent d'abord la
  // saisie en attente, puis suspendent la page pendant l'opération (#9 : plus de lecture à l'ancien chemin).
  useEffect(() => inscrirePage({
    chemin: () => s.chemin,
    vider,
    suspendre: () => {
      s.bloque++;
      let fait = false;
      return () => { if (fait) return; fait = true; s.bloque--; reprendre(); };
    },
  }), [s, vider, reprendre]);

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
    if (renommageEnCours.current || noeud?.lectureSeule) return;
    const t = s.titre.trim();
    if (!t) { s.titre = s.titreInitial; setTitre(s.titreInitial); return; }
    if (t !== s.titre) { s.titre = t; setTitre(t); }
    if (s.source === "nom" && (t === s.titreInitial || !s.existe)) return;
    renommageEnCours.current = true;
    try {
      // Titre qu'un nom de fichier ne sait pas porter tel quel (« Réunion : budget ») : il est écrit en « # » en tête.
      if (s.source === "nom" && nomDeFichier(t) !== t) s.source = "h1";
      // 1. Ce qui attend (titre écrit, corps) part d'abord, à l'ancien chemin, avec la version connue.
      if (!(await vider())) {
        if (s.source === "nom") appRef.current.notifier("Titre non changé : la page n'a pas pu être enregistrée.");
        return;
      }
      // 2. Le nom du fichier suit le titre : il est renommé (les liens qui y mènent aussi).
      const nom = nomDeFichier(t);
      if (!s.nomSuit || !s.existe || nom === feuille(s.chemin)) return;
      const ancien = s.chemin;
      const nomAvant = s.source === "nom";
      s.bloque++;
      try {
        const r = await api.renommer(ancien, nom);
        if (r.chemin !== ancien) {
          s.chemin = r.chemin;
          const a = nomDePage(ancien);
          const n = nomDePage(r.chemin);
          renommerSurPlace(ancien, r.chemin);
          renommerRecentes((c) => (c === ancien ? r.chemin : c.startsWith(a + "/") ? n + c.slice(a.length) : c));
          naviguer({ vue: "page", chemin: r.chemin }, true);
        }
        if (nomAvant) { s.titreInitial = feuille(r.chemin); s.titre = s.titreInitial; setTitre(s.titreInitial); }
        s.nomSuit = true;
        void appRef.current.rechargerArbre();
        if (r.liensMisAJour) appRef.current.notifier(`Page renommée, ${r.liensMisAJour} lien${r.liensMisAJour > 1 ? "s" : ""} mis à jour`);
      } catch (e) {
        if (nomAvant) {
          appRef.current.notifier(`Renommage impossible : ${(e as Error).message}`);
          s.titre = s.titreInitial;
          setTitre(s.titreInitial);
        } else appRef.current.notifier(`Titre enregistré, fichier non renommé : ${(e as Error).message}`);
      } finally {
        s.bloque--;
        reprendre();
      }
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

  // ---------- Propriétés (V3 lot 2) : UNE propriété écrite par le serveur, à la révision affichée ----------
  const ecrirePropriete: EcrirePropriete = async (cle, valeur, decl, revisionVue) => {
    s.interagi = true;
    const avant = s.etag;
    // Intégration lots 2 et 4 : la file d'écriture unique de la page passe d'abord (saisie en attente, écriture en
    // cours) ; la propriété est écrite au chemin COURANT (renommage sur place du lot 4).
    await vider();
    // Le panneau affichait la version d'avant notre propre enregistrement : c'est la nôtre, on suit.
    const revision = revisionVue === avant && s.etag ? s.etag : revisionVue;
    s.bloque++;
    try {
      const r = await apiBases.propriete(s.chemin, cle, valeur, revision, decl);
      s.etag = r.etag;
      s.original = r.contenu;
      s.baseContenu = r.contenu;
      s.decoupe = decouper(r.contenu);
      if (!s.detruit) setYaml(s.decoupe.yaml);
    } catch (e) {
      // version venue d'ailleurs : la page la reprend (ou affiche le bandeau si une saisie est en cours)
      if (e instanceof ErreurApi && e.statut === 412) s.distanteEnAttente = true;
      throw e;
    } finally {
      s.bloque--;
      reprendre();
    }
  };

  // ---------- Lot 6 : verrou et archive (propriétés de l'en-tête) ----------
  const { verrou: verrouillee, archive: archivee } = useMemo(() => drapeaux(yaml), [yaml]);
  // K11-03 : sous-page d'une page archivée (archive héritée) : dit avec quelle page, et mène à elle pour désarchiver
  const archiveeAvec = useMemo(() => {
    if (archivee) return null;
    const segs = chemin.replace(/\.md$/, "").split("/");
    for (let i = segs.length - 1; i > 0; i--) {
      const parent = segs.slice(0, i).join("/") + ".md";
      const n = app.index.get(parent);
      if (n?.archive) return { chemin: parent, titre: n.titre || feuille(parent) };
    }
    return null;
  }, [archivee, chemin, app.index]);
  const [drapeauEnCours, setDrapeauEnCours] = useState(false);
  const basculerDrapeau = async (cle: Drapeau, poser: boolean) => {
    setDrapeauEnCours(true);
    try {
      await ecrirePropriete(cle, poser ? true : undefined, { type: null, options: null }, s.etag ?? "");
      appRef.current.notifier(messageFait(cle, poser));
      void appRef.current.rechargerArbre();
    } catch (e) {
      appRef.current.notifier(`${libelleGeste(cle, poser)} : impossible (${(e as Error).message})`);
    } finally {
      if (!s.detruit) setDrapeauEnCours(false);
    }
  };
  // Page verrouillée : l'éditeur passe en lecture seule (saisie, collage, glisser, menus) ; il redevient modifiable au
  // déverrouillage. Le serveur refuse de toute façon les écritures de contenu (423).
  useEffect(() => {
    if (!edPret) return;
    if (edPret.tiptap.isEditable === verrouillee) edPret.tiptap.setEditable(!verrouillee);
  }, [edPret, verrouillee]);

  // ---------- Conflit ----------
  const garderLaMienne = async () => {
    if (!conflit) return;
    // Lots 5 × 6 : leur version est verrouillée : l'écraser serait refusé (423). Rien n'est écrit.
    if (conflit.contenu !== undefined && drapeaux(decouper(conflit.contenu).yaml).verrou) {
      appRef.current.notifier("Leur version est verrouillée : « Garder la mienne » est impossible. Garde les deux (copie de conflit) ou copie ton texte.", undefined, 12000);
      return;
    }
    let etag = conflit.etag;
    if (!etag) {
      const p = await api.page(s.chemin).catch(() => null);
      if (!p) { appRef.current.notifier("Carnet ne répond pas : réessaie dans un instant."); return; }
      etag = p.etag ?? "";
    }
    s.etag = etag;
    s.ecraser = true; // le serveur garde la version écrasée en instantané (Historique)
    setConflit(null);
    s.fmModifie = true; // force l'écriture
    void enregistrer();
  };

  /**
   * Lot 5 · « Garder les deux » : ta version part dans une COPIE DE CONFLIT à nom unique, à côté de la page
   * (« <Page> (conflit AAAA-MM-JJ HHhMM).md », créée par le serveur sans jamais écraser) ; la page reprend la version
   * du fichier, intacte. Rien n'est fusionné.
   */
  const requeteCopie = useRef<{ contenu: string; id: string } | null>(null);
  const copieConflit = async () => {
    if (!conflit) return;
    const { contenu } = preparer();
    if (!requeteCopie.current || requeteCopie.current.contenu !== contenu) requeteCopie.current = { contenu, id: nouvelleRequete() };
    try {
      const r = await apiFiabilite.copieConflit(s.chemin, contenu, requeteCopie.current.id);
      requeteCopie.current = null;
      await appRef.current.rechargerArbre();
      await recharger(conflit.contenu, conflit.etag || undefined);
      const sans = (r.retires ?? []).map((x) => (x === "archive" ? "non archivée" : "non verrouillée")).join(", ");
      appRef.current.notifier(`Ta version est gardée dans « ${feuille(r.chemin)} »${sans ? ` (copie ${sans}, pour rester visible et modifiable)` : ""}`, {
        libelle: "Ouvrir", faire: () => naviguer({ vue: "page", chemin: r.chemin }),
      }, 12000);
    } catch (e) {
      appRef.current.notifier(`Copie de conflit impossible : ${(e as Error).message}. Ton texte est toujours là.`);
    }
  };

  /** Lot 5 · « Prendre leur version » : explicite, avec confirmation (ta saisie est abandonnée). */
  const prendreLeur = async () => {
    if (!conflit) return;
    const ok = await appRef.current.confirmer({
      titre: "Prendre leur version ?", danger: true, bouton: "Prendre leur version",
      texte: "Ta saisie non enregistrée sera abandonnée (copie-la d'abord si tu en as besoin). Le fichier ne change pas.",
    });
    if (ok) await recharger(conflit.contenu, conflit.etag || undefined);
  };

  /** Page déplacée ou supprimée pendant la saisie : la recréer à son adresse avec le texte à l'écran. */
  const recreer = () => {
    s.existe = false;
    s.etag = null;
    s.fmModifie = true;
    setConflit(null);
    void enregistrer();
  };

  // ---------- Ancres (#5) ----------
  useEffect(() => {
    if (!edPret) return;
    const aller = (ancre: string | null, doux: boolean) => {
      if (!ancre || !s.ed) return;
      const el = titreVise(s.ed, ancre);
      if (el) defilerVersTitre(el, doux); // ancre inconnue : la page reste en haut, sans erreur
    };
    const a = ancreCourante();
    if (a) requestAnimationFrame(() => requestAnimationFrame(() => aller(a, false)));
    const f = (e: Event) => aller(String((e as CustomEvent).detail ?? ""), true);
    window.addEventListener("carnet:ancre", f);
    return () => window.removeEventListener("carnet:ancre", f);
  }, [edPret, s]);

  // ---------- Page introuvable : est-elle dans la corbeille ? (#10) ----------
  useEffect(() => {
    if (statut !== "introuvable") return;
    let annule = false;
    api.corbeille().then((r) => {
      if (annule) return;
      const base = (c: string) => c.replace(/\.md$/i, "");
      const recents = [...r.elements].sort((a, b) => b.date - a.date);
      const exact = recents.find((e) => e.chemin === s.chemin);
      const parent = exact ? undefined : recents.find((e) => s.chemin.startsWith(base(e.chemin) + "/"));
      const el = exact ?? parent;
      if (el) setEnCorbeille({ id: el.id, titre: el.titre, date: el.date, avec: exact ? null : el.titre, origine: el.chemin });
    }).catch(() => { /* corbeille illisible : écran habituel */ });
    return () => { annule = true; };
  }, [statut, s]);

  const restaurerDepuisCorbeille = async () => {
    if (!enCorbeille) return;
    try {
      const r = await api.restaurer(enCorbeille.id);
      await app.rechargerArbre();
      const base = (c: string) => c.replace(/\.md$/i, "");
      const vise = enCorbeille.avec ? base(r.chemin) + s.chemin.slice(base(enCorbeille.origine).length) : r.chemin;
      app.notifier(r.renomme ? `Restaurée sous le nom « ${feuille(r.chemin)} »` : "Page restaurée");
      if (vise === s.chemin) { setEnCorbeille(null); setStatut("chargement"); setEssai((x) => x + 1); }
      else naviguer({ vue: "page", chemin: vise }, true);
    } catch (e) {
      app.notifier(`Restauration impossible : ${(e as Error).message}`);
    }
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
      {statut === "pret" && <SurCettePage.Bouton ed={edPret} />}
      <button type="button" className="bouton-icone entete__favori" onClick={() => app.basculerFavori(chemin)} aria-pressed={favori}
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
          {enCorbeille ? (
            <EtatVide
              icone={<Trash2 size={26} />}
              titre="Cette page est dans la corbeille"
              texte={enCorbeille.avec
                ? <>Elle a été mise à la corbeille {ilYA(enCorbeille.date)} avec sa page parente « {enCorbeille.avec} ». Restaurer remet les deux à leur place.</>
                : <>« {enCorbeille.titre} » a été mise à la corbeille {ilYA(enCorbeille.date)}. Tu peux la remettre à sa place.</>}
              actions={<>
                <a className="bouton" href={urlDe({ vue: "corbeille" })} onClick={(e) => surLienInterne(e, { vue: "corbeille" })}>Voir la corbeille</a>
                <button type="button" className="bouton bouton--primaire" onClick={() => void restaurerDepuisCorbeille()}>Restaurer</button>
              </>}
            />
          ) : (
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
          )}
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
            {conflit && conflit.absente && (
              <div className="bandeau" role="alert">
                <p>Cette page a été déplacée ou mise à la corbeille pendant que tu écrivais. Ton texte est toujours là.</p>
                <button type="button" className="primaire" onClick={recreer}>Recréer la page avec mon texte</button>
                <button type="button" onClick={() => app.notifier(copierTexte(mdCourant()) ? "Texte copié" : "Copie refusée par le navigateur")}>Copier mon texte</button>
              </div>
            )}
            {conflit && !conflit.absente && (
              <BandeauConflit
                externe={conflit.externe}
                leur={conflit.contenu}
                mien={() => preparer().contenu}
                surCopieConflit={copieConflit}
                surPrendreLeur={() => void prendreLeur()}
                surGarderMienne={() => void garderLaMienne()}
                leurVerrouillee={conflit.contenu !== undefined && drapeaux(decouper(conflit.contenu).yaml).verrou}
                surCopier={() => app.notifier(copierTexte(mdCourant()) ? "Texte copié" : "Copie refusée par le navigateur")}
              />
            )}
            {refus && refus.chemin === s.chemin && (
              <BandeauRefus
                surCopier={() => copierRefus(app, refus)}
                surCreerCopie={async () => { if (await creerCopieRefus(app, refus, nouvelleRequete())) setRefus(null); }}
                surAbandonner={async () => { if (await abandonnerRefus(app, refus)) setRefus(null); }}
              />
            )}
            {!conflit && nonEnregistre && (
              <BandeauBrouillon
                etat={nonEnregistre}
                surReessayer={() => {
                  if (s.minuterie) { window.clearTimeout(s.minuterie); s.minuterie = null; }
                  s.attenteReseau = 2000;
                  if (!modifie()) { setNonEnregistre(null); return; }
                  void enregistrer();
                }}
                surCopier={() => app.notifier(copierTexte(mdCourant()) ? "Texte copié" : "Copie refusée par le navigateur")}
              />
            )}
            <EnTetePage
              chemin={chemin}
              titre={titre}
              yaml={yaml}
              lectureSeule={Boolean(noeud?.lectureSeule) || verrouillee}
              surTitre={surTitre}
              validerTitre={() => void validerTitre()}
              // Entrée, Tab ou ↓ en fin de titre : curseur au début du premier bloc (créé au besoin)
              versCorps={() => { if (s.ed) s.ed.focusDebut(); else s.versCorpsEnAttente = true; }}
              poserChamps={poserChamps}
              ecrirePropriete={ecrirePropriete}
              avantProprietes={estPreparation(yaml) ? <EntreePreparation chemin={chemin} yaml={yaml} /> : undefined}
            />
            <BandeauxAgents chemin={chemin} yaml={yaml} />
            {!estPreparation(yaml) && <EntreePreparation chemin={chemin} yaml={yaml} />}
            <BandeauxPage verrou={verrouillee} archive={archivee} archiveeAvec={archiveeAvec} basculer={(c, p) => void basculerDrapeau(c, p)} occupe={drapeauEnCours} />
          </>
        )}
        <div className="editeur" ref={racineEditeur} hidden={statut !== "pret"} data-pret={edPret ? "true" : undefined}
          data-verrou={verrouillee ? "true" : undefined} />
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
      {statut === "pret" && <SurCettePage.Panneau ed={edPret} />}
      {tactile && focus && edPret && !verrouillee && <BarreClavier ed={edPret} surAction={() => { s.interagi = true; }} />}
    </>
  );
}
