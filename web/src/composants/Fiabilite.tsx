// Carnet V3 · lot 5 « Fiabilité » : l'intégrité d'écriture, visible.
// - BandeauBrouillon : saisie NON ENREGISTRÉE (gardée dans ce navigateur, fichier inchangé), Réessayer / Copier.
// - BandeauConflit : la page a changé ailleurs pendant la saisie ; rien n'est écrasé ni fusionné automatiquement :
//   comparaison, puis choix humain explicite (copie de conflit, leur version, la mienne).
// - EcrituresEnAttente (/attente) : brouillons de ce navigateur + écritures « indéterminées » du serveur.
// - RetourVue : « Revenir à la version marquée vue » depuis Nouveautés (différence, portée, confirmation).
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { CloudOff, Copy, FilePlus2, FileWarning, GitCompare, History, Lock, RotateCcw, ShieldAlert, Trash2, Undo2 } from "lucide-react";
import { apiFiabilite, ErreurApi, nouvelleRequete, type ApercuRetour, type Indeterminee } from "../api";
import * as brouillons from "../brouillons";
import type { Brouillon } from "../brouillons";
import { copierTexte } from "../actions-pages";
import { useApp } from "../contexte-app";
import { naviguer, surLienInterne, urlDe, type Route } from "../navigation";
import { ilYA } from "../outils";
import { Differences, quand } from "./BandeauxAgents";
import { Entete } from "./Entete";
import "../styles/fiabilite.css";

export type NonEnregistre = { genre: "reseau" | "erreur" | "restaure"; message?: string; t?: number };

export function BandeauBrouillon({ etat, surReessayer, surCopier }: { etat: NonEnregistre; surReessayer: () => void; surCopier: () => void }) {
  const detail = etat.genre === "restaure"
    ? `Saisie retrouvée (${etat.t ? ilYA(etat.t) : "plus tôt"}), pas encore confirmée par Carnet : nouvel essai en cours.`
    : etat.genre === "reseau" ? "Carnet ne répond pas : nouvel essai automatique."
    : `Carnet a refusé l'enregistrement${etat.message ? ` : ${etat.message}` : "."}`;
  return (
    <div className="bandeau bandeau-brouillon" role="status" data-etat={etat.genre}>
      <CloudOff size={18} aria-hidden="true" className="bandeau-brouillon__icone" />
      <p>
        <strong>Non enregistré.</strong> Ta saisie est gardée dans ce navigateur ; le fichier n'a pas changé. {detail}
      </p>
      <button type="button" className="primaire" onClick={surReessayer}><RotateCcw size={16} aria-hidden="true" /> Réessayer</button>
      <button type="button" onClick={surCopier}><Copy size={16} aria-hidden="true" /> Copier mon texte</button>
    </div>
  );
}

// ---------- Saisie REFUSÉE (page verrouillée : 423 ou verrou posé ailleurs depuis la saisie) ----------
// K11-01 : un refus ne supprime JAMAIS la saisie. Elle reste gardée (état « refuse », jamais renvoyée),
// dans la page et dans « Écritures en attente », jusqu'à un choix explicite : Créer une copie (nouvelle page à nom
// unique, par la porte d'écriture) ou Abandonner (confirmé). « Copier mon texte » ne la retire pas.
export interface SaisieRefusee { chemin: string; texte: string; contenu: string; cle: string }
type App = ReturnType<typeof useApp>;

export function copierRefus(app: App, r: SaisieRefusee): void {
  app.notifier(copierTexte(r.texte)
    ? "Texte copié. Ta saisie reste gardée jusqu'à « Créer une copie » ou « Abandonner »."
    : "Copie refusée par le navigateur : ta saisie reste gardée.");
}

export async function creerCopieRefus(app: App, r: SaisieRefusee, requete: string): Promise<boolean> {
  try {
    const c = await apiFiabilite.copieConflit(r.chemin, r.contenu, requete);
    await brouillons.retirerCle(r.cle);
    const route = { vue: "page" as const, chemin: c.chemin };
    app.notifier(`Copie créée : « ${c.chemin.replace(/\.md$/, "").split("/").pop()} »`, { libelle: "Ouvrir", faire: () => naviguer(route) }, 12000);
    return true;
  } catch (e) {
    app.notifier(`Copie non créée : ${(e as Error).message} Ta saisie reste gardée.`);
    return false;
  }
}

