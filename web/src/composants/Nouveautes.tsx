// Lot 3 « Agents » : écran « Nouveautés » : pages modifiées, créées, renommées ou supprimées depuis la version que
// tu as marquée vue. Ouvrir une page ne la marque pas vue ; « Marquer comme vu » et « Tout marquer » enregistrent les
// versions PRÉSENTÉES ici (une version arrivée entre-temps reste dans la liste). Auteur « non vérifié » sauf preuve.
import { Suspense, useCallback, useEffect, useState } from "react";
import { ArrowRight, Check, CheckCheck, Eye, EyeOff, Sparkles, Undo2 } from "lucide-react";
import { RetourVue } from "./Fiabilite"; // lot 5
import { apiAgents, type DetailNouveaute, type Nouveaute } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { IconePage } from "./Icone";
import { Differences, quand, texteAuteur, texteDeclaration } from "./BandeauxAgents";
import { ilYA } from "../outils";
import { dossierDe } from "../../../shared/page.ts";
import "../styles/agents.css";

const ETATS: Record<string, [string, string]> = {
  modifiee: ["modifiée", "bleu"], nouvelle: ["nouvelle", "vert"], renommee: ["renommée", "violet"], supprimee: ["supprimée", "rouge"],
};

function Ligne({ n, lieu, surMarquer, surRetour }: { n: Nouveaute; lieu: (c: string) => string; surMarquer: (n: Nouveaute) => Promise<void>; surRetour: () => void }) {
  const [voir, setVoir] = useState(false);
  const [retour, setRetour] = useState(false);
  const [detail, setDetail] = useState<DetailNouveaute | null>(null);
  const [occupe, setOccupe] = useState(false);
  const cible = n.vers ?? n.chemin;
  const route = { vue: "page" as const, chemin: cible };
  const [libelle, ton] = ETATS[n.etat];
  const comparable = n.etat === "modifiee" || (n.etat === "renommee" && n.modifiee);
  useEffect(() => {
    if (!voir || detail) return;
    apiAgents.nouveaute(cible).then(setDetail).catch(() => setDetail({ etat: "inconnue", depart: "" }));
  }, [voir, detail, cible]);
  const meta = [
    n.etat === "supprimee" ? `${lieu(n.chemin)} · vue le ${quand(n.vu_le)}` : `${lieu(cible)} · ${ilYA(n.mtime)}`,
    n.etat === "supprimee" ? "" : texteAuteur(n.auteur),
  ].filter(Boolean).join(" · ");
  const decl = texteDeclaration(n.maj_par_declare, n.motif_declare);
  const titre = (
    <span className="nouveaute__texte">
      <span className="nouveaute__titre">{n.titre}</span>
      {n.etat === "renommee" && (
        <span className="nouveaute__renommage">{n.chemin.replace(/\.md$/, "")} <ArrowRight size={13} aria-label="devient" /> {cible.replace(/\.md$/, "")}</span>
      )}
      <span className="nouveaute__meta">{meta}</span>
      {decl && <span className="nouveaute__declare">{decl}</span>}
    </span>
  );
  return (
    <li className="nouveaute" data-etat={n.etat}>
      <div className="nouveaute__ligne">
        {n.etat === "supprimee" ? (
          <span className="nouveaute__corps nouveaute__corps--inerte">
            <span className="element-corbeille__icone"><IconePage icone={n.icone} taille={18} /></span>
            {titre}
          </span>
        ) : (
          <a className="nouveaute__corps" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>
            <span className="element-corbeille__icone"><IconePage icone={n.icone} taille={18} /></span>
            {titre}
          </a>
        )}
        <span className="nouveaute__droite">
          <span className="pastille" data-ton={ton}>{libelle}</span>
          {(n.ajouts !== undefined || n.retraits !== undefined) && (
            <span className="nouveaute__bilan">
              {!!n.ajouts && <span className="comparaison__plus">+{n.ajouts}</span>}
              {!!n.retraits && <span className="comparaison__moins">−{n.retraits}</span>}
            </span>
          )}
        </span>
      </div>
      <div className="nouveaute__actions">
        {comparable && (
          <button type="button" className="bouton bouton--petit" aria-expanded={voir} onClick={() => setVoir((x) => !x)}>
            {voir ? <EyeOff size={16} /> : <Eye size={16} />} {voir ? "Masquer" : "Comparer"}
          </button>
        )}
        <button type="button" className="bouton bouton--petit" disabled={occupe}
          onClick={async () => { setOccupe(true); try { await surMarquer(n); } finally { setOccupe(false); } }}>
          <Check size={16} /> {n.etat === "supprimee" ? "Vu, oublier" : "Marquer comme vu"}
        </button>
        {n.etat === "modifiee" && (
          <button type="button" className="bouton bouton--petit" aria-expanded={retour} onClick={() => setRetour((x) => !x)}>
            <Undo2 size={16} /> Revenir à la version marquée vue
          </button>
        )}
      </div>
      {retour && n.etat === "modifiee" && (
        <RetourVue chemin={n.chemin} surFermer={() => setRetour(false)} surFini={() => { setRetour(false); surRetour(); }} />
      )}
      {voir && comparable && (
        <div className="nouveaute__diff">
          {!detail ? <div className="squelette" style={{ height: 80 }} />
            : !detail.vu?.contenu || !detail.actuel ? <p className="bandeau-nouveaute__indispo">Comparaison indisponible pour cette version.</p>
            : (
              <Suspense fallback={<div className="squelette" style={{ height: 80 }} />}>
                <Differences avant={detail.vu.contenu} apres={detail.actuel.contenu} />
              </Suspense>
            )}
        </div>
      )}
    </li>
  );
}

