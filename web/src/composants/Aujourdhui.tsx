// Lot 1 : écran « Aujourd'hui » (l'accueil de l'appli, à ne pas confondre avec la page Accueil.md).
// Ordre pensé pour l'iPhone : décisions à prendre, tâches en retard, du jour, des 7 prochains jours, nouveautés, à relire
// (avec son critère), tâches sans date et plus tard (repliées), pages récentes. Les fichiers ne sont jamais réécrits par
// l'affichage ; cocher, changer l'échéance ou la priorité ne modifie que la ligne de la tâche (côté serveur).
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { AlertTriangle, BellRing, CalendarClock, ChevronDown, ChevronRight, CircleCheck, Flag, Inbox, MoreHorizontal, Plus, Repeat, Search, Sparkles, Gavel, NotebookPen, Table2 } from "lucide-react";
import { ResumeMissions } from "./Missions"; // lot 10
import { retenirVueBase } from "../bases/vueRetenue"; // lot 12
import { api, ErreurApi, nouvelleRequete, type DonneesAujourdhui, type Decision, type Nouveaute, type TacheJour, type ChangementsTache } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { IconePage, Vague } from "./Icone";
import { EtatVide } from "./EtatVide";
import { SqueletteAccueil } from "./Squelettes";
import { dateLongue, ilYA, salut } from "../outils";
import {
  resumerAnomalie, dateEnToutesLettres, demanderDate, demanderPriorite, libelleDate, libellePriorite, libelleRecurrence, libelleStatut, tonEcheance, tonPriorite,
} from "../taches-ui";

const CASE = (
  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="4.5" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
);
const CASE_COCHEE = (
  <svg width="22" height="22" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="5" fill="currentColor" /><path d="M6 10.2l2.6 2.6L14.2 7" fill="none" stroke="var(--sur-accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
);

function avecMentions(texte: string) {
  const morceaux = texte.split(/(@[\p{L}\d_-]+)/u);
  return morceaux.map((m, i) => (m.startsWith("@") ? <span key={i} className="mention">{m}</span> : <span key={i}>{m}</span>));
}

/** Texte lisible d'une tâche : gras, code et liens réduits à leur texte (affichage seulement). */
export function nettoyerLibelle(l: string): string {
  return l.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, c, a) => a ?? String(c).split("/").pop())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

const cle = (t: TacheJour) => `${t.chemin}:${t.ligne}`;

/** Pastilles d'une tâche : échéance (cliquable), priorité (cliquable), récurrence (affichée, non exécutée), anomalies. */
export function PastillesTache({ t, jour, surDate, surPriorite }: {
  t: Pick<TacheJour, "echeance" | "prevue" | "priorite" | "recurrence" | "anomalies" | "coche">;
  jour: string;
  surDate?: () => void;
  surPriorite?: () => void;
}) {
  const statut = libelleStatut(t.coche);
  return (
    <span className="pastilles-tache">
      {statut && <span className="pastille-tache" data-ton={t.coche === "/" ? "bleu" : "gris"}>{statut}</span>}
      {t.echeance && (
        <button type="button" className="pastille-tache" data-ton={tonEcheance(t.echeance, jour)} onClick={surDate} disabled={!surDate}
          aria-label={`Échéance : ${dateEnToutesLettres(t.echeance)}${surDate ? ", changer" : ""}`} title={dateEnToutesLettres(t.echeance)}>
          <CalendarClock size={14} aria-hidden="true" />{libelleDate(t.echeance, jour)}
        </button>
      )}
      {!t.echeance && t.prevue && (
        <span className="pastille-tache" data-ton="gris" title={`Prévue le ${dateEnToutesLettres(t.prevue)} (⏳)`}>prévue {libelleDate(t.prevue, jour)}</span>
      )}
      {t.priorite && (
        <button type="button" className="pastille-tache" data-ton={tonPriorite(t.priorite)} onClick={surPriorite} disabled={!surPriorite}
          aria-label={`Priorité ${libellePriorite(t.priorite)}${surPriorite ? ", changer" : ""}`}>
          <Flag size={13} aria-hidden="true" />{libellePriorite(t.priorite)}
        </button>
      )}
      {t.recurrence !== undefined && (
        <span className="pastille-tache" data-ton="violet" title="Récurrence conservée telle quelle : Carnet ne crée pas encore l'occurrence suivante.">
          <Repeat size={13} aria-hidden="true" />{libelleRecurrence(t.recurrence)}
        </span>
      )}
      {t.anomalies.map((a) => (
        <span key={a} className="pastille-tache" data-ton="anomalie" title={`${a}. Laissé tel quel dans le fichier, rien n'est réparé automatiquement.`}>
          <AlertTriangle size={13} aria-hidden="true" />{resumerAnomalie(a)}
        </span>
      ))}
    </span>
  );
}