export async function abandonnerRefus(app: App, r: SaisieRefusee): Promise<boolean> {
  const ok = await app.confirmer({
    titre: "Abandonner ta saisie ?", danger: true, bouton: "Abandonner",
    texte: "Le texte refusé sera effacé de ce navigateur. La page ne change pas. Pense à le copier si tu en as besoin.",
  });
  if (!ok) return false;
  await brouillons.retirerCle(r.cle);
  app.notifier("Saisie abandonnée");
  return true;
}

export function BandeauRefus({ surCopier, surCreerCopie, surAbandonner }: { surCopier: () => void; surCreerCopie: () => Promise<unknown>; surAbandonner: () => void }) {
  const [occupe, setOccupe] = useState(false);
  return (
    <div className="bandeau bandeau-brouillon bandeau-refus" role="alert" data-etat="refuse">
      <Lock size={18} aria-hidden="true" className="bandeau-brouillon__icone" />
      <p>
        <strong>Saisie refusée{"\u00a0"}: la page est verrouillée.</strong> Ton texte n'a pas été enregistré dans la page{"\u00a0"}; il
        reste gardé dans ce navigateur (et dans «{"\u00a0"}Écritures en attente{"\u00a0"}») jusqu'à ce que tu en crées une copie ou
        l'abandonnes.
      </p>
      <button type="button" className="primaire" disabled={occupe}
        onClick={async () => { setOccupe(true); try { await surCreerCopie(); } finally { setOccupe(false); } }}>
        <FilePlus2 size={16} aria-hidden="true" /> Créer une copie
      </button>
      <button type="button" onClick={surCopier}><Copy size={16} aria-hidden="true" /> Copier mon texte</button>
      <button type="button" onClick={surAbandonner}><Trash2 size={16} aria-hidden="true" /> Abandonner</button>
    </div>
  );
}

export interface PropsConflit {
  externe: boolean;
  /** Version du fichier (serveur), intacte. */
  leur: string | undefined;
  /** Ce que tu voulais enregistrer (fichier complet). */
  mien: () => string;
  surCopieConflit: () => Promise<void>;
  surPrendreLeur: () => void;
  surGarderMienne: () => void;
  surCopier: () => void;
  /** Finale V3 : leur version porte `verrou: true` : l'écraser serait refusé (423), « Garder la mienne » n'est pas proposé. */
  leurVerrouillee?: boolean;
}

