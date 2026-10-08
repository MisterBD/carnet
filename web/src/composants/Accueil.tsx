// Accueil : salut, deux actions, « À relire », tâches ouvertes de toutes les pages (cochables), récents.
import { useCallback, useEffect, useState } from "react";
import { CircleCheck, Plus, Search } from "lucide-react";
import { api, type Accueil as DonneesAccueil, type Tache } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { IconePage, Vague } from "./Icone";
import { EtatVide } from "./EtatVide";
import { SqueletteAccueil } from "./Squelettes";
import { dateLongue, ilYA, salut } from "../outils";
import { dossierDe } from "../../../shared/page.ts";

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

function nettoyerLibelle(l: string): string {
  return l.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1").replace(/`([^`]+)`/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, c, a) => a ?? String(c).split("/").pop())
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1");
}

export function Accueil() {
  const app = useApp();
  const [d, setD] = useState<DonneesAccueil | null>(null);
  const [faites, setFaites] = useState<Set<string>>(new Set());
  const [toutesTaches, setToutesTaches] = useState(false);
  const prenom = app.config?.utilisateur.prenom || (app.config?.utilisateur.nom || "").split(/\s+/)[0] || "";

  const charger = useCallback(() => {
    api.accueil().then(setD).catch(() => setD({ recents: [], aRelire: [], taches: [] }));
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let minuterie: number | null = null;
    return ecouter((e) => {
      if (e.type === "modif" || e.type === "arbre") {
        if (minuterie) window.clearTimeout(minuterie);
        minuterie = window.setTimeout(charger, 400);
      }
    });
  }, [charger]);

  const cocher = async (t: Tache) => {
    const cle = `${t.chemin}:${t.ligne}`;
    const coche = !faites.has(cle);
    setFaites((f) => { const n = new Set(f); if (coche) n.add(cle); else n.delete(cle); return n; });
    try {
      await api.tache(t, coche);
      if (coche) app.notifier("Tâche cochée", { libelle: "Annuler", faire: () => void decocher(t) });
    } catch (e) {
      setFaites((f) => { const n = new Set(f); n.delete(cle); return n; });
      app.notifier(`Impossible de cocher : ${(e as Error).message}`);
      charger();
    }
  };
  const decocher = async (t: Tache) => {
    const cle = `${t.chemin}:${t.ligne}`;
    try {
      await api.tache({ ...t, texte: t.texte.replace("[ ]", "[x]") }, false);
      setFaites((f) => { const n = new Set(f); n.delete(cle); return n; });
      charger();
    } catch { charger(); }
  };

  const chemin = (c: string) => {
    const dossier = dossierDe(c);
    if (!dossier) return "";
    return dossier.split("/").map((seg, i, tout) => app.index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ");
  };

  const taches = d?.taches ?? [];
  const tachesVisibles = toutesTaches ? taches : taches.slice(0, 8);

  return (
    <>
      <Entete fil={[{ titre: "Accueil" }]} />
      <main className="feuille">
        <h1 className="accueil__salut">{salut()}{prenom ? `, ${prenom}` : ""}</h1>
        <p className="accueil__date">{dateLongue()}</p>
        <span className="accueil__vague"><Vague largeur={150} hauteur={14} epaisseur={2} cretes={6} /></span>
        <div className="accueil__actions">
          <button type="button" className="bouton bouton--primaire" onClick={() => void app.nouvellePage("")}>
            <Plus size={19} /> Nouvelle page
          </button>
          <button type="button" className="bouton" onClick={app.ouvrirRecherche}>
            <Search size={18} /> Rechercher
          </button>
        </div>

        {!d && <SqueletteAccueil />}

        {d && d.aRelire.length > 0 && (
          <section className="section-accueil" aria-labelledby="titre-relire">
            <h2 className="section-accueil__titre" id="titre-relire"><span>À relire</span><span>{d.aRelire.length}</span></h2>
            {d.aRelire.slice(0, 6).map((p) => (
              <a key={p.chemin} className="carte-relire" href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })}>
                <div className="carte-relire__haut">
                  <span className="carte-relire__titre">{p.titre}</span>
                  <span className="carte-relire__quand">{ilYA(p.mtime)}</span>
                </div>
                {chemin(p.chemin) && <div className="carte-relire__chemin">{chemin(p.chemin)}</div>}
                {p.resume && <p className="carte-relire__resume">{p.resume}</p>}
                <div className="carte-relire__pastilles">
                  {p.raisons?.includes("statut") && <span className="pastille" data-ton="ambre">à relire</span>}
                  {p.raisons?.includes("mention") && <span className="pastille" data-ton="violet">{app.config?.mentions?.[0] ?? "mention"}</span>}
                </div>
              </a>
            ))}
          </section>
        )}

        {d && (
          <section className="section-accueil" aria-labelledby="titre-taches">
            <h2 className="section-accueil__titre" id="titre-taches"><span>Tâches ouvertes</span><span>{taches.length}</span></h2>
            {taches.length === 0 ? (
              <EtatVide compact icone={<CircleCheck size={20} />} titre="Rien à faire" texte="Aucune case à cocher en attente dans tes pages." />
            ) : (
              <>
                <ul className="taches">
                  {tachesVisibles.map((t) => {
                    const cle = `${t.chemin}:${t.ligne}`;
                    const faite = faites.has(cle);
                    return (
                      <li key={cle} className="tache" data-faite={faite}>
                        <button type="button" className="tache__case" role="checkbox" aria-checked={faite} aria-label={`Cocher : ${nettoyerLibelle(t.libelle)}`} onClick={() => void cocher(t)}>
                          {faite ? CASE_COCHEE : CASE}
                        </button>
                        <span className="tache__texte">
                          <span className="tache__libelle">{avecMentions(nettoyerLibelle(t.libelle))}</span>
                          <br />
                          <a className="tache__page" href={urlDe({ vue: "page", chemin: t.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: t.chemin })}>
                            {t.titre}
                          </a>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                {taches.length > 8 && (
                  <button type="button" className="plus-de" onClick={() => setToutesTaches((v) => !v)}>
                    {toutesTaches ? "Afficher moins" : `Afficher les ${taches.length} tâches`}
                  </button>
                )}
              </>
            )}
          </section>
        )}

        {d && d.recents.length > 0 && (
          <section className="section-accueil" aria-labelledby="titre-recents">
            <h2 className="section-accueil__titre" id="titre-recents"><span>Modifiées récemment</span></h2>
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
          </section>
        )}
      </main>
    </>
  );
}
