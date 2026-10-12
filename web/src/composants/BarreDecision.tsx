// Lot 3 « Agents » : barre de décision en tête d'une page `type: decision`.
// Approuver · Demander une correction · Refuser ouvrent une feuille qui montre EXACTEMENT ce qui sera décidé (la section
// « Proposition » et les propriétés engageantes, avec leur empreinte), un commentaire facultatif (gardé en cas d'échec),
// puis la confirmation : clé d'accès (Face ID, Touch ID) si une clé est enregistrée, sinon « geste non prouvé ».
// L'état affiché vient de la preuve calculée par le serveur (attestations), jamais du seul Markdown.
import { Suspense, useCallback, useEffect, useState } from "react";
import { Check, ChevronDown, FileClock, PencilLine, Scale, ScanFace, ShieldAlert, ShieldCheck, X } from "lucide-react";
import { apiAgents, ErreurApi, type EnregistrementDecision, type ResultatDecision, type VueDecision } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import { messageWebauthn, nouvelleRequete, signerDecision, webauthnDisponible } from "../cles-acces";
import { Feuille } from "./Feuille";
import { Differences, quand } from "./BandeauxAgents";

const TONS: Record<string, string> = {
  "en attente": "ambre", "approuvée": "vert", "à corriger": "violet", "refusée": "rouge", "incomplète": "gris", "indéterminée": "rouge",
};

/**
 * Dans l'app iOS (vue web, User-Agent « CarnetiOS/ »), les clés d'accès ne fonctionnent pas (l'app n'est pas associée
 * au domaine, le CDN d'Apple ne joint pas le tailnet) : on décide dans Safari. Lien de même origine marqué
 * `?ouvrir=safari`, que l'app (lot 9) intercepte pour l'ouvrir dans Safari.
 */
export function dansAppIos(): boolean {
  return typeof navigator !== "undefined" && navigator.userAgent.includes("CarnetiOS/");
}

export function statutEffectif(v: VueDecision): string {
  if (v.decidable) return "en attente";
  if (v.preuve.etat === "valide" && v.preuve.resultat) return v.preuve.resultat;
  if (v.preuve.etat === "indeterminee") return "indéterminée";
  if (v.bloquants.length) return "incomplète";
  return v.preuve.resultat ?? "incomplète";
}

const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });

/** « 2026-10-20 » -> « 20 oct. 2026 » (texte tel quel s'il n'est pas une date). */
export function jourLisible(d: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim());
  if (!m) return d;
  return fmtJour.format(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function empreinteCourte(e: string | null | undefined): string {
  return e ? `${e.slice(7, 13)}…${e.slice(-6)}` : "—";
}

function Preuve({ v }: { v: VueDecision }) {
  const p = v.preuve;
  const res = p.resultat ? p.resultat.charAt(0).toUpperCase() + p.resultat.slice(1) : "";
  const derniere = v.enregistrements.length ? v.enregistrements[v.enregistrements.length - 1] : null;
  const quandAtt = quand(p.t ?? (derniere?.verification !== "non-attestee" ? derniere?.le : null));
  if (v.bloquants.length) return <p className="decision__preuve" data-etat="absente">Demande incomplète : aucune décision ne peut être prise ni prouvée.</p>;
  if (p.etat === "absente") return <p className="decision__preuve" data-etat="absente">Aucune décision attestée pour l'instant.</p>;
  if (p.etat === "indeterminee") {
    return (
      <p className="decision__preuve" data-etat="alerte">
        <ShieldAlert size={16} aria-hidden="true" />{" "}
        {p.journalCoupe
          ? "Le journal des attestations a été coupé après cette décision (une ligne a disparu) : rien n'est prouvé."
          : "Preuve indéterminée (décision interrompue ou attestation illisible) : rien n'est prouvé. Vérifie l'historique."}
      </p>
    );
  }
  if (p.etat === "perimee") {
    return (
      <p className="decision__preuve" data-etat="alerte">
        <ShieldAlert size={16} aria-hidden="true" /> La dernière décision ({p.resultat}) portait sur une autre version de la proposition : elle ne vaut pas pour le texte actuel.
      </p>
    );
  }
  if (p.etat === "remplacee") {
    return (
      <p className="decision__preuve" data-etat="alerte">
        <ShieldAlert size={16} aria-hidden="true" /> Cette version de la proposition a été décidée, puis une décision plus récente (« {p.resultat} ») a porté sur une autre version : elle ne vaut plus.
      </p>
    );
  }
  const prouve = p.geste === "cle-d-acces";
  return (
    <p className="decision__preuve" data-etat={prouve ? "prouvee" : "non-prouvee"}>
      {prouve ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}
      {" "}{res}{quandAtt ? ` le ${quandAtt}` : ""} · {prouve ? "geste prouvé par clé d'accès" : "geste non prouvé (identité du réseau seulement)"}
    </p>
  );
}

function Enregistrement({ e }: { e: EnregistrementDecision }) {
  const [copie, setCopie] = useState(false);
  const badge = e.verification === "attestee"
    ? (e.geste_atteste === "cle-d-acces" ? ["vert", "attestée, clé d'accès"] : ["bleu", "attestée, geste non prouvé"])
    : e.verification === "remplacee" ? ["gris", "attestée, remplacée depuis"] : ["rouge", "déclaration non attestée"];
  return (
    <li className="decision-histo" data-verification={e.verification}>
      <div className="decision-histo__ligne">
        <span className="pastille" data-ton={TONS[e.resultat ?? ""] ?? "gris"}>{e.resultat ?? "résultat illisible"}</span>
        <span className="decision-histo__quand">{quand(e.le) || e.le || "date inconnue"}</span>
        <span className="pastille pastille--etiquette" data-verif={badge[0]}>{badge[1]}</span>
      </div>
      <p className="decision-histo__meta">par {e.par ?? "?"} · empreinte {empreinteCourte(e.empreinte)}</p>
      {e.commentaire && <blockquote className="decision-histo__commentaire">{e.commentaire}</blockquote>}
      {e.copie && (
        <>
          <button type="button" className="bouton bouton--discret decision-histo__voir" aria-expanded={copie} onClick={() => setCopie((x) => !x)}>
            <ChevronDown size={16} style={{ transform: copie ? "rotate(180deg)" : undefined }} /> Proposition figée
          </button>
          {copie && <pre className="decision-texte">{e.copie}</pre>}
        </>
      )}
    </li>
  );
}

export default function BarreDecision({ chemin }: { chemin: string }) {
  const [v, setV] = useState<VueDecision | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [geste, setGeste] = useState<ResultatDecision | null>(null);
  const app = useApp();
  const charger = useCallback(async () => {
    try {
      setV(await apiAgents.decision(chemin));
      setErreur(null);
    } catch (e) {
      setErreur((e as Error).message);
    }
  }, [chemin]);
  useEffect(() => { void charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    return ecouter((e) => {
      if (e.type === "modif" && e.chemin === chemin) { if (m) window.clearTimeout(m); m = window.setTimeout(() => void charger(), 250); }
    });
  }, [chemin, charger]);

  if (erreur) return <p className="decision decision--erreur" role="alert">Décision illisible : {erreur}</p>;
  if (!v) return <div className="squelette" style={{ height: 132, marginTop: 6 }} />;
  const statut = statutEffectif(v);
  const nonAttestees = v.enregistrements.filter((e) => e.verification === "non-attestee").length;
  const sansCleIci = v.cles.nombre > 0 && v.cles.pourCetteAdresse === 0;

  return (
    <section className="decision" aria-labelledby="decision-titre" data-statut={statut}>
      <div className="decision__tete">
        <span className="decision__icone" aria-hidden="true"><Scale size={18} /></span>
        <h2 id="decision-titre" className="decision__titre">{statut === "en attente" ? "Décision demandée" : "Décision"}</h2>
        <span className="pastille" data-ton={TONS[statut] ?? "gris"}>{statut}</span>
      </div>
      <p className="decision__meta">
        {[v.demandee_par ? `demandée par ${v.demandee_par}` : "", v.echeance ? `échéance ${jourLisible(v.echeance)}` : "", v.id ?? ""].filter(Boolean).join(" · ")}
      </p>
      <Preuve v={v} />
      {nonAttestees > 0 && (
        <p className="decision__alerte" role="note">
          <ShieldAlert size={16} aria-hidden="true" /> Le fichier contient {nonAttestees > 1 ? `${nonAttestees} décisions` : "une décision"} sans attestation : simple déclaration, elle ne vaut rien.
        </p>
      )}
      {v.statut_declare && v.statut_declare !== statut && v.statut_declare !== "en attente" && (
        <p className="decision__alerte" role="note">Le fichier indique « {v.statut_declare} » : non attesté, ce n'est qu'une déclaration.</p>
      )}
      {v.decidable && v.cles.nombre > 0 && dansAppIos() ? (
        <>
          <div className="decision__actions">
            <a className="bouton bouton--primaire decision__safari" href={`${urlDe({ vue: "page", chemin })}?ouvrir=safari`} target="_blank" rel="noopener">
              <ScanFace size={18} /> Décider dans Safari (Face ID)
            </a>
          </div>
          <p className="decision__note">
            Tes décisions sont prouvées par ta clé d'accès, qui ne fonctionne que dans Safari : la demande s'y ouvre, tu y
            approuves, demandes une correction ou refuses avec Face ID.
          </p>
        </>
      ) : v.decidable ? (
        <>
          {v.approuvable === false && (
            // K10-04 : proposition non renseignée : approbation impossible, dit clairement (correction et refus restent)
            <p className="decision__alerte decision__incomplete" id="decision-incomplete" role="alert">
              <ShieldAlert size={16} aria-hidden="true" /> {v.raison_approbation ?? "Proposition non renseignée : complète l'objet et l'action avant d'approuver."}
            </p>
          )}
          <div className="decision__actions">
            <button type="button" className="bouton bouton--primaire" disabled={sansCleIci || v.approuvable === false}
              aria-describedby={v.approuvable === false ? "decision-incomplete" : undefined} onClick={() => setGeste("approuvée")}><Check size={18} /> Approuver</button>
            <button type="button" className="bouton" disabled={sansCleIci} onClick={() => setGeste("à corriger")}><PencilLine size={18} /> Demander une correction</button>
            <button type="button" className="bouton" disabled={sansCleIci} onClick={() => setGeste("refusée")}><X size={18} /> Refuser</button>
          </div>
          <p className="decision__note">
            Tu décides sur la section « Proposition » telle qu'elle est maintenant (empreinte {empreinteCourte(v.empreinte)}).
            {v.manques.length > 0 && <> À préciser par l'agent : {v.manques.join(", ")}.</>}
          </p>
          {sansCleIci && (
            <p className="decision__alerte" role="note">Ta clé d'accès est enregistrée pour une autre adresse de Carnet : ouvre Carnet depuis cette adresse pour décider.</p>
          )}
        </>
      ) : (
        <p className="decision__raison">{v.raison}</p>
      )}
      {v.decidable && v.cles.nombre === 0 && (
        <p className="decision__cle">
          <a href={urlDe({ vue: "cles" })} onClick={(e) => surLienInterne(e, { vue: "cles" })}>Prouver tes décisions avec Face ID ou Touch ID</a>
        </p>
      )}
      {v.enregistrements.length > 0 && (
        <details className="decision__historique">
          <summary><FileClock size={16} aria-hidden="true" /> Historique de la demande ({v.enregistrements.length})</summary>
          <ol>{[...v.enregistrements].reverse().map((e) => <Enregistrement key={e.ligne} e={e} />)}</ol>
        </details>
      )}
      {geste && (
        <FeuilleDecision
          v={v}
          resultat={geste}
          onFermer={() => setGeste(null)}
          onFait={(r) => {
            setGeste(null);
            app.notifier(r.rejoue ? "Décision déjà enregistrée" : r.geste === "cle-d-acces" ? "Décision enregistrée et prouvée" : "Décision enregistrée (geste non prouvé)");
            window.dispatchEvent(new Event("carnet:decision"));
            void charger();
          }}
        />
      )}
    </section>
  );
}

/** Ce qui est décidé, en texte : la proposition puis les propriétés engageantes (pour comparer deux versions). */
function texteDecide(proposition: string | null, engage: VueDecision["engage"]): string {
  const l = engage.map((p) => `${p.cle} : ${p.presente ? JSON.stringify(p.valeur) : "(absente)"}`);
  return (proposition ?? "") + (l.length ? "\n\nPropriétés engageantes :\n" + l.join("\n") : "");
}

const TITRES: Record<ResultatDecision, string> = {
  "approuvée": "Approuver la proposition",
  "à corriger": "Demander une correction",
  "refusée": "Refuser la proposition",
};
const EXPLICATIONS: Record<ResultatDecision, string> = {
  "approuvée": "Tu approuves exactement le texte ci-dessous, rien d'autre : ni le contexte de la page, ni les liens, ni les pages liées. L'approbation n'autorise pas à elle seule l'exécution.",
  "à corriger": "La proposition retourne à l'agent. Ce n'est pas une approbation : une nouvelle proposition demandera une nouvelle décision.",
  "refusée": "Tu refuses le texte ci-dessous. L'agent ne doit pas l'exécuter.",
};
const BOUTONS: Record<ResultatDecision, string> = { "approuvée": "Approuver", "à corriger": "Demander la correction", "refusée": "Refuser" };

/** Nom du geste de l'appareil : Face ID (iPhone, iPad), Touch ID (Mac), sinon « ta clé d'accès ». */
export function nomCle(): string {
  if (/iPhone|iPad/.test(navigator.userAgent)) return "Face ID";
  if (/Mac/.test(navigator.platform)) return "Touch ID";
  return "ta clé d'accès";
}

function FeuilleDecision({ v, resultat, onFermer, onFait }: {
  v: VueDecision; resultat: ResultatDecision; onFermer: () => void; onFait: (r: { geste: string; rejoue: boolean }) => void;
}) {
  const cleBrouillon = `carnet:decision:${v.chemin}:${resultat}`;
  const [commentaire, setCommentaire] = useState(() => { try { return sessionStorage.getItem(cleBrouillon) ?? ""; } catch { return ""; } });
  const [vue, setVue] = useState(v);
  const [requete, setRequete] = useState(nouvelleRequete);
  const [etat, setEtat] = useState<"pret" | "cle" | "envoi">("pret");
  const [erreur, setErreur] = useState<string | null>(null);
  const [change, setChange] = useState<{ proposition: string; empreinte: string; engage: VueDecision["engage"] } | null>(null);
  const [defi, setDefi] = useState<{ o: Record<string, unknown>; t: number; commentaire: string } | null>(null);
  const avecCle = vue.cles.nombre > 0;
  useEffect(() => { try { sessionStorage.setItem(cleBrouillon, commentaire); } catch { /* navigation privée */ } }, [cleBrouillon, commentaire]);

  // Défi de la clé d'accès préparé d'avance (et refait quand le commentaire change, car l'appareil signe aussi le
  // commentaire) : sur iPhone, Face ID doit partir directement du toucher, sans attente réseau.
  const preparerDefi = useCallback(async (c: string) => {
    if (!avecCle || !vue.cles.pourCetteAdresse || !webauthnDisponible() || !vue.id || !vue.empreinte) return null;
    try {
      const o = await apiAgents.defiDecision({ chemin: vue.chemin, demande: vue.id, empreinte: vue.empreinte, resultat, commentaire: c });
      const d = { o, t: Date.now(), commentaire: c };
      setDefi(d);
      return d;
    } catch (e) {
      setErreur(`Clé d'accès indisponible : ${(e as Error).message}`);
      return null;
    }
  }, [avecCle, vue, resultat]);
  useEffect(() => {
    const m = window.setTimeout(() => void preparerDefi(commentaire), 500);
    return () => window.clearTimeout(m);
  }, [commentaire, preparerDefi]);

  const confirmer = async () => {
    setErreur(null);
    let assertion: Record<string, unknown> | undefined;
    if (avecCle) {
      if (!webauthnDisponible()) { setErreur("Ce navigateur ne propose pas les clés d'accès ici (https ou localhost requis)."); return; }
      let d = defi;
      if (!d || d.commentaire !== commentaire || Date.now() - d.t > 4 * 60_000) {
        setEtat("cle");
        d = await preparerDefi(commentaire);
        if (!d) { setEtat("pret"); return; }
      }
      setEtat("cle");
      try {
        assertion = await signerDecision(d.o);
      } catch (e) {
        setEtat("pret");
        setErreur(messageWebauthn(e));
        return;
      }
    }
    setEtat("envoi");
    try {
      const r = await apiAgents.decider({ chemin: vue.chemin, demande: vue.id, empreinte: vue.empreinte, resultat, commentaire, assertion, decision: defi?.o.decisionId }, requete);
      try { sessionStorage.removeItem(cleBrouillon); } catch { /* navigation privée */ }
      onFait(r);
    } catch (e) {
      setEtat("pret");
      if (e instanceof ErreurApi && e.statut === 409 && typeof e.corps.proposition === "string") {
        setChange({ proposition: e.corps.proposition, empreinte: String(e.corps.empreinte ?? ""), engage: Array.isArray(e.corps.engage) ? e.corps.engage as VueDecision["engage"] : [] });
        setErreur(e.message);
      } else if (e instanceof ErreurApi) {
        setErreur(`${e.message} Rien n'a été enregistré.`);
      } else {
        setErreur("Carnet ne répond pas : rien n'est confirmé. Réessaie (même geste, aucun doublon possible).");
      }
    }
  };

  const relire = async () => {
    try {
      const nv = await apiAgents.decision(vue.chemin);
      setVue(nv);
      setChange(null);
      setErreur(!nv.decidable ? nv.raison : resultat === "approuvée" && nv.approuvable === false ? nv.raison_approbation ?? null : null);
      setRequete(nouvelleRequete());
      setDefi(null);
    } catch (e) {
      setErreur((e as Error).message);
    }
  };

  const occupe = etat !== "pret";
  return (
    <Feuille titre={TITRES[resultat]} onFermer={onFermer}>
      <div className="dialogue__corps decision-feuille" data-resultat={resultat}>
        <p className="dialogue__texte">{EXPLICATIONS[resultat]}</p>
        <div className="decision-feuille__proposition" tabIndex={0} role="region" aria-label="Proposition soumise à décision">
          <pre className="decision-texte">{vue.proposition}</pre>
          {vue.engage.length > 0 && (
            <dl className="decision-feuille__engage">
              <dt>Propriétés engageantes</dt>
              {vue.engage.map((p) => <dd key={p.cle}><code>{p.cle}</code> : {p.presente ? JSON.stringify(p.valeur) : "(absente)"}</dd>)}
            </dl>
          )}
        </div>
        <p className="decision-feuille__empreinte">Empreinte de ce texte : <code>{empreinteCourte(vue.empreinte)}</code></p>
        {change && (
          <div className="decision-feuille__change" role="alert">
            <p><strong>{erreur}</strong> Voici ce qui a changé :</p>
            <Suspense fallback={<div className="squelette" style={{ height: 80 }} />}>
              <Differences avant={texteDecide(vue.proposition, vue.engage)} apres={texteDecide(change.proposition, change.engage)} />
            </Suspense>
            <button type="button" className="bouton bouton--petit" onClick={() => void relire()}>Relire la nouvelle proposition</button>
          </div>
        )}
        <label className="decision-feuille__commentaire">
          <span>Commentaire (facultatif)</span>
          <textarea data-sans-focus rows={3} value={commentaire} maxLength={10_000} onChange={(e) => setCommentaire(e.target.value)}
            placeholder={resultat === "à corriger" ? "Ce qu'il faut corriger…" : "Une précision pour l'agent…"} />
        </label>
        {!avecCle && (
          <p className="decision-feuille__note">
            Geste non prouvé : sans clé d'accès, ta décision est enregistrée et attestée, mais rien ne prouve que c'est toi
            plutôt qu'un agent qui utilise ton compte.{" "}
            <a href={urlDe({ vue: "cles" })} onClick={(e) => { e.preventDefault(); onFermer(); naviguer({ vue: "cles" }); }}>Enregistrer une clé d'accès</a>
          </p>
        )}
        {erreur && !change && <p className="decision-feuille__erreur" role="alert">{erreur} Ton commentaire est gardé.</p>}
        <div className="boutons">
          <button type="button" className="bouton" onClick={onFermer}>Annuler</button>
          <button type="button" data-autofocus className={`bouton ${resultat === "refusée" ? "bouton--danger" : "bouton--primaire"}`}
            disabled={occupe || !!change || !vue.decidable || (resultat === "approuvée" && vue.approuvable === false)} onClick={() => void confirmer()}>
            {etat === "cle" ? "Confirmation…" : etat === "envoi" ? "Enregistrement…" : avecCle ? <><ScanFace size={18} /> {BOUTONS[resultat]} avec {nomCle()}</> : BOUTONS[resultat]}
          </button>
        </div>
      </div>
    </Feuille>
  );
}