export function BandeauConflit(p: PropsConflit) {
  const [comparer, setComparer] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const mien = comparer ? p.mien() : "";
  return (
    <div className="bandeau bandeau-conflit" role="alert">
      <p>
        <strong>Conflit.</strong> {p.externe ? "Cette page vient d'être modifiée ailleurs (un agent ?) pendant que tu écrivais." : "Cette page a changé sur le disque depuis ton ouverture."}{" "}
        Rien n'a été écrasé ni fusionné : le fichier garde sa version, ton texte est gardé dans ce navigateur. À toi de choisir.
        {p.leurVerrouillee && <> <strong className="bandeau-conflit__verrou">Leur version est verrouillée</strong>{"\u00a0"}: elle ne peut pas être remplacée{"\u00a0"}; garde les deux (copie modifiable) ou copie ton texte.</>}
      </p>
      <div className="bandeau-conflit__choix">
        <button type="button" aria-expanded={comparer} onClick={() => setComparer((x) => !x)}>
          <GitCompare size={16} aria-hidden="true" /> {comparer ? "Masquer la comparaison" : "Comparer"}
        </button>
        <button type="button" className="primaire" disabled={occupe} onClick={async () => { setOccupe(true); try { await p.surCopieConflit(); } finally { setOccupe(false); } }}>
          Garder les deux (copie de conflit)
        </button>
        <button type="button" onClick={p.surPrendreLeur}>Prendre leur version</button>
        {!p.leurVerrouillee && <button type="button" onClick={p.surGarderMienne}>Garder la mienne</button>}
        <button type="button" onClick={p.surCopier}><Copy size={16} aria-hidden="true" /> Copier mon texte</button>
      </div>
      {comparer && (
        <div className="bandeau-conflit__comparaison">
          <p className="bandeau-conflit__legende">
            <span className="comparaison__moins">− seulement dans leur version (le fichier)</span>{" "}
            <span className="comparaison__plus">+ seulement dans la tienne</span>
          </p>
          {p.leur === undefined ? <p>Leur version n'a pas pu être lue : recharge la page pour comparer.</p> : (
            <Suspense fallback={<div className="squelette" style={{ height: 80 }} />}>
              <Differences avant={p.leur} apres={mien} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

const LIBELLES_ACTION: Record<string, string> = {
  page: "enregistrement", tache: "tâche", meta: "propriété", propriete: "propriété", decision: "décision", capture: "capture",
  "retour-vue": "retour à la version vue", restauration: "restauration", conflit: "copie de conflit", renommer: "renommage",
  deplacer: "déplacement", supprimer: "suppression",
};

/** Écran « Écritures en attente » : rien n'est perdu en silence. */
export function EcrituresEnAttente() {
  const app = useApp();
  const [locaux, setLocaux] = useState<Brouillon[] | null>(null);
  const [serveur, setServeur] = useState<Indeterminee[] | null>(null);
  const [erreurServeur, setErreurServeur] = useState<string | null>(null);
  const charger = useCallback(() => {
    void brouillons.lister().then(setLocaux).catch(() => setLocaux([]));
    apiFiabilite.indeterminees().then((r) => { setServeur(r.elements); setErreurServeur(null); })
      .catch((e) => { setServeur([]); setErreurServeur((e as Error).message); });
  }, []);
  useEffect(() => {
    charger();
    window.addEventListener("carnet:brouillons", charger);
    return () => window.removeEventListener("carnet:brouillons", charger);
  }, [charger]);
  const espace = app.config?.espace ?? "";
  const ici = (locaux ?? []).filter((b) => b.espace === espace);
  const ailleurs = (locaux ?? []).filter((b) => b.espace !== espace);

  const abandonner = async (b: Brouillon) => {
    const ok = await app.confirmer({
      titre: "Abandonner cette saisie ?", danger: true, bouton: "Abandonner",
      texte: `La saisie non enregistrée de « ${b.titre} » sera effacée de ce navigateur. Le fichier de la page ne change pas.`,
    });
    if (!ok) return;
    await brouillons.retirerCle(b.cle);
    app.notifier("Saisie abandonnée");
  };
  const creerCopie = async (b: Brouillon) => {
    await creerCopieRefus(app, { chemin: b.chemin, texte: b.texte, contenu: b.contenu, cle: b.cle }, nouvelleRequete());
  };

  const ligneBrouillon = (b: Brouillon, ouvrable: boolean) => {
    const route = { vue: "page" as const, chemin: b.chemin };
    return (
      <li key={b.cle} className="attente" data-etat={b.etat}>
        <div className="attente__texte">
          {ouvrable
            ? <a className="attente__titre" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>{b.titre}</a>
            : <span className="attente__titre">{b.titre}</span>}
          <span className="attente__meta">
            {b.chemin.replace(/\.md$/, "")} · {ilYA(b.t)} · {b.etat === "refuse" ? "refusée : page verrouillée (jamais renvoyée)" : b.etat === "conflit" ? "en conflit avec le fichier" : b.etat === "echec" ? "envoi échoué" : "pas encore confirmé"}
            {b.erreur ? ` · ${b.erreur}` : ""}{!ouvrable ? ` · espace « ${b.espace} »` : ""}
          </span>
        </div>
        <div className="attente__actions">
          {ouvrable && b.etat !== "refuse" && <button type="button" className="bouton bouton--petit" onClick={() => naviguer(route)}>Ouvrir et réessayer</button>}
          {ouvrable && b.etat === "refuse" && (
            <button type="button" className="bouton bouton--petit" onClick={() => void creerCopie(b)}><FilePlus2 size={15} aria-hidden="true" /> Créer une copie</button>
          )}
          <button type="button" className="bouton bouton--petit" onClick={() => app.notifier(copierTexte(b.texte) ? "Texte copié" : "Copie refusée par le navigateur")}>
            <Copy size={15} aria-hidden="true" /> Copier
          </button>
          <button type="button" className="bouton bouton--petit bouton--danger" onClick={() => void abandonner(b)}>
            <Trash2 size={15} aria-hidden="true" /> Abandonner
          </button>
        </div>
      </li>
    );
  };

  const traiter = async (x: Indeterminee) => {
    try {
      await apiFiabilite.traiterIndeterminee(x.id);
      app.notifier("Marquée comme vérifiée");
      charger();
    } catch (e) {
      app.notifier(`Impossible : ${(e as Error).message}`);
    }
  };

  return (
    <>
      <Entete fil={[{ titre: "Écritures en attente" }]} />
      <main className="feuille vue vue-attente">
        <header className="vue-tete">
          <h1 className="vue-tete__titre">Écritures en attente</h1>
          <p className="vue-tete__texte">
            Ce qui n'a pas pu être confirmé. Rien ici n'est écrit dans tes pages sans ton geste.
          </p>
        </header>

        <section aria-labelledby="attente-locaux">
          <h2 id="attente-locaux" className="vue-attente__titre"><CloudOff size={18} aria-hidden="true" /> Dans ce navigateur</h2>
          <p className="vue-attente__aide">Saisies gardées ici parce que Carnet ne les a pas encore enregistrées (réseau coupé, serveur arrêté, conflit, page verrouillée).</p>
          {!locaux && <div className="squelette" style={{ height: 64 }} />}
          {locaux && ici.length === 0 && ailleurs.length === 0 && <p className="vue-attente__vide">Aucune saisie en attente.</p>}
          {ici.length > 0 && <ul className="liste-attente">{ici.map((b) => ligneBrouillon(b, true))}</ul>}
          {ailleurs.length > 0 && (
            <>
              <p className="vue-attente__aide">D'un autre espace :</p>
              <ul className="liste-attente">{ailleurs.map((b) => ligneBrouillon(b, false))}</ul>
            </>
          )}
        </section>

        <section aria-labelledby="attente-serveur">
          <h2 id="attente-serveur" className="vue-attente__titre"><FileWarning size={18} aria-hidden="true" /> Sur le serveur : écritures indéterminées</h2>
          <p className="vue-attente__aide">
            Écritures interrompues (arrêt du serveur) dont Carnet ne sait pas dire, à la reprise, si elles ont abouti : le
            fichier ne correspond ni à l'ancienne ni à la nouvelle version (il a été modifié ailleurs entre-temps). Vérifie
            la page et son historique.
          </p>
          {erreurServeur && <p className="etat-page">Liste indisponible : {erreurServeur}</p>}
          {!serveur && <div className="squelette" style={{ height: 64 }} />}
          {serveur && serveur.length === 0 && !erreurServeur && <p className="vue-attente__vide">Aucune écriture indéterminée.</p>}
          {serveur && serveur.length > 0 && (
            <ul className="liste-attente">
              {serveur.map((x) => {
                const cible = x.vers ?? x.chemin;
                const route = { vue: "page" as const, chemin: cible };
                const histo = { vue: "historique" as const, chemin: cible };
                return (
                  <li key={x.id} className="attente" data-etat="indeterminee">
                    <div className="attente__texte">
                      {x.existe
                        ? <a className="attente__titre" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>{cible.replace(/\.md$/, "")}</a>
                        : <span className="attente__titre">{cible.replace(/\.md$/, "")}</span>}
                      <span className="attente__meta">{LIBELLES_ACTION[x.action] ?? x.action} · {quand(x.t)} · {x.existe ? "fichier présent, modifié depuis" : "fichier absent"}</span>
                    </div>
                    <div className="attente__actions">
                      {x.existe && <a className="bouton bouton--petit" href={urlDe(histo)} onClick={(e) => surLienInterne(e, histo)}><History size={15} aria-hidden="true" /> Historique</a>}
                      <button type="button" className="bouton bouton--petit" onClick={() => void traiter(x)}>Vérifiée</button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------

/**
 * « Revenir à la version marquée vue » (Nouveautés) : toute la page revient à la version que tu as marquée vue.
 * Différence et portée affichées ; confirmation = une nouvelle révision attribuée (la version annulée reste dans
 * l'Historique). Révision changée entre l'aperçu et la confirmation : rien n'est écrit. Modifications faites dans
 * Carnet depuis : pas de retour en un clic, choix explicite.
 */
const mots = (n: number) => `${n} mot${n > 1 ? "s" : ""}`;

export function RetourVue({ chemin, surFini, surFermer }: { chemin: string; surFini: () => void; surFermer: () => void }) {
  const app = useApp();
  const [a, setA] = useState<ApercuRetour | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [humainesOk, setHumainesOk] = useState(false);
  const [occupe, setOccupe] = useState(false);
  // un identifiant par aperçu : un double appui ou une réponse perdue puis renvoyée = un seul retour
  const requete = useRef(nouvelleRequete());
  const charger = useCallback(() => {
    setA(null);
    setErreur(null);
    setHumainesOk(false);
    requete.current = nouvelleRequete();
    apiFiabilite.apercuRetour(chemin).then(setA).catch((e) => setErreur((e as Error).message));
  }, [chemin]);
  useEffect(() => { charger(); }, [charger]);

  const confirmer = async () => {
    if (!a) return;
    setOccupe(true);
    try {
      const r = await apiFiabilite.retour({ chemin: a.chemin, etag: a.actuel.etag, vu: a.vu.etag, ...(a.humaines.length ? { humaines: humainesOk } : {}) }, requete.current);
      app.notifier("Page revenue à la version marquée vue. La version annulée est gardée dans l'historique.", {
        libelle: "Historique", faire: () => naviguer({ vue: "historique", chemin: r.chemin }),
      }, 10000);
      window.dispatchEvent(new Event("carnet:vu"));
      surFini();
    } catch (e) {
      if (e instanceof ErreurApi && (e.statut === 412 || (e.statut === 409 && !("humaines" in e.corps)))) {
        setErreur("La page a changé depuis cet aperçu : rien n'a été écrit. Voici la nouvelle différence.");
        const msg = (e as Error).message;
        apiFiabilite.apercuRetour(chemin).then((x) => { setA(x); setHumainesOk(false); requete.current = nouvelleRequete(); }).catch(() => setErreur(msg));
      } else setErreur((e as Error).message);
    } finally {
      setOccupe(false);
    }
  };

  const bloque = !a || occupe || (a.humaines.length > 0 && !humainesOk);
  return (
    <div className="retour-vue" role="region" aria-label="Revenir à la version marquée vue">
      {erreur && <p className="retour-vue__erreur" role="alert">{erreur}</p>}
      {!a && !erreur && <div className="squelette" style={{ height: 120 }} />}
      {a && (
        <>
          <p className="retour-vue__portee">
            <strong>Portée : toute la page.</strong> Elle revient exactement à la version que tu as marquée vue {quand(a.vu.t)}.
            Ce n'est pas un retrait ciblé : tout ce qui a changé depuis est annulé, quel que soit son auteur
            {a.bilan.ajouts > 0 && <> (<span className="comparaison__moins">{mots(a.bilan.ajouts)} ajouté{a.bilan.ajouts > 1 ? "s" : ""} depuis, retiré{a.bilan.ajouts > 1 ? "s" : ""}</span>
              {a.bilan.retraits > 0 ? " ; " : ")"}</>}
            {a.bilan.retraits > 0 && <>{a.bilan.ajouts > 0 ? "" : " ("}<span className="comparaison__plus">{mots(a.bilan.retraits)} retiré{a.bilan.retraits > 1 ? "s" : ""} depuis, remis</span>)</>}.
            La version actuelle reste dans l'historique.
            {a.archive && <> La page reste archivée.</>}
          </p>
          <ul className="retour-vue__ecritures">
            {a.externe && <li>Version actuelle écrite hors de Carnet (auteur non vérifié).</li>}
            {a.ecritures.map((x, i) => (
              <li key={i}>{LIBELLES_ACTION[x.action] ?? x.action} par {x.principal}{x.auteur_declare ? ` (déclaré : ${x.auteur_declare})` : ""}, {quand(x.t)}</li>
            ))}
          </ul>
          {a.decision.estDecision && a.decision.attestationNeutralisee && (
            <p className="retour-vue__alerte"><ShieldAlert size={16} aria-hidden="true" /> Demande de décision : l'ancienne décision attestée ne redevient pas valable. Il faudra décider à nouveau.</p>
          )}
          {a.humaines.length > 0 && (
            <label className="retour-vue__humaines">
              <input type="checkbox" checked={humainesOk} onChange={(e) => setHumainesOk(e.target.checked)} />
              <span>
                Des modifications ont été faites dans Carnet depuis ({a.humaines.map((h) => `${h.principal}, ${quand(h.t)}`).join(" ; ")}) :
                peut-être les tiennes. Je les retire aussi.
              </span>
            </label>
          )}
          <p className="retour-vue__legende">
            <span className="comparaison__moins">− retiré par le retour</span> <span className="comparaison__plus">+ remis par le retour</span>
          </p>
          <Suspense fallback={<div className="squelette" style={{ height: 80 }} />}>
            <Differences avant={a.actuel.contenu} apres={a.vu.contenu} />
          </Suspense>
          <div className="retour-vue__actions">
            <button type="button" className="bouton" onClick={surFermer}>Annuler</button>
            <button type="button" className="bouton bouton--primaire" disabled={bloque} onClick={() => void confirmer()}>
              <Undo2 size={16} aria-hidden="true" /> Revenir à la version marquée vue
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------------------------

let avisFait = false;

/**
 * Branché par UNE ligne dans App.tsx : l'écran « Écritures en attente » (/attente) et, une fois par ouverture de
 * l'appli, un avis s'il reste des saisies non enregistrées dans ce navigateur ou des écritures indéterminées.
 */
export function VuesFiabilite({ route }: { route: Route }) {
  const app = useApp();
  const espace = app.config?.espace ?? "";
  useEffect(() => {
    if (avisFait || !espace) return;
    avisFait = true;
    void (async () => {
      const locaux = (await brouillons.lister().catch(() => [] as Brouillon[])).filter((b) => b.espace === espace);
      const serveur = await apiFiabilite.indeterminees().then((r) => r.elements.length).catch(() => 0);
      if (!locaux.length && !serveur) return;
      const parties = [
        locaux.length ? `${locaux.length} saisie${locaux.length > 1 ? "s" : ""} non enregistrée${locaux.length > 1 ? "s" : ""} dans ce navigateur` : "",
        serveur ? `${serveur} écriture${serveur > 1 ? "s" : ""} à vérifier` : "",
      ].filter(Boolean);
      app.notifier(parties.join(", "), { libelle: "Voir", faire: () => naviguer({ vue: "attente" }) }, 12000);
    })();
  }, [espace, app]);
  return route.vue === "attente" ? <EcrituresEnAttente /> : null;
}

/** Lien « Écritures en attente » du pied de la barre latérale : visible seulement s'il y a quelque chose à reprendre. */
export function LienAttente({ actif, fermer }: { actif: boolean; fermer?: () => void }) {
  const app = useApp();
  const espace = app.config?.espace ?? "";
  const [n, setN] = useState(0);
  useEffect(() => {
    if (!espace) return;
    let vivant = true;
    const compter = async () => {
      const locaux = (await brouillons.lister().catch(() => [] as Brouillon[])).filter((b) => b.espace === espace).length;
      const serveur = await apiFiabilite.indeterminees().then((r) => r.elements.length).catch(() => 0);
      if (vivant) setN(locaux + serveur);
    };
    void compter();
    window.addEventListener("carnet:brouillons", compter);
    const m = window.setInterval(compter, 60_000);
    return () => { vivant = false; window.removeEventListener("carnet:brouillons", compter); window.clearInterval(m); };
  }, [espace, actif]);
  if (!n && !actif) return null;
  return (
    <a className="lien-nav lien-nav--attente" href={urlDe({ vue: "attente" })} aria-current={actif ? "page" : undefined}
      onClick={(e) => surLienInterne(e, { vue: "attente" }, fermer)}>
      <CloudOff size={18} />
      <span>Écritures en attente</span>
      {n > 0 && <span className="compteur" aria-label={`${n} élément${n > 1 ? "s" : ""}`}>{n}</span>}
    </a>
  );
}
