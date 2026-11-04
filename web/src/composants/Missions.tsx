// Lot 10 « Missions vivantes » : ce qui travaille pour toi, lu dans les fiches `type: mission` (LECTURE SEULE).
// Trois niveaux jamais confondus : DÉCLARÉ par l'agent (état, responsable, dernier signal, prochain pas, blocage),
// OBSERVÉ par Carnet (date du fichier), VÉRIFIÉ (le livrable existe dans l'espace). « Ouvrir le résultat » n'apparaît
// que si le livrable résout ; une fin déclarée sans livrable est une anomalie visible, jamais un succès.
// Mise à jour en direct par le flux SSE existant ; resynchronisation complète à chaque reconnexion (serveur redémarré,
// iPhone revenu au premier plan). Rien ici n'écrit dans un fichier.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowUpRight, CircleCheck, ExternalLink, File, FileCheck2, FileQuestion, FileX2, FolderOpen, Hourglass, Radar, RefreshCw, TriangleAlert,
} from "lucide-react";
import { api, type LienMission, type Mission, type ReponseMissions, type SectionMission } from "../api";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe, type Route } from "../navigation";
import { Entete } from "./Entete";
import { EtatVide } from "./EtatVide";
import { SqueletteListe } from "./Squelettes";
import "../styles/missions.css";

// ---------------------------------------------------------------------------------------------
// Données : chargement, direct, reconnexion
// ---------------------------------------------------------------------------------------------

export type EtatLiaison = "chargement" | "direct" | "perdu" | "erreur";

/** Au-delà, une mission active sans nouvelles est signalée « pas de signal depuis … » (jamais « travaille »). */
const SILENCE_MS = 12 * 3600 * 1000;
const DUREE_REPERE = 2600;

/** Missions de l'espace, tenues à jour par le flux en direct. Toute reconnexion relit tout (rien n'est supposé). */
export function useMissions() {
  const [donnees, setDonnees] = useState<ReponseMissions | null>(null);
  const [liaison, setLiaison] = useState<EtatLiaison>("chargement");
  const [maj, setMaj] = useState<number | null>(null);
  const [changees, setChangees] = useState<ReadonlySet<string>>(() => new Set());
  const etags = useRef<Map<string, string> | null>(null);
  const flux = useRef<"ouvert" | "perdu">("ouvert");
  /** K10-02 : navigateur hors ligne (évènement `offline`) : le flux peut mettre longtemps à se dire coupé. */
  const horsLigne = useRef(typeof navigator !== "undefined" && navigator.onLine === false);
  const occupe = useRef(false);
  const encore = useRef(false);
  const vivant = useRef(true);
  const repere = useRef<number | null>(null);

  const charger = useCallback(async () => {
    if (occupe.current) { encore.current = true; return; }
    occupe.current = true;
    try {
      do {
        encore.current = false;
        try {
          const r = await api.missions();
          if (!vivant.current) return;
          const avant = etags.current;
          const apres = new Map(r.missions.map((m) => [m.chemin, m.etag]));
          if (avant) {
            const bougees = [...apres].filter(([c, e]) => avant.get(c) !== e).map(([c]) => c);
            if (bougees.length) {
              setChangees(new Set(bougees));
              if (repere.current) window.clearTimeout(repere.current);
              repere.current = window.setTimeout(() => setChangees(new Set()), DUREE_REPERE);
            }
          }
          etags.current = apres;
          setDonnees(r);
          setMaj(Date.now());
          setLiaison(flux.current === "perdu" || horsLigne.current ? "perdu" : "direct");
        } catch {
          if (!vivant.current) return;
          setLiaison(etags.current ? "perdu" : "erreur");
        }
      } while (encore.current);
    } finally {
      occupe.current = false;
    }
  }, []);

  useEffect(() => {
    vivant.current = true;
    void charger();
    let m: number | null = null;
    const relancer = (delai: number) => {
      if (m) window.clearTimeout(m);
      m = window.setTimeout(() => void charger(), delai);
    };
    const fin = ecouter((e) => {
      if (e.type === "modif" || e.type === "arbre") relancer(200);
      else if (e.etat === "perdue") {
        flux.current = "perdu";
        setLiaison((l) => (l === "direct" ? "perdu" : l));
      } else {
        // reconnexion : tout est relu depuis les fichiers (les changements faits pendant la coupure compris)
        flux.current = "ouvert";
        relancer(0);
      }
    });
    // K10-02 : coupure du navigateur : le badge passe AUSSITÔT à « Hors ligne » (plus de « Fiches à jour » vert à côté
    // de « Pas de connexion au carnet ») ; au retour, tout est relu (et le badge redevient vert si la relecture réussit).
    const surOffline = () => { horsLigne.current = true; setLiaison((l) => (l === "direct" ? "perdu" : l)); };
    const surOnline = () => { horsLigne.current = false; relancer(0); };
    window.addEventListener("offline", surOffline);
    window.addEventListener("online", surOnline);
    if (horsLigne.current) surOffline();
    // Filet : flux coupé, nouvel essai toutes les 10 s (EventSource peut attendre jusqu'à 30 s avant de revenir).
    const filet = window.setInterval(() => { if (flux.current === "perdu" || horsLigne.current) void charger(); }, 10_000);
    return () => {
      vivant.current = false;
      window.removeEventListener("offline", surOffline);
      window.removeEventListener("online", surOnline);
      fin();
      if (m) window.clearTimeout(m);
      if (repere.current) window.clearTimeout(repere.current);
      window.clearInterval(filet);
    };
  }, [charger]);

  return { donnees, liaison, maj, changees, recharger: charger };
}