function Section({ id, titre, nombre, ton, children, repliee, surBascule }: {
  id: string; titre: string; nombre?: number; ton?: string; children: ReactNode; repliee?: boolean; surBascule?: () => void;
}) {
  return (
    <section className="section-jour" id={`section-${id}`} aria-labelledby={`titre-${id}`} data-ton={ton}>
      <h2 className="section-jour__titre" id={`titre-${id}`}>
        {surBascule ? (
          <button type="button" className="section-jour__bascule" aria-expanded={!repliee} aria-controls={`contenu-${id}`} onClick={surBascule}>
            <ChevronRight size={16} className="section-jour__chevron" aria-hidden="true" />
            <span>{titre}</span>
            {nombre !== undefined && <span className="section-jour__nombre">{nombre}</span>}
          </button>
        ) : (
          <>
            <span>{titre}</span>
            {nombre !== undefined && <span className="section-jour__nombre">{nombre}</span>}
          </>
        )}
      </h2>
      {!repliee && <div id={`contenu-${id}`}>{children}</div>}
    </section>
  );
}

const CLE_REPLIS = "carnet:aujourdhui:deplies";

/** K10-05 : « 3 en retard · 4 aujourd'hui · 2 décisions · 1 mission », chaque compteur mène à sa section. */
function BandeCompteurs({ retard, jour, decisions, missions }: { retard: number; jour: number; decisions: number; missions: number }) {
  const aller = (e: MouseEvent<HTMLAnchorElement>, id: string) => {
    const cible = document.getElementById(id);
    if (!cible) return;
    e.preventDefault();
    const doux = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    cible.scrollIntoView({ block: "start", behavior: doux ? "smooth" : "auto" });
    const titre = cible.querySelector<HTMLElement>("h2");
    if (titre) { titre.tabIndex = -1; titre.focus({ preventScroll: true }); }
  };
  const elements: Array<{ id: string; n: number; libelle: string; ton?: string }> = [
    { id: "section-retard", n: retard, libelle: "en retard", ton: retard ? "rouge" : undefined },
    { id: "section-jour", n: jour, libelle: "aujourd'hui" },
    { id: "section-decisions", n: decisions, libelle: decisions > 1 ? "décisions" : "décision", ton: decisions ? "ambre" : undefined },
    { id: "section-missions", n: missions, libelle: missions > 1 ? "missions" : "mission" },
  ].filter((x) => x.n > 0 || x.id === "section-jour");
  return (
    <nav className="bande-compteurs" aria-label="Ta journée en bref">
      {elements.map((x, i) => (
        <span key={x.id} className="bande-compteurs__element">
          {i > 0 && <span className="bande-compteurs__point" aria-hidden="true">·</span>}
          <a href={`#${x.id}`} data-ton={x.ton} onClick={(e) => aller(e, x.id)}><strong>{x.n}</strong> {x.libelle}</a>
        </span>
      ))}
    </nav>
  );
}

