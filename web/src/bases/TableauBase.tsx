// Carnet · bases : vue tableau vivante d'un bloc ```base (rendue dans l'éditeur, à la place du code).
// - Lecture : POST /api/base/evaluer avec le YAML affiché ; mise à jour en direct (événements du serveur).
// - Cellules : UNE propriété écrite par /api/propriete, à la révision affichée (conflit visible, saisie conservée).
// - Tri au clic, filtres simples : le serveur renvoie le nouveau YAML (ou refuse s'il ne sait pas tout conserver),
//   l'éditeur remplace le texte du bloc ; la page s'enregistre comme pour toute modification.
// - Bloc ou expression non pris en charge : erreurs affichées, JAMAIS un tableau vide.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import {
  AlertTriangle, ArrowDown, ArrowUp, Braces, CalendarCheck, CalendarClock, CalendarX, Copy, FileText, Filter, Info, ListFilter, Lock, MoreHorizontal, Pencil, Plus,
  Save, Table2, Trash2, Type, X,
} from "lucide-react";
import { apiBases, ErreurApi } from "../api";
import type { ApercuAujourdhui, ChangementVueBase, DeclarationAujourdhuiBase, EtatVueBase, ReecritureBase } from "../api";
import { ecouter } from "../evenements";
import { IconePage } from "../composants/Icone";
import { surLienInterne, urlDe } from "../navigation";
import {
  decrireFiltreSimple, ecrireFiltreSimple, LIBELLES_OPERATEURS, OPERATEURS_JOURS, typeDeValeur,
} from "../../../shared/bases.ts";
import { oublierVueBase, vueBaseRetenue } from "./vueRetenue";
import type {
  ColonneBase, ErreurBase, FiltreAffiche, OperateurSimple, ResultatBase, Tri, TypePropriete, ValeurSaisie,
} from "../../../shared/bases.ts";
import { ChampValeur } from "./ChampValeur";
import { ICONES_TYPES } from "./icones";
import { texteDate, texteInstant, texteNombre } from "./format";
import "./bases.css";

export interface ProprietesTableauBase {
  /** Page qui contient le bloc. */
  chemin: string;
  /** YAML du bloc (texte courant de l'éditeur). */
  source: string;
  /** L'éditeur est modifiable (sinon : lecture seule, aucune réécriture). */
  modifiable: boolean;
  /** Remplace le texte du bloc dans l'éditeur. */
  remplacerSource(nouveau: string): void;
  yamlVisible: boolean;
  basculerYaml(): void;
  notifier(message: string): void;
}

type Etat =
  | { k: "chargement" }
  | { k: "ok"; r: ResultatBase }
  | { k: "erreur"; message: string; erreurs: ErreurBase[]; vues?: ResultatBase["vues"] }
  | { k: "panne"; message: string };


function operateursPour(type: TypePropriete): OperateurSimple[] {
  switch (type) {
    case "statut": case "selection": return ["est", "nest_pas", "vide", "non_vide"];
    case "nombre": return ["est", "nest_pas", "inf", "sup", "vide", "non_vide"];
    // lot 12 : choix relatifs d'abord (ils suivent la date du jour), puis dates fixes
    case "date": return ["jusqu_aujourdhui", "avant_aujourdhui", "aujourdhui", "prochains_jours", "au_plus_tard", "plus_de_jours", "cette_semaine", "avant", "apres", "est", "vide", "non_vide"];
    case "case": return ["coche", "non_coche"];
    case "liste": return ["contient", "ne_contient_pas", "vide", "non_vide"];
    default: return ["est", "nest_pas", "contient", "ne_contient_pas", "vide", "non_vide"];
  }
}

function libelleFiltre(f: FiltreAffiche, colonnes: ColonneBase[]): string {
  if (!f.simple) return f.expression;
  const c = colonnes.find((x) => x.cle === f.simple!.propriete);
  const nom = c?.libelle ?? f.simple.propriete;
  return decrireFiltreSimple(f.simple, nom, (v) =>
    typeof v === "number" ? texteNombre(v) : c?.type === "date" || /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? texteDate(String(v)) : `« ${v} »`);
}