/** Horloge qui avance toute seule : « il y a 3 min » reste juste sans rechargement. */
function useMaintenant(pas = 30_000): number {
  const [t, setT] = useState(() => Date.now());
  useEffect(() => {
    const i = window.setInterval(() => setT(Date.now()), pas);
    return () => window.clearInterval(i);
  }, [pas]);
  return t;
}

// ---------------------------------------------------------------------------------------------
// Textes
// ---------------------------------------------------------------------------------------------

const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fmtJourAn = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fmtHeure = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });

/** « 22 h 41 » (typographie française). */
export function heure(ms: number): string {
  return fmtHeure.format(ms).replace(":", " h ");
}

function jour(ms: number, maintenant: number): string {
  return new Date(ms).getFullYear() === new Date(maintenant).getFullYear() ? fmtJour.format(ms) : fmtJourAn.format(ms);
}

/** « à l'instant », « il y a 12 min », « il y a 3 h », « hier », « il y a 4 j », « le 2 oct. ». */
function ilYa(ms: number, maintenant: number): string {
  const s = (maintenant - ms) / 1000;
  if (s < -300) return `le ${jour(ms, maintenant)}`;
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 2 * 86400) return "hier";
  if (s < 7 * 86400) return `il y a ${Math.floor(s / 86400)} j`;
  return `le ${jour(ms, maintenant)}`;
}

