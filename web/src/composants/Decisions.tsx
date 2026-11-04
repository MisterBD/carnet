// Lot 3 « Agents » : écran « Décisions » : les demandes qui attendent ton accord d'abord, puis l'historique.
// Le statut affiché est celui calculé par le serveur (attestations) ; le statut écrit dans le fichier n'est qu'une
// déclaration, signalé quand il diffère.
import { useCallback, useEffect, useState } from "react";
import { Plus, Scale, ShieldAlert, ShieldCheck } from "lucide-react";
import { apiAgents, type ResumeDecision } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { IconePage } from "./Icone";
import { quand } from "./BandeauxAgents";
import { dossierDe } from "../../../shared/page.ts";
import "../styles/agents.css";

const TONS: Record<string, string> = { "en attente": "ambre", "approuvée": "vert", "à corriger": "violet", "refusée": "rouge", "incomplète": "gris", "indéterminée": "rouge" };
const JOUR = 86_400_000;

function texteEcheance(e: string | null): { texte: string; urgent: boolean } | null {
  if (!e || !/^\d{4}-\d{2}-\d{2}/.test(e)) return e ? { texte: `échéance ${e}`, urgent: false } : null;
  const [a, m, j] = e.slice(0, 10).split("-").map(Number);
  const cible = new Date(a, m - 1, j).getTime();
  const auj = new Date(); auj.setHours(0, 0, 0, 0);
  const n = Math.round((cible - auj.getTime()) / JOUR);
  if (n < 0) return { texte: `échéance dépassée (${-n} j)`, urgent: true };
  if (n === 0) return { texte: "échéance aujourd'hui", urgent: true };
  if (n === 1) return { texte: "échéance demain", urgent: true };
  return { texte: `échéance dans ${n} j`, urgent: false };
}

function LigneDecision({ d, lieu }: { d: ResumeDecision; lieu: string }) {
  const ech = d.statut === "en attente" ? texteEcheance(d.echeance) : null;
  const route = { vue: "page" as const, chemin: d.chemin };
  const preuve = d.preuve.etat === "valide"
    ? (d.preuve.geste === "cle-d-acces" ? <span className="decision-ligne__preuve" data-ok="true"><ShieldCheck size={14} aria-hidden="true" /> geste prouvé</span>
      : <span className="decision-ligne__preuve"><ShieldAlert size={14} aria-hidden="true" /> geste non prouvé</span>)
    : null;
  return (
    <li className="decision-ligne">
      <a className="decision-ligne__corps" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>
        <span className="element-corbeille__icone"><IconePage icone={d.icone} taille={18} /></span>
        <span className="decision-ligne__texte">
          <span className="decision-ligne__titre">{d.titre}</span>
          <span className="decision-ligne__meta">
            {[lieu, d.demandee_par ? `demandée par ${d.demandee_par}` : "", d.statut !== "en attente" && d.preuve.t ? `décidée le ${quand(d.preuve.t)}` : ""].filter(Boolean).join(" · ")}
            {ech && <span className={ech.urgent ? "decision-ligne__urgent" : undefined}> · {ech.texte}</span>}
          </span>
          {(d.statut_declare && d.statut_declare !== d.statut && d.statut_declare !== "en attente") && (
            <span className="decision-ligne__alerte">Le fichier indique « {d.statut_declare} » : non attesté.</span>
          )}
          {d.derniere && d.derniere.verification === "non-attestee" && (
            <span className="decision-ligne__alerte">Contient une décision non attestée (simple déclaration).</span>
          )}
        </span>
        <span className="decision-ligne__droite">
          <span className="pastille" data-ton={TONS[d.statut] ?? "gris"}>{d.statut}</span>
          {preuve}
        </span>
      </a>
    </li>
  );
}