export function Nouveautes() {
  const app = useApp();
  const [donnees, setDonnees] = useState<{ depart: string; pages: Nouveaute[]; techniques_masquees: number } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [techniques, setTechniques] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const charger = useCallback(() => {
    apiAgents.nouveautes(techniques).then((r) => { setDonnees(r); setErreur(null); }).catch((e) => setErreur((e as Error).message));
  }, [techniques]);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    const relancer = () => { if (m) window.clearTimeout(m); m = window.setTimeout(charger, 500); };
    const fin = ecouter((e) => { if (e.type === "modif" || e.type === "arbre") relancer(); });
    window.addEventListener("carnet:vu", relancer);
    return () => { fin(); if (m) window.clearTimeout(m); window.removeEventListener("carnet:vu", relancer); };
  }, [charger]);

  const lieu = (c: string) => {
    const d = dossierDe(c);
    return d ? d.split("/").map((seg, i, tout) => app.index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ") : "Racine";
  };

  const marquer = async (liste: Nouveaute[]) => {
    try {
      const r = await apiAgents.marquerVu(liste.map((n) => ({ chemin: n.chemin, vers: n.vers, etag: n.etag })));
      if (r.restantes.length) {
        app.notifier(r.restantes.length > 1 ? `${r.restantes.length} pages ont changé entre-temps : elles restent à lire.` : "Une page a changé entre-temps : elle reste à lire.");
      } else if (liste.length > 1) app.notifier(`${r.marquees.length} pages marquées comme vues`);
      window.dispatchEvent(new Event("carnet:vu"));
      charger();
    } catch (e) {
      app.notifier(`Impossible de marquer comme vu : ${(e as Error).message}`);
    }
  };

  const pages = donnees?.pages ?? [];
  return (
    <>
      <Entete fil={[{ titre: "Nouveautés" }]} />
      <main className="feuille vue vue-agents">
        <header className="vue-tete">
          <div className="vue-tete__ligne">
            <h1 className="vue-tete__titre">Nouveautés</h1>
            {pages.length > 0 && (
              <button type="button" className="bouton bouton--petit" disabled={occupe}
                onClick={async () => { setOccupe(true); try { await marquer(pages); } finally { setOccupe(false); } }}>
                <CheckCheck size={16} /> Tout marquer comme vu
              </button>
            )}
          </div>
          <p className="vue-tete__texte">
            Ce qui a changé depuis que tu l'as marqué vu. Ouvrir une page ne la marque pas vue. Sans preuve, l'auteur reste
            « non vérifié », même si le fichier déclare un nom.
            {donnees && <> Point de départ : {quand(donnees.depart)}.</>}
          </p>
          <label className="interrupteur vue-agents__filtre">
            <input type="checkbox" checked={techniques} onChange={(e) => setTechniques(e.target.checked)} />
            <span>Inclure les fichiers des agents{donnees && !techniques && donnees.techniques_masquees > 0 ? ` (${donnees.techniques_masquees} masqué${donnees.techniques_masquees > 1 ? "s" : ""})` : ""}</span>
          </label>
        </header>
        {erreur && <p className="etat-page">Les nouveautés ne répondent pas : {erreur}</p>}
        {!donnees && !erreur && <div aria-busy="true" aria-label="Chargement">{[0, 1, 2].map((i) => <div key={i} className="squelette" style={{ height: 72 }} />)}</div>}
        {donnees && pages.length === 0 && (
          <div className="etat-vide">
            <span className="etat-vide__icone" aria-hidden="true"><Sparkles size={30} strokeWidth={1.5} /></span>
            <p className="etat-vide__titre">Rien de neuf</p>
            <p className="etat-vide__texte">Ce que les agents changent dans tes pages apparaîtra ici, avec la comparaison.</p>
          </div>
        )}
        {pages.length > 0 && (
          <ul className="liste-agents liste-nouveautes">
            {pages.map((n) => <Ligne key={`${n.chemin}>${n.vers ?? ""}`} n={n} lieu={lieu} surMarquer={(x) => marquer([x])} surRetour={charger} />)}
          </ul>
        )}
      </main>
    </>
  );
}