/** « 14 h », « hier », « 3 j », « le 2 oct. » : pour « pas de signal depuis … ». */
function depuis(ms: number, maintenant: number): string {
  const s = (maintenant - ms) / 1000;
  if (s < 86400) return `${Math.max(1, Math.floor(s / 3600))} h`;
  if (s < 2 * 86400) return "hier";
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} j`;
  return `le ${jour(ms, maintenant)}`;
}


const ACTIFS = new Set(["a_faire", "en_cours", "bloquee"]);

/** « Noé · dernière nouvelle il y a 12 min » : la date que l'agent a écrite, jamais « travaille actuellement ». */
function texteNouvelle(m: Mission, maintenant: number): { texte: string; silence: boolean } {
  const actif = ACTIFS.has(m.etat.code ?? "");
  const s = m.signal;
  const silence = actif && maintenant - (s.date ?? m.observe) > SILENCE_MS;
  if (s.date !== null) {
    if (silence) return { texte: `pas de nouvelle depuis ${depuis(s.date, maintenant)}`, silence };
    return { texte: s.precision === "jour" ? `dernière nouvelle le ${jour(s.date, maintenant)}` : `dernière nouvelle ${ilYa(s.date, maintenant)}`, silence };
  }
  return { texte: s.brut !== null ? "date de dernière nouvelle illisible" : "aucune date de nouvelle", silence };
}

/** Date observée du fichier, rangée dans « Détails ». */
function texteObserve(m: Mission, maintenant: number): string {
  return `Fiche modifiée ${ilYa(m.observe, maintenant)}`;
}

/** Badge principal : ce que la carte demande à la personne, pas le mot exact de la fiche (gardé dans « Détails »). */
function badge(m: Mission): { texte: string; ton: string } {
  const code = m.etat.code;
  if (code === "terminee_declaree") {
    if (m.resultat) return { texte: "Résultat disponible", ton: "vert" };
    if (m.anomalies.some((a) => a.code === "livrable_non_verifie")) return { texte: "Livrable à vérifier", ton: "ambre" };
    return { texte: "Livrable introuvable", ton: "ambre" };
  }
  switch (code) {
    case "a_arbitrer": return { texte: "Décision attendue", ton: "violet" };
    case "en_cours": return { texte: "En cours", ton: "bleu" };
    case "bloquee": return { texte: "Bloquée", ton: "rouge" };
    case "a_faire": return { texte: "À faire", ton: "gris" };
    case "abandonnee": return { texte: "Abandonnée", ton: "gris" };
    default: return { texte: m.etat.brut === null ? "Sans état" : "État inconnu", ton: "gris" };
  }
}

export const SECTIONS: ReadonlyArray<{ cle: SectionMission; titre: string; court: string; ton: string; replie: boolean }> = [
  { cle: "a_arbitrer", titre: "À traiter", court: "À traiter", ton: "violet", replie: false },
  { cle: "resultats", titre: "Résultats disponibles", court: "Résultats", ton: "vert", replie: false },
  { cle: "en_cours", titre: "En cours", court: "En cours", ton: "bleu", replie: true },
  { cle: "autres", titre: "Autres", court: "Autres", ton: "gris", replie: true },
];

function routeLien(l: LienMission): Route | null {
  if (!l.chemin || !l.resolu) return null;
  if (l.genre === "page") return { vue: "page", chemin: l.chemin };
  if (l.genre === "dossier") return { vue: "page", chemin: l.chemin + ".md" };
  if (l.genre === "fichier") return { vue: "fichier", chemin: l.chemin };
  return null;
}

/** Nom lisible d'un livrable introuvable : son dernier segment (le chemin complet reste dans « Détails »). */
function nomCourt(l: LienMission): string {
  if (l.genre === "invalide") return l.brut;
  return (l.titre ?? l.brut).split("/").filter(Boolean).pop() ?? l.brut;
}

// ---------------------------------------------------------------------------------------------
// « Nouveau depuis ta dernière visite » : date de la visite précédente, gardée dans le navigateur (état
// d'interface, jamais dans les fichiers). Première visite : aucun repère.
// ---------------------------------------------------------------------------------------------

const CLE_VISITE = "carnet:missions-visite";

function useVisitePrecedente(): number | null {
  const [avant] = useState<number | null>(() => {
    try {
      const v = Number(localStorage.getItem(CLE_VISITE));
      return Number.isFinite(v) && v > 0 ? v : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    try { localStorage.setItem(CLE_VISITE, String(Date.now())); } catch { /* navigation privée */ }
  }, []);
  return avant;
}

function estNouvelle(m: Mission, visite: number | null): boolean {
  return visite !== null && (m.signal.date ?? m.observe) > visite && (m.section === "a_arbitrer" || m.section === "resultats");
}

// ---------------------------------------------------------------------------------------------
// Carte : titre → problème ou résultat → prochain pas et acteur → action ; le reste sous « Détails »
// ---------------------------------------------------------------------------------------------

function LigneLivrable({ l, termine }: { l: LienMission; termine: boolean }) {
  const route = routeLien(l);
  if (route) {
    const I = l.genre === "dossier" ? FolderOpen : l.genre === "fichier" ? File : FileCheck2;
    return (
      <li className="livrable" data-genre={l.genre}>
        <a className="livrable__lien" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>
          <I size={16} aria-hidden="true" />
          <span className="livrable__nom">{l.titre ?? l.brut}</span>
        </a>
      </li>
    );
  }
  if (l.genre === "externe" && l.url) {
    return (
      <li className="livrable" data-genre="externe">
        <a className="livrable__lien" href={l.url} target="_blank" rel="noopener noreferrer external">
          <ExternalLink size={16} aria-hidden="true" />
          <span className="livrable__nom">{l.titre ?? l.url}</span>
        </a>
        <span className="livrable__note">externe, non vérifié</span>
      </li>
    );
  }
  const illisible = l.genre === "invalide";
  const I = illisible ? FileQuestion : FileX2;
  return (
    <li className="livrable" data-genre={l.genre} data-alerte={termine || illisible ? "true" : undefined}>
      <span className="livrable__absent">
        <I size={16} aria-hidden="true" />
        <span className="livrable__nom">{l.brut}</span>
      </span>
      <span className="livrable__note">{illisible ? "lien illisible" : termine ? "introuvable" : "pas encore là"}</span>
    </li>
  );
}

export function CarteMission({ m, maintenant, compact = false, change = false, nouvelle = false }: {
  m: Mission; maintenant: number; compact?: boolean; change?: boolean; nouvelle?: boolean;
}) {
  const fiche: Route = { vue: "page", chemin: m.chemin };
  const nouvelleDate = texteNouvelle(m, maintenant);
  const termine = m.etat.code === "terminee_declaree";
  const b = badge(m);
  const qui = m.responsable_declare ?? "L'agent";
  // « Ouvrir le résultat » : fin déclarée ET livrable présent dans l'espace.
  const resultat = termine && m.resultat ? routeLien(m.resultat) : null;
  const introuvable = termine && !m.resultat;
  const decision = m.decision && m.decision.resolu ? routeLien(m.decision) : null;
  const client = m.client && m.client.resolu ? routeLien(m.client) : null;
  const absents = m.livrables.filter((l) => !l.resolu && l.genre !== "externe");
  // problème ou résultat, en une phrase
  let probleme: string | null = null;
  if (introuvable) {
    probleme = absents.length
      ? `Fin annoncée, mais « ${nomCourt(absents[0])} » est introuvable dans ton espace.`
      : m.livrables.length ? "Fin annoncée, mais le livrable est un lien externe que Carnet ne peut pas vérifier."
        : "Fin annoncée, mais la fiche ne nomme aucun livrable.";
  } else if (m.blocage) {
    probleme = `Bloquée : ${m.blocage}`;
  } else if (m.etat.code === "a_arbitrer" && m.decision) {
    probleme = decision ? `Décision : ${m.decision.titre}${m.decision.statut ? ` · ${m.decision.statut}` : ""}` : `Décision introuvable : ${nomCourt(m.decision)}`;
  } else if (m.etat.code === null) {
    probleme = m.etat.brut === null ? "La fiche ne dit pas où en est la mission." : `État « ${m.etat.brut} » inconnu de Carnet.`;
  }
  // autres anomalies (rares) : une ligne chacune, sans répéter le problème principal
  const autres = m.anomalies.filter((a) => !["livrable_absent", "livrable_non_verifie", "livrable_introuvable", "etat_absent", "etat_inconnu", "decision_introuvable"].includes(a.code));
  const prochain = introuvable ? `${qui} doit corriger le lien ou fournir le livrable.` : m.prochain_pas;
  const idTitre = `mission-${encodeURIComponent(m.chemin)}`;
  return (
    <article className="carte-mission" data-section={m.section} data-etat={m.etat.code ?? "inconnu"} data-change={change ? "true" : undefined}
      data-anomalie={introuvable || autres.length ? "true" : undefined} data-chemin={m.chemin} data-etag={m.etag} aria-labelledby={idTitre}>
      <div className="carte-mission__haut">
        <span className="pastille carte-mission__badge" data-ton={b.ton}>{b.texte}</span>
        {nouvelle && <span className="carte-mission__nouveau">Nouveau</span>}
        {m.technique && <span className="pastille pastille--etiquette">fichier d'agent</span>}
      </div>
      <h3 className="carte-mission__titre" id={idTitre}>
        <a href={urlDe(fiche)} onClick={(e) => surLienInterne(e, fiche)}>{m.titre}</a>
      </h3>
      {probleme && <p className="carte-mission__probleme" data-ton={introuvable || m.blocage ? "alerte" : undefined}>{probleme}</p>}
      {resultat && m.resultat && <p className="carte-mission__trouve">Résultat : {m.resultat.titre}</p>}
      {autres.map((a, i) => (
        <p key={i} className="carte-mission__anomalie" data-code={a.code}><TriangleAlert size={14} aria-hidden="true" /> {a.texte}</p>
      ))}
      {prochain && (
        <p className="carte-mission__prochain"><span className="carte-mission__etiquette">Prochain pas</span> <span className="valeur">{prochain}</span></p>
      )}
      <p className="carte-mission__acteur" data-silence={nouvelleDate.silence ? "true" : undefined}>
        {nouvelleDate.silence && <Hourglass size={14} aria-hidden="true" />}
        <span><strong>{qui}</strong> · {nouvelleDate.texte}</span>
      </p>

      {(resultat || introuvable || decision) && (
        <div className="carte-mission__actions">
          {resultat && (
            <a className="bouton bouton--primaire carte-mission__resultat" href={urlDe(resultat)} onClick={(e) => surLienInterne(e, resultat)}>
              Ouvrir le résultat <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          )}
          {!resultat && decision && m.etat.code === "a_arbitrer" && (
            <a className="bouton bouton--primaire carte-mission__decision" href={urlDe(decision)} onClick={(e) => surLienInterne(e, decision)}>
              Ouvrir la décision <ArrowUpRight size={17} aria-hidden="true" />
            </a>
          )}
          {introuvable && (
            <a className="bouton carte-mission__fiche" href={urlDe(fiche)} onClick={(e) => surLienInterne(e, fiche)}>Ouvrir la fiche</a>
          )}
        </div>
      )}

      {!compact && (
        <details className="carte-mission__plus">
          <summary>Détails</summary>
          <dl className="carte-mission__details">
            {m.demande && <div><dt>Demande</dt><dd className="carte-mission__demande">{m.demande}</dd></div>}
            {m.demande_par && <div><dt>Demandé par</dt><dd>{m.demande_par}</dd></div>}
            <div><dt>Responsable</dt><dd className="carte-mission__qui">{m.responsable_declare ? `Responsable déclaré : ${m.responsable_declare}` : "Non indiqué"}</dd></div>
            <div><dt>État écrit</dt><dd>{m.etat.brut ?? "aucun"}</dd></div>
            {introuvable && m.prochain_pas && <div><dt>Prochain pas écrit</dt><dd>{m.prochain_pas}</dd></div>}
            {m.livrables.length > 0 && (
              <div className="carte-mission__livrables">
                <dt>{m.livrables.length > 1 ? "Livrables" : "Livrable"}</dt>
                <dd><ul>{m.livrables.map((l, i) => <LigneLivrable key={i} l={l} termine={termine} />)}</ul></dd>
              </div>
            )}
            {client && m.client && <div><dt>Client</dt><dd><a href={urlDe(client)} onClick={(e) => surLienInterne(e, client)}>{m.client.titre}</a></dd></div>}
            {m.journal.dernier && <div><dt>Journal</dt><dd className="carte-mission__journal">{m.journal.dernier}</dd></div>}
            <div><dt>Fichier</dt><dd className="carte-mission__observe">{texteObserve(m, maintenant)}</dd></div>
          </dl>
        </details>
      )}
    </article>
  );
}

// ---------------------------------------------------------------------------------------------
// Pièces communes : synchronisation des fiches, compteurs
// ---------------------------------------------------------------------------------------------

function Liaison({ etat, maj }: { etat: EtatLiaison; maj: number | null }) {
  if (etat === "chargement" || etat === "erreur") return null;
  return (
    <p className="missions__liaison" data-etat={etat} role="status" aria-live="polite">
      <span className="missions__point" aria-hidden="true" />
      {etat === "direct"
        ? <span>Fiches à jour{maj ? ` · ${heure(maj)}` : ""}</span>
        : <span>Hors ligne · dernière synchronisation {maj ? heure(maj) : "inconnue"}<span className="masque-visuel">, reconnexion en cours</span></span>}
    </p>
  );
}

/** Ouvre (si besoin) puis amène à l'écran la section `cle`. */
function allerSection(cle: SectionMission): void {
  const cible = document.getElementById(`missions-${cle}`);
  if (!cible) return;
  if (cible instanceof HTMLDetailsElement && !cible.open) cible.open = true;
  const doux = !matchMedia("(prefers-reduced-motion: reduce)").matches;
  cible.scrollIntoView({ behavior: doux ? "smooth" : "auto", block: "start" });
  cible.querySelector<HTMLElement>("h2, summary")?.focus({ preventScroll: true });
}

function Compteurs({ d, lien = false }: { d: ReponseMissions; lien?: boolean }) {
  const liste = SECTIONS.filter((s) => s.cle !== "autres" || d.compteurs.autres > 0);
  return (
    <nav className="missions__compteurs" aria-label="Missions par section">
      {liste.map((s) => {
        const n = d.compteurs[s.cle];
        return (
          <a key={s.cle} className="compteur-mission" data-ton={s.ton} data-vide={n === 0 ? "true" : undefined}
            href={lien ? urlDe({ vue: "missions" }) : `#missions-${s.cle}`}
            onClick={(e) => { if (lien) surLienInterne(e, { vue: "missions" }); else { e.preventDefault(); allerSection(s.cle); } }}
            aria-label={`${s.titre} : ${n}`}>
            <strong>{n}</strong>
            <span>{s.court}</span>
          </a>
        );
      })}
    </nav>
  );
}