/** Lot 12 : l'expression suit l'horloge (today(), now()) : la vue change seule d'un jour à l'autre. */
function suitLHorloge(source: string): boolean {
  return /\b(today|now)\s*\(/.test(source);
}

/** Résultat d'une réécriture demandée par l'interface. */
type Reecriture = { ok: true } | { ok: false; message: string; erreur?: ErreurBase };

// ------------------------------------------------------------------------------------------------ K14-01 : vues

/** Formulaire de nom de vue : nouvelle (copie de la vue courante), renommer, enregistrer la vue filtrée comme nouvelle. */
interface FormVue {
  mode: "nouvelle" | "renommer" | "enregistrer" | "relancer";
  cible: number;
  /** Raccourci « À relancer » : statuts à exclure, choisis par la personne (aucun par défaut : rien de deviné). */
  exclus: string[];
  nom: string;
  /** « Enregistrer comme nouvelle vue » : remettre la vue de départ comme avant (filtres et tri d'origine). */
  retablir: boolean;
  erreur: string | null;
  envoi: boolean;
}

/** Même règle que le serveur : casse, accents et espaces ignorés (la ligne « À relancer » d'Aujourd'hui aussi). */
function plierNom(s: string): string {
  return s.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().replace(/\s+/g, " ").trim();
}

/** Refus lisible d'un nom de vue (le serveur refait le contrôle), ou null. */
function erreurNomVue(nom: string, noms: string[], sauf = -1): string | null {
  if (!nom) return "Nom vide : donne un nom à la vue.";
  if (nom.length > 80) return "Nom trop long : 80 caractères au plus.";
  const i = noms.findIndex((x, j) => j !== sauf && plierNom(x) === plierNom(nom));
  return i === -1 ? null : `Une vue s'appelle déjà « ${noms[i]} » : choisis un autre nom.`;
}

// ------------------------------------------------------------------------------------------------ Échéances

/** Formulaire « Afficher dans Aujourd'hui » : choix proposés d'après le schéma, aperçu calculé par le serveur. */
interface FormAujourdhui {
  echeance: string;
  propriete: string;
  /** Valeur « fait » : une option (texte) ; "true" pour une case à cocher. */
  valeur: string;
  priorite: string | null;
  apercu: ApercuAujourdhui | null;
  erreur: string | null;
  envoi: boolean;
}

type Declaree = NonNullable<ResultatBase["declarees"]>[number];

/** Propriétés qui peuvent dire « fait » : statut ou sélection à options, case à cocher. */
function candidatsFait(d: Declaree[]): Declaree[] {
  return d.filter((x) => ((x.type === "statut" || x.type === "selection") && x.options && x.options.length > 0) || x.type === "case");
}

/** Pré-choix (à confirmer par la personne, jamais écrit sans elle) : l'échéance, le statut, « Fait ». */
function formAujourdhuiInitial(r: ResultatBase): FormAujourdhui | null {
  const d = r.declarees ?? [];
  const dates = d.filter((x) => x.type === "date");
  const faits = candidatsFait(d);
  if (!dates.length || !faits.length) return null;
  const a = r.aujourdhui;
  if (a) {
    return { echeance: a.echeance, propriete: a.fait.propriete, valeur: String(a.fait.valeur), priorite: a.priorite, apercu: null, erreur: null, envoi: false };
  }
  const nom = (x: Declaree) => `${plierNom(x.cle)} ${plierNom(x.libelle)}`;
  const echeance = dates.length === 1 ? dates[0] : dates.find((x) => /echeance|due|deadline|limite/.test(nom(x))) ?? dates[0];
  const fait = faits.find((x) => /statut|status|etat/.test(nom(x))) ?? faits[0];
  const valeur = fait.type === "case" ? "true" : (fait.options!.find((o) => /^(fait|faite|done|termine|terminee|complete|completed)$/.test(plierNom(o))) ?? fait.options![fait.options!.length - 1]);
  const priorite = d.find((x) => (x.type === "selection" || x.type === "statut") && /priorit/.test(nom(x)))?.cle ?? null;
  return { echeance: echeance.cle, propriete: fait.cle, valeur, priorite, apercu: null, erreur: null, envoi: false };
}

function declarationDe(f: FormAujourdhui, d: Declaree[]): DeclarationAujourdhuiBase {
  const fait = d.find((x) => x.cle === f.propriete);
  return { echeance: f.echeance, fait: { propriete: f.propriete, valeur: fait?.type === "case" ? f.valeur === "true" : f.valeur }, ...(f.priorite ? { priorite: f.priorite } : {}) };
}

function texteApercu(a: ApercuAujourdhui): string {
  if (!a.dossier) return "Carnet ne sait pas quel dossier contient les fiches de cette base (déclare carnet.dossier) : rien ne remonterait.";
  const morceaux = [`${a.enRetard} en retard`, `${a.aujourdhui} aujourd'hui`, `${a.aVenir} à venir`];
  const hors: string[] = [];
  if (a.sansDate) hors.push(`${a.sansDate} sans échéance`);
  if (a.faites) hors.push(`${a.faites} déjà faite${a.faites > 1 ? "s" : ""}`);
  return `${a.fiches} fiche${a.fiches > 1 ? "s" : ""} apparaîtr${a.fiches > 1 ? "ont" : "a"} dans Aujourd'hui : ${morceaux.join(", ")}.`
    + (hors.length ? ` Ne remontent pas : ${hors.join(", ")}.` : "");
}

export function TableauBase(p: ProprietesTableauBase) {
  const [vue, setVue] = useState(0);
  const [etat, setEtat] = useState<Etat>({ k: "chargement" });
  const [message, setMessage] = useState<string | null>(null);
  const [formFiltre, setFormFiltre] = useState(false);
  const [nouvelle, setNouvelle] = useState<string | null>(null);
  const [creation, setCreation] = useState(false);
  const [voirAvert, setVoirAvert] = useState(false);
  // K14-01 : menu « … » de la vue, formulaire de nom, confirmation de suppression
  const [menuVue, setMenuVue] = useState(false);
  const [formVue, setFormVue] = useState<FormVue | null>(null);
  const [suppression, setSuppression] = useState<number | null>(null);
  // Échéances : formulaire « Afficher dans Aujourd'hui » (propriété date, valeur « fait », aperçu)
  const [formAuj, setFormAuj] = useState<FormAujourdhui | null>(null);
  /** Filtres et tri d'origine d'une vue filtrée ou triée pendant cette visite (« Enregistrer comme nouvelle vue… »). */
  const [origines, setOrigines] = useState<Record<number, { origine: EtatVueBase; modifiee: boolean }>>({});
  const boutonOptions = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const idForm = useId();
  /** Révisions connues après nos propres écritures (avant que la vue ne soit relue). */
  const etagsLocaux = useRef(new Map<string, string>());
  const seq = useRef(0);
  const sourceRef = useRef(p.source);
  sourceRef.current = p.source;
  const vueRef = useRef(vue);
  vueRef.current = vue;

  const evaluer = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await apiBases.evaluer(p.chemin, sourceRef.current, vueRef.current);
      if (n !== seq.current) return;
      etagsLocaux.current.clear();
      setEtat({ k: "ok", r });
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof ErreurApi && e.statut === 422 && Array.isArray(e.corps.erreurs)) {
        setEtat({ k: "erreur", message: e.message, erreurs: e.corps.erreurs as ErreurBase[], vues: e.corps.vues as ResultatBase["vues"] | undefined });
      } else {
        setEtat({ k: "panne", message: e instanceof ErreurApi ? e.message : "Carnet ne répond pas." });
      }
    }
  }, [p.chemin]);

  // YAML ou vue changés : relecture (légèrement différée pendant la frappe dans le YAML)
  useEffect(() => {
    const t = window.setTimeout(() => void evaluer(), etat.k === "chargement" ? 0 : 350);
    return () => window.clearTimeout(t);
  }, [p.source, vue, evaluer]); // eslint-disable-line react-hooks/exhaustive-deps

  // Lot 12 : vue demandée en arrivant (lien « À relancer : N » de l'écran Aujourd'hui), appliquée une fois
  const vueVerifiee = useRef(false);
  useEffect(() => {
    if (etat.k !== "ok" || vueVerifiee.current) return;
    vueVerifiee.current = true;
    const nom = vueBaseRetenue(p.chemin);
    if (!nom) return;
    const i = etat.r.vues.findIndex((v) => v.nom === nom && v.prise);
    if (i < 0) return; // vue d'une autre base de la même page
    oublierVueBase(p.chemin);
    if (i !== vueRef.current) setVue(i);
  }, [etat, p.chemin]);

  // Lot 12 : une base qui suit la date du jour se relit au retour au premier plan (visibilitychange), à la reconnexion
  // au serveur (événement « connexion ouverte », plus bas) et chaque minute tant qu'elle est visible : la vue ouverte
  // pendant le passage de minuit change d'elle-même dans la minute, sans aucun événement sur les fichiers.
  const horloge = suitLHorloge(p.source);
  useEffect(() => {
    if (!horloge) return;
    const relire = () => { if (document.visibilityState === "visible") void evaluer(); };
    document.addEventListener("visibilitychange", relire);
    const t = window.setInterval(relire, 60 * 1000);
    return () => { document.removeEventListener("visibilitychange", relire); window.clearInterval(t); };
  }, [horloge, evaluer]);

  // Mise à jour en direct : une page créée, modifiée ou supprimée peut entrer ou sortir de la base
  useEffect(() => {
    let m: number | null = null;
    const fin = ecouter((e) => {
      if (e.type !== "modif" && e.type !== "arbre" && !(e.type === "connexion" && e.etat === "ouverte")) return;
      if (m) window.clearTimeout(m);
      m = window.setTimeout(() => void evaluer(), 250);
    });
    return () => { fin(); if (m) window.clearTimeout(m); };
  }, [evaluer]);

  const r = etat.k === "ok" ? etat.r : null;

  const reecrire = async (changement: Parameters<typeof apiBases.reecrire>[2], dansFormulaire = false): Promise<Reecriture> => {
    setMessage(null);
    if (!p.modifiable) { setMessage("Page en lecture seule : la vue ne peut pas être modifiée."); return { ok: false, message: "Page en lecture seule." }; }
    try {
      const v = vueRef.current;
      const res = await apiBases.reecrire(sourceRef.current, v, changement);
      if (!res.inchange) p.remplacerSource(res.source);
      // K14-01 : on retient l'état de la vue AVANT le premier filtre ou tri de cette visite
      const avant = res.avant, apres = res.apres;
      if (avant && apres) {
        setOrigines((o) => {
          const origine = o[v]?.origine ?? avant;
          return { ...o, [v]: { origine, modifiee: JSON.stringify(apres) !== JSON.stringify(origine) } };
        });
      }
      return { ok: true };
    } catch (e) {
      const message = e instanceof ErreurApi ? e.message : "Carnet ne répond pas : réessaie dans un instant.";
      const erreurs = e instanceof ErreurApi && Array.isArray(e.corps.erreurs) ? (e.corps.erreurs as ErreurBase[]) : [];
      if (!dansFormulaire) setMessage(message);
      return { ok: false, message, erreur: erreurs[0] };
    }
  };

  const trierPar = (c: ColonneBase) => {
    if (!r) return;
    if (c.nature !== "note" && c.nature !== "fichier") return;
    const actuel = r.tri.length === 1 && r.tri[0].propriete === c.id ? r.tri[0].sens : null;
    const suivant: Tri[] | null = actuel === null ? [{ propriete: c.id, sens: "ASC" }] : actuel === "ASC" ? [{ propriete: c.id, sens: "DESC" }] : null;
    void reecrire({ tri: suivant });
  };

  const ecrireCellule = async (chemin: string, c: ColonneBase, v: ValeurSaisie, revision: string) => {
    const res = await apiBases.propriete(chemin, c.cle!, v, revision, { type: c.type, options: c.options });
    etagsLocaux.current.set(chemin, res.etag);
    void evaluer();
  };

  const creer = async () => {
    if (nouvelle === null || creation) return;
    setCreation(true);
    setMessage(null);
    try {
      const res = await apiBases.entree(p.chemin, sourceRef.current, nouvelle.trim());
      setNouvelle(null);
      p.notifier(`Entrée créée : ${res.chemin.split("/").pop()?.replace(/\.md$/, "")}`);
      void evaluer();
    } catch (e) {
      setMessage(e instanceof ErreurApi ? `Entrée non créée : ${e.message}` : "Carnet ne répond pas : réessaie dans un instant.");
    } finally {
      setCreation(false);
    }
  };

  const vues = r?.vues ?? (etat.k === "erreur" ? etat.vues : undefined) ?? [];
  const titre = vues[vue]?.nom ?? "Base";

  // ---------------------------------------------------------------------------------------------- K14-01 : vues
  const gestionVues = !!r && p.modifiable && r.reecriture.possible;
  const modifieeIci = gestionVues && !!origines[vue]?.modifiee;

  const changerVues = async (changement: ChangementVueBase, cible: number): Promise<{ ok: true; res: ReecritureBase } | { ok: false; message: string }> => {
    setMessage(null);
    if (!p.modifiable) return { ok: false, message: "Page en lecture seule : les vues ne peuvent pas être modifiées." };
    try {
      const res = await apiBases.reecrire(sourceRef.current, cible, changement);
      if (!res.inchange) p.remplacerSource(res.source);
      return { ok: true, res };
    } catch (e) {
      return { ok: false, message: e instanceof ErreurApi ? e.message : "Carnet ne répond pas : réessaie dans un instant." };
    }
  };

  const ouvrirForm = (mode: FormVue["mode"], cible: number) => {
    setMenuVue(false);
    setSuppression(null);
    setFormVue({ mode, cible, nom: mode === "renommer" ? (vues[cible]?.nom ?? "") : mode === "relancer" ? "À relancer" : "", retablir: true, exclus: [], erreur: null, envoi: false });
  };

  const validerFormVue = async () => {
    const f = formVue;
    if (!f || f.envoi) return;
    const nom = f.nom.replace(/\s+/g, " ").trim();
    const err = erreurNomVue(nom, vues.map((v) => v.nom), f.mode === "renommer" ? f.cible : -1);
    if (err) { setFormVue({ ...f, erreur: err }); return; }
    setFormVue({ ...f, envoi: true, erreur: null });
    const origine = origines[f.cible]?.origine;
    let changement: ChangementVueBase;
    if (f.mode === "renommer") changement = { renommerVue: nom };
    else if (f.mode === "relancer" && relance) {
      // prochaine relance aujourd'hui ou avant (jour seul), statuts exclus SEULEMENT s'ils ont été cochés
      const filtres = [ecrireFiltreSimple({ propriete: relance.date.cle!, operateur: "jusqu_aujourdhui", valeur: null })];
      if (relance.statut) for (const o of f.exclus) filtres.push(ecrireFiltreSimple({ propriete: relance.statut.cle!, operateur: "nest_pas", valeur: o }));
      changement = { nouvelleVue: { nom, filtres, tri: [{ propriete: relance.date.id, sens: "ASC" }] } };
    } else changement = { nouvelleVue: { nom, ...(f.mode === "enregistrer" && f.retablir && origine ? { retablir: origine } : {}) } };
    const x = await changerVues(changement, f.cible);
    if (!x.ok) { setFormVue((g) => g && { ...g, envoi: false, erreur: x.message }); return; }
    setFormVue(null);
    const depart = vues[f.cible]?.nom ?? "";
    // renommer : l'onglet change sous les yeux ; pas d'annonce (l'enregistrement, lui, peut encore échouer en conflit)
    if (f.mode === "renommer") return;
    if (f.mode === "enregistrer") setOrigines((o) => { const c = { ...o }; delete c[f.cible]; return c; });
    setVue(x.res.vue);
    if (f.mode === "enregistrer" && x.res.retablie) p.notifier(`Vue « ${x.res.nom ?? nom} » créée ; « ${depart} » est revenue comme avant.`);
    else if (f.mode === "enregistrer" && x.res.retablie === false) p.notifier(`Vue « ${x.res.nom ?? nom} » créée ; « ${depart} » garde ses filtres (${x.res.raisonNonRetablie ?? "réécriture refusée"}).`, );
    else p.notifier(`Vue « ${x.res.nom ?? nom} » créée.`);
  };

  // Raccourci « Créer la vue À relancer » : une propriété date nommée comme une relance, et aucune vue de ce nom
  const relance = (() => {
    if (!r || !gestionVues || vues.some((v) => plierNom(v.nom) === "a relancer")) return null;
    const dates = r.colonnes.filter((c) => c.nature === "note" && c.cle && c.type === "date"
      && /(^|[_\s-])relance/.test(plierNom(c.cle)) && !/dernier/.test(plierNom(c.cle)));
    const date = dates.find((c) => /prochain/.test(plierNom(c.cle!))) ?? dates[0];
    if (!date) return null;
    const statut = r.colonnes.find((c) => c.nature === "note" && c.cle && /^(statut|status)$/.test(plierNom(c.cle))
      && (c.type === "statut" || c.type === "selection") && c.options && c.options.length > 0) ?? null;
    return { date, statut };
  })();

  const dupliquer = async (cible: number) => {
    setMenuVue(false);
    const x = await changerVues({ dupliquerVue: true }, cible);
    if (!x.ok) { setMessage(`Vue non dupliquée : ${x.message}`); return; }
    setVue(x.res.vue);
    p.notifier(`Vue dupliquée : « ${x.res.nom ?? ""} ».`);
  };

  const supprimer = async (cible: number) => {
    const nom = vues[cible]?.nom ?? "";
    const x = await changerVues({ supprimerVue: true }, cible);
    setSuppression(null);
    if (!x.ok) { setMessage(`Vue non supprimée : ${x.message}`); return; }
    setOrigines({}); // les rangs des vues suivantes changent
    setVue(x.res.vue);
    p.notifier(`Vue « ${nom} » supprimée (les pages, elles, ne bougent pas).`);
  };

  // ---------------------------------------------------------------------------------------------- Échéances
  const declarees = r?.declarees ?? [];
  const aujourdhuiPossible = !!r && gestionVues && !!formAujourdhuiInitial(r);

  const apercevoir = async (f: FormAujourdhui) => {
    try {
      const res = await apiBases.reecrire(sourceRef.current, vueRef.current, { aujourdhui: declarationDe(f, declarees) }, p.chemin);
      setFormAuj((g) => g && g.echeance === f.echeance && g.propriete === f.propriete && g.valeur === f.valeur ? { ...g, apercu: res.apercu ?? null, erreur: null } : g);
    } catch (e) {
      setFormAuj((g) => g && { ...g, apercu: null, erreur: e instanceof ErreurApi ? e.message : "Carnet ne répond pas : réessaie dans un instant." });
    }
  };

  const ouvrirAujourdhui = () => {
    if (!r) return;
    setMenuVue(false); setFormVue(null); setSuppression(null);
    const f = formAujourdhuiInitial(r);
    setFormAuj(f);
    if (f) void apercevoir(f);
  };

  const changerFormAuj = (ch: Partial<FormAujourdhui>) => {
    const g = formAuj;
    if (!g) return;
    const n = { ...g, ...ch, apercu: null, erreur: null };
    if (ch.propriete && ch.propriete !== g.propriete) {
      const x = declarees.find((y) => y.cle === ch.propriete);
      n.valeur = x?.type === "case" ? "true" : (x?.options?.find((o) => /^(fait|faite|done|termine|terminee|complete)$/.test(plierNom(o))) ?? x?.options?.[x.options.length - 1] ?? "");
    }
    setFormAuj(n);
    void apercevoir(n);
  };

  const validerAujourdhui = async () => {
    const f = formAuj;
    if (!f || f.envoi) return;
    setFormAuj({ ...f, envoi: true, erreur: null });
    const x = await changerVues({ aujourdhui: declarationDe(f, declarees) }, vue);
    if (!x.ok) { setFormAuj((g) => g && { ...g, envoi: false, erreur: x.message }); return; }
    setFormAuj(null);
    p.notifier(r?.aujourdhui ? "Réglage d'Aujourd'hui modifié." : `Les fiches datées de cette base apparaissent maintenant dans Aujourd'hui.`);
  };

  const retirerAujourdhui = async () => {
    setMenuVue(false);
    const x = await changerVues({ aujourdhui: null }, vue);
    if (!x.ok) { setMessage(`Réglage non retiré : ${x.message}`); return; }
    setFormAuj(null);
    p.notifier("Les fiches de cette base n'apparaissent plus dans Aujourd'hui.");
  };

  // menu « … » : premier choix sous le doigt ; Échap ou un clic ailleurs le referme
  useEffect(() => {
    if (!menuVue) return;
    menuRef.current?.querySelector<HTMLButtonElement>("[role=menuitem]:not(:disabled)")?.focus();
    const dehors = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menuRef.current?.contains(t) && !boutonOptions.current?.contains(t)) setMenuVue(false);
    };
    document.addEventListener("pointerdown", dehors, true);
    return () => document.removeEventListener("pointerdown", dehors, true);
  }, [menuVue]);

  return (
    <div className="base" data-etat={etat.k}>
      <div className="base__tete">
        <span className="base__titre"><Table2 size={18} aria-hidden="true" />{vues.length <= 1 && <span>{titre}</span>}</span>
        {vues.length > 1 && (
          <span className="base__vues" role="tablist" aria-label="Vues de la base">
            {vues.map((v, i) => (
              <button key={i} type="button" role="tab" aria-selected={i === vue} className="base__vue" onClick={() => { setVue(i); setMenuVue(false); }}
                onDoubleClick={() => { if (gestionVues && i === vue) ouvrirForm("renommer", i); }}
                onContextMenu={(e) => { if (!gestionVues) return; e.preventDefault(); setVue(i); setFormVue(null); setMenuVue(true); }}
                title={v.prise ? v.nom : `${v.nom} (vue ${v.type} non prise en charge)`}>
                {v.nom}
              </button>
            ))}
          </span>
        )}
        {gestionVues && (
          <button type="button" ref={boutonOptions} className="base__bouton base__vue-options" aria-haspopup="menu" aria-expanded={menuVue}
            aria-label={`Options de la vue « ${titre} »`} title="Nouvelle vue, dupliquer, renommer, supprimer"
            onClick={() => { setFormVue(null); setSuppression(null); setMenuVue((x) => !x); }}>
            <MoreHorizontal size={18} aria-hidden="true" />
          </button>
        )}
        <span className="base__espace" />
        {r && p.modifiable && r.filtres !== null && r.reecriture.possible && (
          <button type="button" className="base__bouton" aria-expanded={formFiltre} onClick={() => setFormFiltre((x) => !x)}>
            <ListFilter size={16} aria-hidden="true" /> <span>Filtrer</span>
          </button>
        )}
        <button type="button" className="base__bouton" aria-pressed={p.yamlVisible} onClick={p.basculerYaml}>
          <Braces size={16} aria-hidden="true" /> <span>{p.yamlVisible ? "Masquer le YAML" : "Voir le YAML"}</span>
        </button>
        {r && (
          <button type="button" className="base__bouton base__bouton--primaire" disabled={!p.modifiable || !r.dossier}
            title={r.dossier ? `Nouvelle page dans ${r.dossier}` : "Déclare le dossier des nouvelles entrées (carnet.dossier) dans le YAML"}
            onClick={() => setNouvelle((x) => (x === null ? "" : x))}>
            <Plus size={16} aria-hidden="true" /> <span>Nouveau</span>
          </button>
        )}
      </div>

      {menuVue && gestionVues && (
        <div className="base__menu-vue" role="menu" aria-label={`Vue « ${titre} »`} ref={menuRef}
          onKeyDown={(e) => {
            if (e.key === "Escape") { e.preventDefault(); setMenuVue(false); boutonOptions.current?.focus(); return; }
            if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
            e.preventDefault();
            const items = [...(menuRef.current?.querySelectorAll<HTMLButtonElement>("[role=menuitem]:not(:disabled)") ?? [])];
            const i = items.indexOf(document.activeElement as HTMLButtonElement);
            const pas = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : -1;
            items[(i + pas + items.length) % items.length]?.focus();
          }}>
          <span className="base__menu-titre" aria-hidden="true">Vue « {titre} » :</span>
          <button type="button" role="menuitem" className="base__menu-choix" onClick={() => ouvrirForm("nouvelle", vue)}>
            <Plus size={16} aria-hidden="true" /> Nouvelle vue…
          </button>
          {relance && (
            <button type="button" role="menuitem" className="base__menu-choix" onClick={() => ouvrirForm("relancer", vue)}>
              <CalendarClock size={16} aria-hidden="true" /> Créer la vue « À relancer »…
            </button>
          )}
          <button type="button" role="menuitem" className="base__menu-choix" onClick={() => void dupliquer(vue)}>
            <Copy size={16} aria-hidden="true" /> Dupliquer
          </button>
          <button type="button" role="menuitem" className="base__menu-choix" onClick={() => ouvrirForm("renommer", vue)}>
            <Pencil size={16} aria-hidden="true" /> Renommer…
          </button>
          <button type="button" role="menuitem" className="base__menu-choix base__menu-choix--danger" disabled={vues.length <= 1}
            title={vues.length <= 1 ? "Une base garde au moins une vue." : undefined}
            onClick={() => { setMenuVue(false); setSuppression(vue); }}>
            <Trash2 size={16} aria-hidden="true" /> Supprimer…
          </button>
          {vues.length <= 1 && <span className="base__menu-note">Une base garde au moins une vue.</span>}
          {aujourdhuiPossible && (
            <button type="button" role="menuitem" className="base__menu-choix" onClick={ouvrirAujourdhui}>
              <CalendarCheck size={16} aria-hidden="true" /> {r?.aujourdhui ? "Réglage d'Aujourd'hui…" : "Afficher dans Aujourd'hui…"}
            </button>
          )}
          {r?.aujourdhui && gestionVues && (
            <button type="button" role="menuitem" className="base__menu-choix" onClick={() => void retirerAujourdhui()}>
              <CalendarX size={16} aria-hidden="true" /> Ne plus afficher dans Aujourd'hui
            </button>
          )}
        </div>
      )}

      {formAuj && gestionVues && r && (
        <form className="base__form-vue base__form-aujourdhui" aria-labelledby={`${idForm}-auj`} onSubmit={(e) => { e.preventDefault(); void validerAujourdhui(); }}>
          <p className="base__form-vue-titre" id={`${idForm}-auj`}>
            <CalendarCheck size={16} aria-hidden="true" /><span>Afficher les fiches datées dans Aujourd'hui (en retard, aujourd'hui, à venir)</span>
          </p>
          <div className="base__form-aujourdhui-champs">
            <label className="base__form-aujourdhui-champ">
              <span>Échéance (propriété date)</span>
              <select className="base__nouvelle-champ" value={formAuj.echeance} disabled={formAuj.envoi}
                onChange={(e) => changerFormAuj({ echeance: e.target.value })}>
                {declarees.filter((x) => x.type === "date").map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
              </select>
            </label>
            <label className="base__form-aujourdhui-champ">
              <span>Fait quand…</span>
              <select className="base__nouvelle-champ" value={formAuj.propriete} disabled={formAuj.envoi}
                onChange={(e) => changerFormAuj({ propriete: e.target.value })}>
                {candidatsFait(declarees).map((x) => <option key={x.cle} value={x.cle}>{x.libelle}</option>)}
              </select>
            </label>
            {declarees.find((x) => x.cle === formAuj.propriete)?.type !== "case" && (
              <label className="base__form-aujourdhui-champ">
                <span>… vaut</span>
                <select className="base__nouvelle-champ" value={formAuj.valeur} disabled={formAuj.envoi}
                  onChange={(e) => changerFormAuj({ valeur: e.target.value })}>
                  {(declarees.find((x) => x.cle === formAuj.propriete)?.options ?? []).map((o) => <option key={o} value={o}>{o}</option>)}
                </select>
              </label>
            )}
          </div>
          <p className="base__form-vue-aide" role="status" aria-live="polite">
            {formAuj.apercu ? texteApercu(formAuj.apercu) : formAuj.erreur ? null : "Calcul de l'aperçu…"}
            {" "}Cocher une fiche depuis Aujourd'hui écrit « {declarees.find((x) => x.cle === formAuj.propriete)?.libelle ?? formAuj.propriete} : {formAuj.valeur === "true" ? "cochée" : formAuj.valeur} » dans la fiche.
            {formAuj.priorite && <> Priorité affichée : « {declarees.find((x) => x.cle === formAuj.priorite)?.libelle ?? formAuj.priorite} ».</>}
          </p>
          <div className="base__form-vue-ligne">
            <button type="submit" className="bouton bouton--petit bouton--primaire" disabled={formAuj.envoi || !formAuj.apercu || !formAuj.apercu.dossier}>
              {r.aujourdhui ? "Enregistrer" : "Afficher dans Aujourd'hui"}
            </button>
            <button type="button" className="bouton bouton--petit" onClick={() => setFormAuj(null)}>Annuler</button>
          </div>
          {formAuj.erreur && <p className="base__form-erreur" role="alert">{formAuj.erreur}</p>}
        </form>
      )}

      {formVue && gestionVues && (
        <form className="base__form-vue" aria-labelledby={`${idForm}-titre`} onSubmit={(e) => { e.preventDefault(); void validerFormVue(); }}>
          <label className="base__form-vue-titre" id={`${idForm}-titre`} htmlFor={`${idForm}-nom`}>
            {formVue.mode === "renommer" ? `Renommer la vue « ${vues[formVue.cible]?.nom ?? ""} »`
              : formVue.mode === "enregistrer" ? "Enregistrer comme nouvelle vue (filtres, tri et colonnes affichés)"
              : formVue.mode === "relancer" && relance ? `Créer la vue « À relancer » : « ${relance.date.libelle} » aujourd'hui ou avant, la plus ancienne en haut`
              : `Nouvelle vue (copie de « ${vues[formVue.cible]?.nom ?? ""} » : filtres, tri et colonnes)`}
          </label>
          <div className="base__form-vue-ligne">
            <input id={`${idForm}-nom`} className="base__nouvelle-champ" autoFocus value={formVue.nom} disabled={formVue.envoi} maxLength={80}
              placeholder="Nom de la vue" enterKeyHint="done" autoComplete="off"
              aria-invalid={formVue.erreur ? true : undefined} aria-describedby={formVue.erreur ? `${idForm}-erreur` : undefined}
              onChange={(e) => { const nom = e.target.value; setFormVue((f) => f && { ...f, nom, erreur: null }); }}
              onKeyDown={(e) => { if (e.key === "Escape") setFormVue(null); }} />
            <button type="submit" className="bouton bouton--petit bouton--primaire" disabled={formVue.envoi}>
              {formVue.mode === "renommer" ? "Renommer" : "Créer la vue"}
            </button>
            <button type="button" className="bouton bouton--petit" onClick={() => setFormVue(null)}>Annuler</button>
          </div>
          {formVue.mode === "relancer" && relance && (
            <>
              <p className="base__form-vue-aide">Ce nom fait apparaître la ligne « À relancer : N » dans Aujourd'hui. Colonnes reprises de « {vues[formVue.cible]?.nom} ».</p>
              {relance.statut && (
                <fieldset className="base__form-vue-statuts">
                  <legend>Ne pas montrer les fiches dont « {relance.statut.libelle} » est (facultatif) :</legend>
                  {relance.statut.options!.map((o) => (
                    <label key={o} className="base__form-vue-case">
                      <input type="checkbox" checked={formVue.exclus.includes(o)} disabled={formVue.envoi}
                        onChange={(e) => { const oui = e.target.checked; setFormVue((f) => f && { ...f, exclus: oui ? [...f.exclus, o] : f.exclus.filter((x) => x !== o) }); }} />
                      <span>{o}</span>
                    </label>
                  ))}
                </fieldset>
              )}
            </>
          )}
          {formVue.mode === "enregistrer" && origines[formVue.cible] && (
            <label className="base__form-vue-case">
              <input type="checkbox" checked={formVue.retablir} disabled={formVue.envoi}
                onChange={(e) => { const retablir = e.target.checked; setFormVue((f) => f && { ...f, retablir }); }} />
              <span>Remettre « {vues[formVue.cible]?.nom} » comme avant (sans ces filtres ni ce tri)</span>
            </label>
          )}
          {formVue.erreur && <p className="base__form-erreur" role="alert" id={`${idForm}-erreur`}>{formVue.erreur}</p>}
        </form>
      )}

      {suppression !== null && gestionVues && vues[suppression] && (
        <div className="base__confirmer" role="alertdialog" aria-labelledby={`${idForm}-suppr`}>
          <p id={`${idForm}-suppr`}>
            <Trash2 size={15} aria-hidden="true" /> Supprimer la vue « {vues[suppression].nom} » ? Les pages de la base ne sont pas touchées : seule cette vue disparaît.
          </p>
          <div className="base__form-vue-ligne">
            <button type="button" className="bouton bouton--petit bouton--danger" autoFocus onClick={() => void supprimer(suppression)}>Supprimer la vue</button>
            <button type="button" className="bouton bouton--petit" onClick={() => setSuppression(null)}>Annuler</button>
          </div>
        </div>
      )}

      {r && (r.filtresGlobaux.length > 0 || (r.filtres && r.filtres.length > 0) || r.filtres === null || modifieeIci) && (
        <div className="base__filtres" aria-label="Filtres">
          {r.filtresGlobaux.map((f, i) => (
            <span key={`g${i}`} className="base__filtre base__filtre--global" title="Filtre de toute la base (modifiable dans le YAML)" data-simple="true">
              <Lock size={12} aria-hidden="true" /> {f}
            </span>
          ))}
          {r.filtres === null && (
            <span className="base__filtre base__filtre--global"><Filter size={12} aria-hidden="true" /> Filtres avancés de la vue : voir le YAML</span>
          )}
          {r.filtres?.map((f) => (
            <span key={f.index} className="base__filtre" data-simple={f.simple ? "true" : undefined}>
              <span className="base__filtre-texte">{libelleFiltre(f, r.colonnes)}</span>
              {p.modifiable && r.reecriture.possible && (
                <button type="button" className="base__filtre-retirer" aria-label={`Retirer le filtre ${libelleFiltre(f, r.colonnes)}`}
                  onClick={() => void reecrire({ retirerFiltre: f.index })}>
                  <X size={14} aria-hidden="true" />
                </button>
              )}
            </span>
          ))}
          {modifieeIci && (
            <button type="button" className="base__enregistrer-vue" onClick={() => ouvrirForm("enregistrer", vue)}>
              <Save size={14} aria-hidden="true" /> Enregistrer comme nouvelle vue…
            </button>
          )}
        </div>
      )}

      {r?.exclusions && r.exclusions.length > 0 && (
        <ul className="base__exclusions" role="status" aria-label="Pages écartées faute de date">
          {r.exclusions.map((t) => <li key={t}><Info size={14} aria-hidden="true" /> {t}</li>)}
        </ul>
      )}

      {formFiltre && r && (
        <FormulaireFiltre colonnes={r.colonnes} fermer={() => setFormFiltre(false)}
          ajouter={async (expr) => { const x = await reecrire({ ajouterFiltre: expr }, true); if (x.ok) setFormFiltre(false); return x; }} />
      )}

      {message && <p className="base__message" role="alert"><AlertTriangle size={15} aria-hidden="true" /> {message}</p>}
      {r && !r.reecriture.possible && p.modifiable && (
        <p className="base__note"><Info size={14} aria-hidden="true" /> Tri et filtres modifiables seulement dans le YAML : {r.reecriture.raison}</p>
      )}

      {etat.k === "chargement" && <div className="base__chargement" aria-busy="true">Chargement de la base…</div>}

      {etat.k === "panne" && (
        <div className="base__erreurs" role="alert">
          <p><AlertTriangle size={16} aria-hidden="true" /> Impossible d'afficher la base : {etat.message}</p>
          <button type="button" className="bouton bouton--petit" onClick={() => void evaluer()}>Réessayer</button>
        </div>
      )}

      {etat.k === "erreur" && (
        <div className="base__erreurs" role="alert">
          <p className="base__erreurs-titre"><AlertTriangle size={16} aria-hidden="true" /> Carnet ne peut pas afficher cette base : aucun résultat n'est montré.</p>
          <ul>
            {etat.erreurs.slice(0, 12).map((x, i) => (
              <li key={i}>
                <code className="base__ou">{x.ou}</code> {x.message}
                {x.expression !== undefined && (
                  <pre className="base__expr">{x.expression}{x.position !== undefined ? `\n${" ".repeat(Math.min(x.position, x.expression.length))}^` : ""}</pre>
                )}
              </li>
            ))}
          </ul>
          {!p.yamlVisible && <button type="button" className="bouton bouton--petit" onClick={p.basculerYaml}>Voir le YAML</button>}
        </div>
      )}

      {r && (
        <>
          <div className="base__defile" role="region" aria-label={`Tableau ${titre} (défilement horizontal)`} tabIndex={0}
            onScroll={(e) => { const d = e.currentTarget; const v = d.scrollLeft > 2 ? "true" : "false"; if (d.dataset.defile !== v) d.dataset.defile = v; }}>
            <table className="base__table">
              <thead>
                <tr>
                  {r.colonnes.map((c, i) => {
                    const tri = r.tri.find((t) => t.propriete === c.id);
                    const Ic = c.type ? ICONES_TYPES[c.type] : c.nature === "fichier" ? (i === 0 ? FileText : Info) : Type;
                    const triable = c.nature === "note" || c.nature === "fichier";
                    return (
                      <th key={c.id} scope="col" className={i === 0 ? "base__col0" : undefined}
                        aria-sort={tri ? (tri.sens === "ASC" ? "ascending" : "descending") : undefined} data-probleme={c.probleme ? "true" : undefined}>
                        <button type="button" className="base__entete" disabled={!triable || !p.modifiable || !r.reecriture.possible}
                          title={c.probleme ?? (triable ? "Trier par cette colonne (croissant, décroissant, sans tri)" : undefined)}
                          onClick={() => trierPar(c)}>
                          <Ic size={14} aria-hidden="true" className="base__entete-icone" />
                          <span className="base__entete-texte">{c.libelle}</span>
                          {tri && (tri.sens === "ASC" ? <ArrowUp size={14} aria-label="croissant" /> : <ArrowDown size={14} aria-label="décroissant" />)}
                          {c.probleme && <AlertTriangle size={13} aria-label="non pris en charge" />}
                        </button>
                      </th>
                    );
                  })}
                </tr>
              </thead>
              <tbody>
                {r.lignes.map((l) => (
                  <tr key={l.chemin}>
                    {r.colonnes.map((c, i) => {
                      const cel = l.cellules[c.id] ?? { etat: "absente" as const };
                      if (i === 0 && c.nature === "fichier" && (c.id === "file.name" || c.id === "file.basename")) {
                        return (
                          <th key={c.id} scope="row" className="base__col0">
                            <a className="base__lien" href={urlDe({ vue: "page", chemin: l.chemin })}
                              onClick={(e) => surLienInterne(e, { vue: "page", chemin: l.chemin })}>
                              <span className="base__lien-icone"><IconePage icone={l.icone} /></span>
                              <span className="base__lien-titre">{l.titre}</span>
                            </a>
                            {l.nonModifiable && (
                              <span className="base__verrou" title={`Lecture seule : ${l.nonModifiable} (corrige le fichier)`} aria-label={`Lecture seule : ${l.nonModifiable}`}>
                                <Lock size={13} aria-hidden="true" />
                              </span>
                            )}
                          </th>
                        );
                      }
                      if (c.nature !== "note") {
                        let t = "";
                        if (c.probleme) t = "—";
                        else if (cel.texte !== undefined) t = cel.texte;
                        else if ((c.id === "file.mtime" || c.id === "file.ctime") && typeof cel.valeur === "number") t = texteInstant(cel.valeur);
                        else if (c.id === "file.size" && typeof cel.valeur === "number") t = `${texteNombre(Math.ceil(cel.valeur / 1024))} Ko`;
                        else if (Array.isArray(cel.valeur)) t = cel.valeur.join(", ");
                        else if (cel.valeur !== undefined && cel.valeur !== null) t = String(cel.valeur);
                        return <td key={c.id} className={i === 0 ? "base__col0" : undefined} data-lecture="true"><span className="base__lecture">{t}</span></td>;
                      }
                      const revision = etagsLocaux.current.get(l.chemin) ?? l.etag;
                      return (
                        <td key={c.id} className={i === 0 ? "base__col0" : undefined}>
                          <ChampValeur
                            dans="cellule"
                            valeur={cel.etat === "valeur" ? cel.valeur : cel.etat === "nulle" ? null : undefined}
                            etat={cel.etat}
                            raison={cel.raison}
                            type={c.type ?? (cel.etat === "valeur" ? typeDeValeur(cel.valeur) : null) ?? null}
                            options={c.options}
                            horsListe={cel.horsListe}
                            modifiable={p.modifiable && c.modifiable && cel.etat !== "anomalie" && !l.nonModifiable}
                            libelle={`${c.libelle} de « ${l.titre} »`}
                            revision={revision}
                            ecrire={(v, rev) => ecrireCellule(l.chemin, c, v, rev)}
                          />
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {r.lignes.length === 0 && (
            <p className="base__vide">Aucune page ne correspond à ces filtres{r.dossier ? " : « Nouveau » en crée une." : "."}</p>
          )}
          {nouvelle !== null && (
            <form className="base__nouvelle" onSubmit={(e) => { e.preventDefault(); void creer(); }}>
              <input className="base__nouvelle-champ" autoFocus value={nouvelle} disabled={creation} maxLength={200}
                placeholder="Nom de la nouvelle entrée" aria-label="Nom de la nouvelle entrée" enterKeyHint="done"
                onChange={(e) => setNouvelle(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") setNouvelle(null); }} />
              <button type="submit" className="bouton bouton--petit bouton--primaire" disabled={creation}>Créer</button>
              <button type="button" className="bouton bouton--petit" onClick={() => setNouvelle(null)}>Annuler</button>
            </form>
          )}
          <div className="base__pied">
            <span>{r.total} page{r.total > 1 ? "s" : ""}{r.limite !== null && r.total > r.limite ? ` (${r.limite} affichées)` : ""}</span>
            {r.avertissements.length > 0 && (
              <button type="button" className="base__avert-bouton" aria-expanded={voirAvert} onClick={() => setVoirAvert((x) => !x)}>
                <Info size={14} aria-hidden="true" /> {r.avertissements.length} remarque{r.avertissements.length > 1 ? "s" : ""}
              </button>
            )}
          </div>
          {voirAvert && <ul className="base__avert">{r.avertissements.map((a, i) => <li key={i}>{a}</li>)}</ul>}
          {r.nonClassees.length > 0 && (
            <div className="base__non-classees" role="note">
              <p><AlertTriangle size={15} aria-hidden="true" /> {r.nonClassees.length} page{r.nonClassees.length > 1 ? "s" : ""} non classée{r.nonClassees.length > 1 ? "s" : ""} : leur en-tête est ambigu, Carnet ne devine pas.</p>
              <ul>
                {r.nonClassees.map((x) => (
                  <li key={x.chemin}>
                    <a href={urlDe({ vue: "page", chemin: x.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: x.chemin })}>{x.titre}</a> : {x.raison}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ ajout d'un filtre simple

/** Choix du formulaire : un filtre simple, ou une expression écrite à la main (lot 12). */
type ChoixFiltre = OperateurSimple | "expression";

function FormulaireFiltre({ colonnes, ajouter, fermer }: { colonnes: ColonneBase[]; ajouter: (expr: string) => Promise<Reecriture>; fermer: () => void }) {
  const choix = useMemo(() => colonnes.filter((c) => c.nature === "note" && c.cle), [colonnes]);
  const [cle, setCle] = useState(choix[0]?.cle ?? "");
  const col = choix.find((c) => c.cle === cle);
  const type: TypePropriete = col?.type ?? "texte";
  const ops = operateursPour(type);
  const [op, setOp] = useState<ChoixFiltre>(ops[0]);
  const [valeur, setValeur] = useState("");
  const [jours, setJours] = useState("7");
  const [expression, setExpression] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [erreurExpr, setErreurExpr] = useState<ErreurBase | null>(null);
  const [envoi, setEnvoi] = useState(false);
  useEffect(() => { setOp(operateursPour(col?.type ?? "texte")[0]); setValeur(""); setErreur(null); setErreurExpr(null); }, [cle]); // eslint-disable-line react-hooks/exhaustive-deps
  const libre = op === "expression";
  const avecJours = !libre && OPERATEURS_JOURS.includes(op);
  const sansValeur = libre || avecJours || ["vide", "non_vide", "coche", "non_coche", "avant_aujourdhui", "jusqu_aujourdhui", "aujourdhui", "cette_semaine"].includes(op);

  const changerOp = (o: ChoixFiltre) => {
    setOp(o);
    setErreur(null);
    setErreurExpr(null);
    // une expression à écrire à la main part de l'écriture du choix précédent, quand il y en a une
    if (o === "expression" && !expression) {
      try { setExpression(ecrireFiltreSimple({ propriete: cle, operateur: type === "date" ? "au_plus_tard" : "non_vide", valeur: 7 })); } catch { setExpression(""); }
    }
  };

  const valider = async () => {
    let expr: string;
    if (libre) {
      if (!expression.trim()) { setErreur("Écris une expression."); return; }
      expr = expression.trim();
    } else {
      let v: string | number | null = null;
      if (avecJours) {
        const n = Number(jours);
        if (!/^\d{1,4}$/.test(jours.trim()) || n > 3650) { setErreur("Nombre de jours attendu (0 à 3650)."); return; }
        v = n;
      } else if (!sansValeur) {
        if (type === "nombre") {
          const n = Number(valeur.replace(/\s/g, "").replace(",", "."));
          if (!valeur.trim() || !Number.isFinite(n)) { setErreur("Nombre attendu."); return; }
          v = n;
        } else if (type === "date") {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(valeur)) { setErreur("Date attendue."); return; }
          v = valeur;
        } else v = valeur;
      }
      expr = ecrireFiltreSimple({ propriete: cle, operateur: op, valeur: v });
    }
    setEnvoi(true);
    const x = await ajouter(expr);
    setEnvoi(false);
    if (!x.ok) {
      // la position est montrée par le ^ sous l'expression : inutile de la répéter en chiffres
      setErreur(x.erreur && x.erreur.expression !== undefined ? x.message.replace(/ \(position \d+\)$/, "") : x.message);
      setErreurExpr(x.erreur && x.erreur.expression !== undefined ? x.erreur : null);
    }
  };

  if (!choix.length) {
    return <p className="base__note">Aucune propriété à filtrer : ajoute des colonnes (order) dans le YAML.</p>;
  }
  return (
    <form className="base__form-filtre" data-mode={libre ? "expression" : undefined} onSubmit={(e) => { e.preventDefault(); void valider(); }} aria-label="Ajouter un filtre">
      {!libre && (
        <select aria-label="Propriété" value={cle} onChange={(e) => setCle(e.target.value)}>
          {choix.map((c) => <option key={c.id} value={c.cle!}>{c.libelle}</option>)}
        </select>
      )}
      <select aria-label="Condition" value={op} onChange={(e) => changerOp(e.target.value as ChoixFiltre)}>
        {ops.map((o) => <option key={o} value={o}>{LIBELLES_OPERATEURS[o]}</option>)}
        <option value="expression">expression (écrite à la main)…</option>
      </select>
      {avecJours && (
        <label className="base__jours">
          <span>N =</span>
          <input aria-label="Nombre de jours" type="text" inputMode="numeric" pattern="[0-9]*" value={jours} maxLength={4}
            onChange={(e) => { setJours(e.target.value); setErreur(null); }} />
          <span>jour{Number(jours) > 1 ? "s" : ""}</span>
        </label>
      )}
      {libre && (
        <input className="base__expression" aria-label="Expression du filtre" value={expression} spellCheck={false} autoCapitalize="off" autoCorrect="off"
          placeholder={'ex. prochaine_relance <= today() + "7d"'} maxLength={2000}
          onChange={(e) => { setExpression(e.target.value); setErreur(null); setErreurExpr(null); }} />
      )}
      {!sansValeur && (col?.options && (type === "statut" || type === "selection")
        ? (
          <select aria-label="Valeur" value={valeur} onChange={(e) => setValeur(e.target.value)}>
            <option value="" disabled>Choisir…</option>
            {col.options.map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
        )
        : <input aria-label="Valeur" type={type === "date" ? "date" : "text"} inputMode={type === "nombre" ? "decimal" : undefined} value={valeur}
            onChange={(e) => { setValeur(e.target.value); setErreur(null); }} />)}
      <button type="submit" className="bouton bouton--petit bouton--primaire" disabled={envoi || (!sansValeur && valeur === "")}>Ajouter</button>
      <button type="button" className="bouton bouton--petit" onClick={fermer}>Fermer</button>
      {erreur && (
        <div className="base__form-erreur" role="alert">
          {erreur}
          {erreurExpr && erreurExpr.expression !== undefined && (
            <pre className="base__expr">{erreurExpr.expression}{erreurExpr.position !== undefined ? `\n${" ".repeat(Math.min(erreurExpr.position, erreurExpr.expression.length))}^` : ""}</pre>
          )}
        </div>
      )}
    </form>
  );
}
