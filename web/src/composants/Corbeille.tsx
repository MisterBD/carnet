// Corbeille : pages supprimées (30 jours), aperçu, restaurer à leur place, supprimer définitivement, vider.
import { useCallback, useEffect, useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { api, type ElementCorbeille } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer } from "../navigation";
import { signalerLigne } from "../actions-pages";
import { Entete } from "./Entete";
import { Feuille } from "./Feuille";
import { IconePage } from "./Icone";
import { ilYA } from "../outils";
import { decouper, dossierDe, feuille } from "../../../shared/page.ts";

const JOUR = 86_400_000;

export function Corbeille() {
  const app = useApp();
  const [elements, setElements] = useState<ElementCorbeille[] | null>(null);
  const [jours, setJours] = useState(app.config?.corbeille?.jours ?? 30);
  const [erreur, setErreur] = useState<string | null>(null);
  const [apercu, setApercu] = useState<{ el: ElementCorbeille; contenu: string | null } | null>(null);
  const [enCours, setEnCours] = useState<string | null>(null);

  const charger = useCallback(() => {
    api.corbeille().then((r) => { setElements(r.elements); setJours(r.jours); setErreur(null); })
      .catch((e) => setErreur((e as Error).message));
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    return ecouter((e) => {
      if (e.type === "arbre" || (e.type === "connexion" && e.etat === "ouverte")) {
        if (m) window.clearTimeout(m);
        m = window.setTimeout(charger, 250);
      }
    });
  }, [charger]);

  const lieu = (chemin: string) => {
    const d = dossierDe(chemin);
    if (!d) return "À la racine";
    return "Dans " + d.split("/").map((s, i, t) => app.index.get(t.slice(0, i + 1).join("/") + ".md")?.titre ?? s).join(" › ");
  };

  const restaurer = async (el: ElementCorbeille) => {
    setEnCours(el.id);
    try {
      const r = await api.restaurer(el.id);
      setElements((l) => l?.filter((x) => x.id !== el.id) ?? null);
      setApercu(null);
      await app.rechargerArbre();
      dossierDe(r.chemin).split("/").reduce((acc, seg) => {
        const c = acc ? `${acc}/${seg}` : seg;
        if (c) app.deplier(c + ".md");
        return c;
      }, "");
      signalerLigne(r.chemin);
      app.notifier(r.renomme ? `Restaurée sous le nom « ${feuille(r.chemin)} »` : `« ${el.titre} » est revenue à sa place`,
        { libelle: "Ouvrir", faire: () => naviguer({ vue: "page", chemin: r.chemin }) });
    } catch (e) {
      app.notifier(`Restauration impossible : ${(e as Error).message}`);
      charger();
    } finally {
      setEnCours(null);
    }
  };

  const effacer = async (el: ElementCorbeille) => {
    const ok = await app.confirmer({
      titre: "Supprimer définitivement ?",
      texte: `« ${el.titre} »${el.sousPages ? ` et ${el.sousPages > 1 ? `ses ${el.sousPages} sous-pages seront effacées` : "sa sous-page seront effacées"}` : " sera effacée"} du carnet. Ça ne se rattrape pas.`,
      bouton: "Supprimer définitivement",
      danger: true,
    });
    if (!ok) return;
    try {
      await api.effacer(el.id);
      window.dispatchEvent(new Event("carnet:corbeille"));
      setElements((l) => l?.filter((x) => x.id !== el.id) ?? null);
      setApercu(null);
      app.notifier("Supprimée définitivement");
    } catch (e) {
      app.notifier(`Suppression impossible : ${(e as Error).message}`);
      charger();
    }
  };

  const vider = async () => {
    const n = elements?.length ?? 0;
    if (!n) return;
    const ok = await app.confirmer({
      titre: "Vider la corbeille ?",
      texte: `${n > 1 ? `Les ${n} éléments de la corbeille seront effacés` : "L'élément de la corbeille sera effacé"} du carnet. Ça ne se rattrape pas.`,
      bouton: "Vider la corbeille",
      danger: true,
    });
    if (!ok) return;
    try {
      const r = await api.viderCorbeille();
      window.dispatchEvent(new Event("carnet:corbeille"));
      setElements([]);
      app.notifier(`Corbeille vidée (${r.effaces} élément${r.effaces > 1 ? "s" : ""})`);
    } catch (e) {
      app.notifier(`Impossible de vider la corbeille : ${(e as Error).message}`);
      charger();
    }
  };

  const ouvrirApercu = (el: ElementCorbeille) => {
    setApercu({ el, contenu: null });
    api.apercuCorbeille(el.id)
      .then((r) => setApercu((a) => (a && a.el.id === el.id ? { el, contenu: r.contenu } : a)))
      .catch((e) => setApercu((a) => (a && a.el.id === el.id ? { el, contenu: `Aperçu impossible : ${(e as Error).message}` } : a)));
  };

  const restants = (el: ElementCorbeille) => {
    if (!jours) return null;
    const j = Math.ceil((el.date + jours * JOUR - Date.now()) / JOUR);
    return j <= 7 ? (j <= 1 ? "effacée demain" : `effacée dans ${j} j`) : null;
  };

  return (
    <>
      <Entete fil={[{ titre: "Corbeille" }]} />
      <main className="feuille vue">
        <header className="vue-tete">
          <div className="vue-tete__ligne">
            <h1 className="vue-tete__titre">Corbeille</h1>
            {elements && elements.length > 0 && (
              <button type="button" className="bouton bouton--discret" onClick={() => void vider()}>Vider la corbeille</button>
            )}
          </div>
          <p className="vue-tete__texte">
            {jours ? `Les pages supprimées restent ici ${jours} jours, puis elles sont effacées.` : "Les pages supprimées restent ici jusqu'à ce que tu les effaces."}
            {" "}Restaurer remet la page à sa place, avec ses sous-pages.
          </p>
        </header>

        {erreur && <p className="etat-page">La corbeille ne répond pas : {erreur}</p>}
        {!elements && !erreur && (
          <div aria-busy="true" aria-label="Chargement">
            {[0, 1, 2].map((i) => <div key={i} className="squelette" style={{ height: 64 }} />)}
          </div>
        )}
        {elements && elements.length === 0 && (
          <div className="etat-vide">
            <span className="etat-vide__icone" aria-hidden="true"><Trash2 size={30} strokeWidth={1.5} /></span>
            <p className="etat-vide__titre">La corbeille est vide</p>
            <p className="etat-vide__texte">Quand tu supprimes une page, elle passe ici{jours ? ` ${jours} jours` : ""} : tu peux la restaurer d'un geste.</p>
          </div>
        )}
        {elements && elements.length > 0 && (
          <ul className="liste-corbeille">
            {elements.map((el) => {
              const r = restants(el);
              return (
                <li key={el.id} className="element-corbeille" data-occupe={el.existe ? "true" : undefined}>
                  <button type="button" className="element-corbeille__corps" onClick={() => ouvrirApercu(el)} aria-label={`Aperçu de ${el.titre}`}>
                    <span className="element-corbeille__icone"><IconePage icone={el.icone} taille={18} /></span>
                    <span className="element-corbeille__texte">
                      <span className="element-corbeille__titre">{el.titre}</span>
                      <span className="element-corbeille__meta">
                        {lieu(el.chemin)} · supprimée {ilYA(el.date)}
                        {el.sousPages > 0 && ` · ${el.sousPages} sous-page${el.sousPages > 1 ? "s" : ""}`}
                        {r && <span className="element-corbeille__delai"> · {r}</span>}
                      </span>
                    </span>
                  </button>
                  <span className="element-corbeille__actions">
                    <button type="button" className="bouton bouton--petit" disabled={enCours === el.id} onClick={() => void restaurer(el)}>
                      <RotateCcw size={16} /> Restaurer
                    </button>
                    <button type="button" className="bouton-icone" onClick={() => void effacer(el)}
                      aria-label={`Supprimer définitivement ${el.titre}`} title="Supprimer définitivement">
                      <Trash2 size={18} />
                    </button>
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </main>

      {apercu && (
        <Feuille titre={apercu.el.titre} onFermer={() => setApercu(null)}>
          <div className="dialogue__corps">
            <p className="apercu-corbeille__lieu">
              {lieu(apercu.el.chemin)} · supprimée {ilYA(apercu.el.date)}
              {apercu.el.existe && <><br />Une autre page porte maintenant ce nom : elle sera restaurée à côté, avec « (restaurée) ».</>}
            </p>
            {apercu.contenu === null ? (
              <div className="squelette" style={{ height: 120 }} />
            ) : (
              <pre className="apercu-texte">{texteLisible(apercu.contenu) || "Page vide."}</pre>
            )}
            <div className="boutons">
              <button type="button" className="bouton" onClick={() => void effacer(apercu.el)}>Supprimer définitivement</button>
              <button type="button" className="bouton bouton--primaire" onClick={() => void restaurer(apercu.el)} data-autofocus>Restaurer</button>
            </div>
          </div>
        </Feuille>
      )}
    </>
  );
}

/** Corps d'une page sans frontmatter, pour un aperçu en texte simple (rien n'est interprété). */
export function texteLisible(contenu: string): string {
  const d = decouper(contenu);
  return (d.blocTitre + d.corps).trim();
}