export function Aujourdhui() {
  const app = useApp();
  const [d, setD] = useState<DonneesAujourdhui | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [decisions, setDecisions] = useState<Decision[] | null>(null);
  const [nouveautes, setNouveautes] = useState<Nouveaute[] | null>(null);
  const [faites, setFaites] = useState<Set<string>>(new Set());
  const [deplies, setDeplies] = useState<Set<string>>(() => {
    try { return new Set(JSON.parse(localStorage.getItem(CLE_REPLIS) ?? "[]")); } catch { return new Set(); }
  });
  const [nbMissions, setNbMissions] = useState(0);
  const prenom = app.config?.utilisateur.prenom || (app.config?.utilisateur.nom || "").split(/\s+/)[0] || "";
  const enCours = useRef(0);

  const charger = useCallback(() => {
    const n = ++enCours.current;
    api.aujourdhui().then((r) => {
      if (n !== enCours.current) return;
      setD(r); setErreur(null); setFaites(new Set());
      // Sections du lot 3 : interrogées seulement si le serveur les annonce (sinon masquées, sans 404 dans la console)
      if (!r.modules || r.modules.decisions) void api.decisionsEnAttente().then((x) => setDecisions(x && Array.isArray(x.decisions) ? x.decisions : null));
      else setDecisions(null);
      if (!r.modules || r.modules.nouveautes) void api.nouveautes().then((x) => setNouveautes(x && Array.isArray(x.pages) ? x.pages : null));
      else setNouveautes(null);
    }).catch((e) => { if (n === enCours.current) setErreur((e as Error).message); });
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let minuterie: number | null = null;
    const relancer = () => {
      if (minuterie) window.clearTimeout(minuterie);
      minuterie = window.setTimeout(charger, 400);
    };
    const fin = ecouter((e) => { if (e.type === "modif" || e.type === "arbre") relancer(); });
    window.addEventListener("carnet:boite", relancer);
    return () => { fin(); window.removeEventListener("carnet:boite", relancer); if (minuterie) window.clearTimeout(minuterie); };
  }, [charger]);

  const basculer = (id: string) => setDeplies((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    try { localStorage.setItem(CLE_REPLIS, JSON.stringify([...n])); } catch { /* navigation privée */ }
    return n;
  });

  /** Modifie une tâche ; un même geste garde le même identifiant de requête (renvoi sans effet double). */
  const modifier = async (t: TacheJour, ch: ChangementsTache, message?: string): Promise<{ texte: string | null } | null> => {
    const requete = nouvelleRequete();
    try {
      let r: { texte: string | null };
      try {
        r = await api.modifierTache(t, ch, requete);
      } catch (e) {
        if (e instanceof ErreurApi && e.statut !== 0 && e.statut < 500) throw e;
        r = await api.modifierTache(t, ch, requete); // une seule relance, même geste
      }
      if (message) app.notifier(message);
      return r;
    } catch (e) {
      const raison = e instanceof ErreurApi && e.statut === 409
        ? "la ligne a changé entre-temps, la liste est rechargée"
        : (e as Error).message;
      app.notifier(`Tâche non modifiée : ${raison}`);
      charger();
      return null;
    }
  };

  /**
   * Échéances : cocher une fiche de base = poser la valeur « fait » déclarée par la base (Statut: Fait) dans son
   * en-tête, à la révision lue. Un même geste garde le même identifiant (une relance réseau sans double effet) ;
   * 412 = modifiée ailleurs (rien n'est écrasé, la liste est rechargée) ; refus du serveur affiché tel quel.
   */
  const ecrireFiche = async (t: TacheJour, etag: string, corps: Parameters<typeof api.cocherFiche>[2]) => {
    const requete = nouvelleRequete();
    try {
      try {
        return await api.cocherFiche(t.chemin, etag, corps, requete);
      } catch (e) {
        if (e instanceof ErreurApi && e.statut !== 0 && e.statut < 500) throw e;
        return await api.cocherFiche(t.chemin, etag, corps, requete); // une seule relance, même geste
      }
    } catch (e) {
      const raison = e instanceof ErreurApi && e.statut === 412
        ? "la fiche a été modifiée ailleurs ; rien n'a été écrasé, la liste est rechargée"
        : (e as Error).message;
      app.notifier(`Fiche non modifiée : ${raison}`);
      charger();
      return null;
    }
  };

  const cocherFiche = async (t: TacheJour) => {
    const f = t.fiche!;
    const k = cle(t);
    if (faites.has(k)) return;
    setFaites((x) => new Set(x).add(k));
    const r = await ecrireFiche(t, f.etag, { fait: true });
    if (!r) { setFaites((x) => { const n = new Set(x); n.delete(k); return n; }); return; }
    const avant = f.absente ? { fait: false as const, absente: true as const } : { fait: false as const, avant: f.avant ?? null };
    app.notifier(`Fiche terminée (${f.propriete} : ${f.valeur === true ? "cochée" : String(f.valeur)})`, {
      libelle: "Annuler",
      faire: () => void ecrireFiche(t, r.etag, avant).then(() => charger()),
    });
  };

  const cocher = async (t: TacheJour) => {
    if (t.fiche) return cocherFiche(t);
    const k = cle(t);
    if (faites.has(k)) return;
    setFaites((f) => new Set(f).add(k));
    // Tâche au format Tasks (date, priorité, récurrence) : le serveur ajoute ✅ avec la date du jour ; simple case : rien.
    const tasks = Boolean(t.echeance || t.prevue || t.debut || t.priorite || t.recurrence !== undefined);
    const r = await modifier(t, tasks ? { coche: true, faite: true } : { coche: true });
    if (!r) { setFaites((f) => { const n = new Set(f); n.delete(k); return n; }); return; }
    const texte = r.texte;
    app.notifier("Tâche terminée", texte ? {
      libelle: "Annuler",
      faire: () => void modifier({ ...t, texte }, tasks ? { coche: false, faite: null } : { coche: false }).then(() => charger()),
    } : undefined);
  };

  const changerDate = async (t: TacheJour) => {
    const v = await demanderDate({ titre: "Échéance", valeur: t.echeance ?? null });
    if (v === undefined || v === (t.echeance ?? null)) return;
    if (await modifier(t, { echeance: v }, v ? `Échéance : ${dateEnToutesLettres(v)}` : "Échéance retirée")) charger();
  };

  const changerPriorite = async (t: TacheJour) => {
    const p = await demanderPriorite(t.priorite ?? null);
    if (p === undefined || p === (t.priorite ?? null)) return;
    if (await modifier(t, { priorite: p }, p ? `Priorité ${libellePriorite(p)}` : "Priorité retirée")) charger();
  };

  const menuTache = async (t: TacheJour) => {
    if (t.fiche) {
      const f = t.fiche;
      const c = await app.actions(t.libelle.slice(0, 80) || "Fiche", [
        { cle: "ouvrir", libelle: `Ouvrir la fiche « ${t.titre} »` },
        { cle: "base", libelle: `Ouvrir la base « ${f.baseTitre} »` },
      ]);
      if (c === "ouvrir") naviguer({ vue: "page", chemin: t.chemin });
      if (c === "base") naviguer({ vue: "page", chemin: f.base });
      return;
    }
    const c = await app.actions(nettoyerLibelle(t.libelle).slice(0, 80) || "Tâche", [
      { cle: "ouvrir", libelle: `Ouvrir « ${t.titre} »` },
      { cle: "date", libelle: t.echeance ? "Changer l'échéance" : "Ajouter une échéance" },
      { cle: "priorite", libelle: t.priorite ? "Changer la priorité" : "Ajouter une priorité" },
    ]);
    if (c === "ouvrir") naviguer({ vue: "page", chemin: t.chemin });
    if (c === "date") void changerDate(t);
    if (c === "priorite") void changerPriorite(t);
  };

  const jour = d?.date ?? "";

  // Densité : au-delà de 8 tâches en retard, les suivantes sont repliées (« Voir les N autres »)
  const [toutRetard, setToutRetard] = useState(false);
  const MAX_REPLI = 8;

  const listeTaches = (tout: TacheJour[], id: string, replier = false) => {
    const taches = replier && !toutRetard && tout.length > MAX_REPLI + 1 ? tout.slice(0, MAX_REPLI) : tout;
    const reste = tout.length - taches.length;
    return (
    <>
    <ul className="taches taches--jour" data-section={id}>
      {taches.map((t) => {
        const k = cle(t);
        const faite = faites.has(k);
        return (
          <li key={k} className="tache" data-faite={faite} data-coche={t.coche === " " ? undefined : t.coche} data-fiche={t.fiche ? "" : undefined}>
            <button type="button" className="tache__case" role="checkbox" aria-checked={faite}
              aria-label={`Terminer : ${nettoyerLibelle(t.libelle)}`} onClick={() => void cocher(t)} disabled={faite}>
              {faite ? CASE_COCHEE : CASE}
            </button>
            <span className="tache__texte">
              <a className="tache__libelle" href={urlDe({ vue: "page", chemin: t.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: t.chemin })}>
                {t.libelle ? avecMentions(nettoyerLibelle(t.libelle)) : <em className="tache__vide">(tâche sans texte)</em>}
              </a>
              <span className="tache__meta">
                {t.fiche ? (
                  <>
                    <PastillesTache t={t} jour={jour} />
                    {/* provenance : la base (page qui porte le tableau), pas la fiche elle-même */}
                    <a className="tache__page tache__base" href={urlDe({ vue: "page", chemin: t.fiche.base })}
                      onClick={(e) => surLienInterne(e, { vue: "page", chemin: t.fiche!.base })} title={`Fiche de la base « ${t.fiche.baseTitre} »`}>
                      <Table2 size={14} aria-hidden="true" /><span className="masque-visuel">Base </span>{t.fiche.baseTitre}
                    </a>
                  </>
                ) : (
                  <>
                    <PastillesTache t={t} jour={jour} surDate={() => void changerDate(t)} surPriorite={() => void changerPriorite(t)} />
                    <span className="tache__page"><IconePage icone={t.icone} taille={14} />{t.titre}</span>
                  </>
                )}
              </span>
            </span>
            <button type="button" className="bouton-icone tache__menu" aria-label={`Actions : ${nettoyerLibelle(t.libelle)}`} onClick={() => void menuTache(t)}>
              <MoreHorizontal size={18} />
            </button>
          </li>
        );
      })}
    </ul>
    {reste > 0 && (
      <button type="button" className="section-jour__voir-plus" aria-controls={`contenu-${id}`} onClick={() => setToutRetard(true)}>
        <ChevronDown size={16} aria-hidden="true" /> Voir les {reste} autres
      </button>
    )}
    </>
    );
  };

  const rien = d && !d.enRetard.length && !d.aujourdhui.length && !d.semaine.length;
  const critere = d?.aRelire.critere;

  return (
    <>
      <Entete fil={[{ titre: "Aujourd'hui" }]} />
      <main className="feuille aujourdhui">
        <h1 className="accueil__salut">{salut()}{prenom ? `, ${prenom}` : ""}</h1>
        <p className="accueil__date">{dateLongue()}</p>
        <span className="accueil__vague"><Vague largeur={150} hauteur={14} epaisseur={2} cretes={6} /></span>
        {d && <BandeCompteurs retard={d.enRetard.length} jour={d.aujourdhui.length} decisions={decisions?.length ?? 0} missions={nbMissions} />}
        <div className="accueil__actions">
          <button type="button" className="bouton bouton--primaire" onClick={app.capturer}>
            <Plus size={19} /> Capturer
          </button>
          <button type="button" className="bouton" onClick={app.ouvrirRecherche}>
            <Search size={18} /> Rechercher
          </button>
          {/* lot 6 : journal du jour (Journal/AAAA-MM-JJ.md, créé une seule fois) */}
          <button type="button" className="bouton" onClick={() => void app.ouvrirJournal()}>
            <NotebookPen size={18} /> Journal du jour
          </button>
        </div>

        {!d && !erreur && <SqueletteAccueil />}
        {erreur && !d && (
          <EtatVide compact icone={<AlertTriangle size={20} />} titre="Impossible de charger ta journée" texte={erreur}
            actions={<button type="button" className="bouton" onClick={charger}>Réessayer</button>} />
        )}

        {d && d.boite > 0 && (
          <a className="rappel-boite" href={urlDe({ vue: "boite" })} onClick={(e) => surLienInterne(e, { vue: "boite" })}>
            <Inbox size={18} aria-hidden="true" />
            <span><strong>{d.boite}</strong> capture{d.boite > 1 ? "s" : ""} à trier dans la Boîte</span>
            <ChevronRight size={18} aria-hidden="true" />
          </a>
        )}

        {/* lot 12 : une ligne par vue « À relancer » d'une base (aucune configuration : le nom de la vue suffit) */}
        {d?.aRelancer?.map((v) => (
          <a key={`${v.chemin}#${v.bloc}-${v.vue}`} className="rappel-boite rappel-relancer" data-total={v.total}
            href={urlDe({ vue: "page", chemin: v.chemin })}
            onClick={(e) => { retenirVueBase(v.chemin, v.nom); surLienInterne(e, { vue: "page", chemin: v.chemin }); }}>
            <BellRing size={18} aria-hidden="true" />
            <span>
              <strong>{v.nom} : {v.total}</strong>
              {d.aRelancer!.length > 1 && <span className="rappel-relancer__base"> · {v.titre}</span>}
            </span>
            <ChevronRight size={18} aria-hidden="true" />
          </a>
        ))}

        {d && (
          <>
            {d.enRetard.length > 0 && (
              <Section id="retard" titre="En retard" nombre={d.enRetard.length} ton="rouge">{listeTaches(d.enRetard, "retard", true)}</Section>
            )}
            <Section id="jour" titre="Aujourd'hui" nombre={d.aujourdhui.length}>
              {d.aujourdhui.length ? listeTaches(d.aujourdhui, "jour") : (
                <p className="section-jour__vide">{rien ? "Rien de daté pour aujourd'hui. " : "Rien d'autre pour aujourd'hui. "}
                  Ajoute une échéance avec 📅 dans une tâche, ou depuis le menu « … » d'une tâche.</p>
              )}
            </Section>
          </>
        )}

        {/* K10-05 : les tâches en retard et du jour d'abord, PUIS ce qui demande une décision (décisions, missions) */}
        {decisions && decisions.length > 0 && (
          <Section id="decisions" titre="Décisions à prendre" nombre={decisions.length} ton="ambre">
            <ul className="liste-jour">
              {decisions.slice(0, 6).map((x) => (
                <li key={x.chemin}>
                  <a className="ligne-jour" href={urlDe({ vue: "page", chemin: x.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: x.chemin })}>
                    <Gavel size={18} className="ligne-jour__icone" aria-hidden="true" />
                    <span className="ligne-jour__corps">
                      <span className="ligne-jour__titre">{x.titre}</span>
                      <span className="ligne-jour__detail">
                        {[x.demandee_par ? `demandée par ${x.demandee_par}` : null, x.echeance ? `avant ${libelleDate(String(x.echeance).slice(0, 10), jour)}` : null]
                          .filter(Boolean).join(" · ") || "en attente de ta réponse"}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {/* Intégration lots 1 et 10 : missions qui attendent la personne (à arbitrer, résultats), après les décisions */}
        <ResumeMissions surNombre={setNbMissions} />

        {d && (
          <>
            {d.semaine.length > 0 && (
              <Section id="semaine" titre="7 prochains jours" nombre={d.semaine.length}>{listeTaches(d.semaine, "semaine")}</Section>
            )}
          </>
        )}

        {nouveautes && nouveautes.length > 0 && (
          <Section id="nouveautes" titre="Nouveautés" nombre={nouveautes.length}>
            <ul className="liste-jour">
              {nouveautes.slice(0, 6).map((x) => (
                <li key={x.chemin + x.etat}>
                  <a className="ligne-jour" href={urlDe({ vue: "page", chemin: x.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: x.chemin })}>
                    <Sparkles size={18} className="ligne-jour__icone" aria-hidden="true" />
                    <span className="ligne-jour__corps">
                      <span className="ligne-jour__titre">{x.titre}</span>
                      <span className="ligne-jour__detail">
                        {{ modifiee: "modifiée", nouvelle: "nouvelle page", renommee: "renommée", supprimee: "supprimée" }[x.etat] ?? x.etat}
                        {" · "}{!x.auteur || x.auteur === "non vérifié" ? "modification externe, auteur non vérifié" : x.auteur}
                        {x.mtime ? ` · ${ilYA(x.mtime)}` : ""}
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}

        {d && d.aRelire.pages.length > 0 && critere && (
          <Section id="relire" titre="À relire" nombre={d.aRelire.pages.length}>
            <p className="section-jour__critere">
              Pages dont le statut est « {critere.statut} »{critere.mentions.length ? <> ou qui te mentionnent ({critere.mentions.join(", ")})</> : null}.
            </p>
            <ul className="liste-jour">
              {d.aRelire.pages.slice(0, 8).map((p) => (
                <li key={p.chemin}>
                  <a className="ligne-jour" href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })}>
                    <span className="ligne-jour__icone"><IconePage icone={p.icone} /></span>
                    <span className="ligne-jour__corps">
                      <span className="ligne-jour__titre">{p.titre}</span>
                      <span className="ligne-jour__detail">
                        {p.raisons?.includes("statut") && <span className="pastille-tache" data-ton="ambre">statut « {critere.statut} »</span>}
                        {p.raisons?.includes("mention") && <span className="pastille-tache" data-ton="violet">te mentionne</span>}
                        <span>{ilYA(p.mtime)}</span>
                      </span>
                    </span>
                  </a>
                </li>
              ))}
            </ul>
            {d.aRelire.pages.length > 8 && <p className="section-jour__plus">et {d.aRelire.pages.length - 8} autre{d.aRelire.pages.length - 8 > 1 ? "s" : ""} (cherche « {critere.statut} »).</p>}
          </Section>
        )}

        {d && d.sansDate.length > 0 && (
          <Section id="sans-date" titre="Sans date" nombre={d.sansDate.length} repliee={!deplies.has("sans-date")} surBascule={() => basculer("sans-date")}>
            {listeTaches(d.sansDate, "sans-date")}
          </Section>
        )}
        {d && d.plusTard.length > 0 && (
          <Section id="plus-tard" titre="Plus tard" nombre={d.plusTard.length} repliee={!deplies.has("plus-tard")} surBascule={() => basculer("plus-tard")}>
            {listeTaches(d.plusTard, "plus-tard")}
          </Section>
        )}

        {d && !d.enRetard.length && !d.aujourdhui.length && !d.semaine.length && !d.sansDate.length && !d.plusTard.length && (
          <EtatVide compact icone={<CircleCheck size={20} />} titre="Rien à faire" texte="Aucune tâche ouverte dans tes pages." />
        )}

        {d && d.recents.length > 0 && (
          <Section id="recents" titre="Modifiées récemment">
            <ul className="liste-recents">
              {d.recents.slice(0, 8).map((p) => (
                <li key={p.chemin}>
                  <a className="ligne-page" href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })}>
                    <span className="ligne-page__icone"><IconePage icone={p.icone} /></span>
                    <span>{p.titre}</span>
                    <span className="ligne-page__quand">{ilYA(p.mtime)}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Section>
        )}
      </main>
    </>
  );
}