export function Decisions() {
  const app = useApp();
  const [liste, setListe] = useState<ResumeDecision[] | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [cles, setCles] = useState<number | null>(null);
  const charger = useCallback(() => {
    apiAgents.decisions().then((r) => { setListe(r.decisions); setErreur(null); }).catch((e) => setErreur((e as Error).message));
    apiAgents.cles().then((r) => setCles(r.cles.length)).catch(() => setCles(null));
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    const relancer = () => { if (m) window.clearTimeout(m); m = window.setTimeout(charger, 500); };
    const fin = ecouter((e) => { if (e.type === "modif" || e.type === "arbre") relancer(); });
    window.addEventListener("carnet:decision", relancer);
    return () => { fin(); if (m) window.clearTimeout(m); window.removeEventListener("carnet:decision", relancer); };
  }, [charger]);

  const lieu = (c: string) => {
    const d = dossierDe(c);
    return d ? d.split("/").map((seg, i, tout) => app.index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ") : "Racine";
  };

  const nouvelle = async () => {
    const titre = await app.demanderTexte({ titre: "Nouvelle demande de décision", placeholder: "Ce qu'il faut décider", bouton: "Créer la demande",
      texte: "Elle sera créée dans « Décisions », avec une section « Proposition » à compléter." });
    if (!titre) return;
    try {
      const r = await apiAgents.creerDecision(titre);
      await app.rechargerArbre();
      naviguer({ vue: "page", chemin: r.chemin });
    } catch (e) {
      app.notifier(`Demande non créée : ${(e as Error).message}`);
    }
  };

  const enAttente = liste?.filter((d) => d.statut === "en attente") ?? [];
  const autres = liste?.filter((d) => d.statut !== "en attente") ?? [];
  return (
    <>
      <Entete fil={[{ titre: "Décisions" }]} />
      <main className="feuille vue vue-agents">
        <header className="vue-tete">
          <div className="vue-tete__ligne">
            <h1 className="vue-tete__titre">Décisions</h1>
            <button type="button" className="bouton bouton--petit" onClick={() => void nouvelle()}><Plus size={16} /> Nouvelle demande</button>
          </div>
          <p className="vue-tete__texte">
            Les demandes des agents qui attendent ton accord, puis l'historique. Une décision écrite dans un fichier n'est qu'une
            déclaration : seule l'attestation de Carnet compte, et elle n'autorise jamais à elle seule l'exécution.
          </p>
          {cles !== null && (
            <a className={`vue-agents__cle${cles ? " vue-agents__cle--ok" : ""}`} href={urlDe({ vue: "cles" })} onClick={(e) => surLienInterne(e, { vue: "cles" })}>
              {cles ? <ShieldCheck size={16} aria-hidden="true" /> : <ShieldAlert size={16} aria-hidden="true" />}
              {cles ? `Tes décisions sont prouvées par clé d'accès (${cles} clé${cles > 1 ? "s" : ""})` : "Geste non prouvé : enregistre une clé d'accès (Face ID, Touch ID)"}
            </a>
          )}
        </header>
        {erreur && <p className="etat-page">Les décisions ne répondent pas : {erreur}</p>}
        {!liste && !erreur && <div aria-busy="true" aria-label="Chargement">{[0, 1, 2].map((i) => <div key={i} className="squelette" style={{ height: 64 }} />)}</div>}
        {liste && (
          <>
            <section aria-labelledby="dec-attente">
              <h2 className="section-agents__titre" id="dec-attente">À décider <span className="compteur">{enAttente.length}</span></h2>
              {enAttente.length === 0 ? (
                <div className="etat-vide etat-vide--compact">
                  <span className="etat-vide__icone" aria-hidden="true"><Scale size={26} strokeWidth={1.5} /></span>
                  <p className="etat-vide__titre">Rien à décider pour l'instant</p>
                  <p className="etat-vide__texte">Quand un agent te demande un accord, sa demande apparaît ici.</p>
                </div>
              ) : (
                <ul className="liste-agents">{enAttente.map((d) => <LigneDecision key={d.chemin} d={d} lieu={lieu(d.chemin)} />)}</ul>
              )}
            </section>
            {autres.length > 0 && (
              <section aria-labelledby="dec-histo">
                <h2 className="section-agents__titre" id="dec-histo">Historique <span className="compteur">{autres.length}</span></h2>
                <ul className="liste-agents">{autres.map((d) => <LigneDecision key={d.chemin} d={d} lieu={lieu(d.chemin)} />)}</ul>
              </section>
            )}
          </>
        )}
      </main>
    </>
  );
}