function RienATraiter({ resume = false }: { resume?: boolean }) {
  // Intégration V3 : dans l'écran Aujourd'hui, les décisions à prendre sont juste au-dessus ; le résumé parle donc des
  // missions seulement (« Rien ne demande ton intervention » y contredisait « Décisions à prendre »).
  return (
    <p className="missions__rien"><CircleCheck size={18} aria-hidden="true" /> {resume ? "Aucune mission ne demande ton intervention." : "Rien ne demande ton intervention."}</p>
  );
}

const CLE_REPLIS = "carnet:missions-ouvertes";

function lireOuvertes(): Set<string> {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CLE_REPLIS) ?? "[]");
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
  } catch {
    return new Set();
  }
}

// ---------------------------------------------------------------------------------------------
// Écran « Missions »
// ---------------------------------------------------------------------------------------------

export function Missions() {
  const { donnees: d, liaison, maj, changees, recharger } = useMissions();
  const maintenant = useMaintenant();
  const visite = useVisitePrecedente();
  const [ouvertes, setOuvertes] = useState<Set<string>>(lireOuvertes);
  const basculer = (cle: string, ouvert: boolean) => {
    setOuvertes((o) => {
      if (o.has(cle) === ouvert) return o;
      const n = new Set(o);
      if (ouvert) n.add(cle); else n.delete(cle);
      try { localStorage.setItem(CLE_REPLIS, JSON.stringify([...n])); } catch { /* navigation privée */ }
      return n;
    });
  };
  return (
    <>
      <Entete fil={[{ titre: "Missions" }]} />
      <main className="feuille missions">
        <div className="missions__tete">
          <h1 className="missions__titre">Missions</h1>
          <Liaison etat={liaison} maj={maj} />
        </div>
        <p className="missions__intro">Suis tes missions et retrouve leurs résultats.</p>
        <p className="missions__aide">
          Statuts renseignés par les agents. Carnet vérifie la présence des livrables, pas leur qualité ni l'exécution du travail.
        </p>

        {liaison === "chargement" && !d && <div style={{ marginTop: 16 }}><SqueletteListe lignes={3} hauteur={150} /></div>}

        {liaison === "erreur" && !d && (
          <EtatVide icone={<RefreshCw size={22} />} titre="Missions indisponibles"
            texte="Carnet n'a pas pu lire les fiches. Vérifie ta connexion, puis réessaie."
            actions={<button type="button" className="bouton" onClick={() => void recharger()}>Réessayer</button>} />
        )}

        {d && d.compteurs.total === 0 && (
          <EtatVide icone={<Radar size={22} />} titre="Aucune mission pour l'instant"
            texte={<>Une mission, c'est une page dont l'en-tête dit <code>type: mission</code>. Tes agents la créent et la tiennent à jour ; elle apparaît ici toute seule.</>} />
        )}

        {d && d.compteurs.total > 0 && (
          <>
            <Compteurs d={d} />
            {d.tronque && <p className="missions__note">Trop de fiches : seules les {d.missions.length} plus récentes sont montrées.</p>}
            {d.compteurs.a_arbitrer === 0 && <RienATraiter />}
            {SECTIONS.map((s) => {
              const liste = d.missions.filter((m) => m.section === s.cle);
              if (!liste.length) return null;
              const cartes = liste.map((m) => (
                <CarteMission key={m.chemin} m={m} maintenant={maintenant} change={changees.has(m.chemin)} nouvelle={estNouvelle(m, visite)} />
              ));
              if (!s.replie) {
                return (
                  <section key={s.cle} id={`missions-${s.cle}`} className="missions__section" aria-labelledby={`titre-missions-${s.cle}`}>
                    <h2 className="missions__section-titre" id={`titre-missions-${s.cle}`} tabIndex={-1}>
                      <span>{s.titre}</span><span className="missions__nombre">{liste.length}</span>
                    </h2>
                    {cartes}
                  </section>
                );
              }
              return (
                <details key={s.cle} id={`missions-${s.cle}`} className="missions__section missions__repli" open={ouvertes.has(s.cle)}
                  onToggle={(e) => basculer(s.cle, (e.currentTarget as HTMLDetailsElement).open)}>
                  <summary className="missions__section-titre">
                    <span>{s.titre}</span><span className="missions__nombre">{liste.length}</span>
                  </summary>
                  {cartes}
                </details>
              );
            })}
          </>
        )}
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Résumé pour l'écran Aujourd'hui (lot 1) : compteurs + 3 cartes de ce qui attend la personne, puis les résultats.
// Rien du tout s'il n'y a aucune mission (ou pas d'API).
// ---------------------------------------------------------------------------------------------

export function ResumeMissions({ surNombre }: { surNombre?: (aArbitrer: number) => void } = {}) {
  const { donnees: d, liaison, maj, changees } = useMissions();
  const maintenant = useMaintenant();
  // K10-05 : la bande de compteurs d'Aujourd'hui annonce les missions qui attendent la personne
  const aArbitrer = d ? d.compteurs.a_arbitrer : 0;
  useEffect(() => { surNombre?.(aArbitrer); }, [aArbitrer, surNombre]);
  if (!d || d.compteurs.total === 0) return null;
  const cartes = d.missions.filter((m) => m.section === "a_arbitrer" || m.section === "resultats").slice(0, 3);
  return (
    <section className="section-accueil resume-missions" id="section-missions" aria-labelledby="titre-resume-missions">
      <h2 className="section-accueil__titre" id="titre-resume-missions">
        <span>Missions</span>
        <a className="resume-missions__tout" href={urlDe({ vue: "missions" })} onClick={(e) => surLienInterne(e, { vue: "missions" })}>Tout voir</a>
      </h2>
      <Compteurs d={d} lien />
      {liaison === "perdu" && <Liaison etat={liaison} maj={maj} />}
      {d.compteurs.a_arbitrer === 0 && <RienATraiter resume />}
      {cartes.map((m) => <CarteMission key={m.chemin} m={m} maintenant={maintenant} compact change={changees.has(m.chemin)} />)}
      {d.compteurs.total > cartes.length && (
        <a className="plus-de resume-missions__plus" href={urlDe({ vue: "missions" })} onClick={(e) => surLienInterne(e, { vue: "missions" })}>
          Voir les {d.compteurs.total} missions
        </a>
      )}
    </section>
  );
}
