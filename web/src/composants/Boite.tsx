// Lot 1 : boîte de réception. Les captures (une page par capture dans le dossier CARNET_INBOX, « Inbox/ » par défaut),
// les plus récentes d'abord : ouvrir, déplacer vers une page (les liens qui la désignent suivent), mettre à la corbeille
// (avec « Annuler »). Le lien d'une capture s'ouvre dans un nouvel onglet, sans être jamais récupéré par Carnet.
import { useCallback, useEffect, useState } from "react";
import { ExternalLink, FolderInput, Inbox, MoreHorizontal, Plus, Trash2, FileText } from "lucide-react";
import { api, type Capture } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { EtatVide } from "./EtatVide";
import { SqueletteListe } from "./Squelettes";
import { ilYA } from "../outils";
import { choisirRangement } from "../ranger-base"; // K10-01
import { nomDePage } from "../../../shared/page.ts";

function quand(c: Capture): string {
  const t = c.cree ? Date.parse(c.cree) : NaN;
  return ilYA(Number.isFinite(t) ? t : c.mtime);
}

function hote(url: string): string {
  try { return new URL(url).host.replace(/^www\./, ""); } catch { return url; }
}

export function Boite() {
  const app = useApp();
  const [l, setL] = useState<Capture[] | null>(null);
  const [dossier, setDossier] = useState(app.config?.inbox ?? "Inbox");
  const [erreur, setErreur] = useState<string | null>(null);

  const charger = useCallback(() => {
    api.boite().then((r) => { setL(r.captures); setDossier(r.dossier); setErreur(null); }).catch((e) => setErreur((e as Error).message));
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    const relancer = () => { if (m) window.clearTimeout(m); m = window.setTimeout(charger, 250); };
    const fin = ecouter((e) => { if (e.type === "arbre" || e.type === "modif" || (e.type === "connexion" && e.etat === "ouverte")) relancer(); });
    window.addEventListener("carnet:boite", relancer);
    return () => { fin(); window.removeEventListener("carnet:boite", relancer); if (m) window.clearTimeout(m); };
  }, [charger]);

  const deplacer = async (c: Capture) => {
    // K10-01 : « Ajouter à <base> » proposé (dossier des entrées), choix explicite si la cible porte une base
    const choix = await choisirRangement(app, c.chemin, c.titre, (x) => app.index.get(x)?.titre ?? nomDePage(x));
    if (choix === null) return;
    try {
      const m = await app.deplacerPage(c.chemin, choix.parent, choix.base);
      setL((x) => x?.filter((y) => y.chemin !== c.chemin) ?? null);
      if (m) app.notifier(m);
      window.dispatchEvent(new Event("carnet:boite"));
    } catch (e) {
      app.notifier(`Déplacement impossible : ${(e as Error).message}`);
    }
  };

  const supprimer = async (c: Capture) => {
    setL((x) => x?.filter((y) => y.chemin !== c.chemin) ?? null);
    await app.supprimerPage(c.chemin);
    window.dispatchEvent(new Event("carnet:boite"));
    charger();
  };

  const menu = async (c: Capture) => {
    const choix = await app.actions(c.titre, [
      { cle: "ouvrir", libelle: "Ouvrir", icone: <FileText size={18} /> },
      { cle: "deplacer", libelle: "Déplacer vers…", icone: <FolderInput size={18} /> },
      { cle: "corbeille", libelle: "Mettre à la corbeille", icone: <Trash2 size={18} />, danger: true },
    ]);
    if (choix === "ouvrir") naviguer({ vue: "page", chemin: c.chemin });
    if (choix === "deplacer") void deplacer(c);
    if (choix === "corbeille") void supprimer(c);
  };

  return (
    <>
      <Entete fil={[{ titre: "Boîte de réception" }]} />
      <main className="feuille boite">
        <h1 className="boite__titre">Boîte de réception</h1>
        <p className="boite__intro">Tes captures, à trier : ouvre-les, range-les dans une page ou jette-les. Dossier <code>{dossier}/</code>.</p>
        <button type="button" className="bouton bouton--primaire boite__capturer" onClick={app.capturer}><Plus size={18} /> Capturer</button>
        {erreur && <EtatVide compact titre="Impossible de lire la boîte" texte={erreur} actions={<button type="button" className="bouton" onClick={charger}>Réessayer</button>} />}
        {!l && !erreur && <SqueletteListe lignes={4} hauteur={64} />}
        {l && l.length === 0 && (
          <EtatVide icone={<Inbox size={26} />} titre="Ta boîte est vide" texte="Capture une idée ou un lien avec ＋ : tu les retrouveras ici." />
        )}
        {l && l.length > 0 && (
          <ul className="boite__liste" aria-label="Captures">
            {l.map((c) => (
              <li key={c.chemin} className="capture-ligne">
                <a className="capture-ligne__corps" href={urlDe({ vue: "page", chemin: c.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: c.chemin })}>
                  <span className="capture-ligne__haut">
                    <span className="capture-ligne__titre">{c.titre}</span>
                    <span className="capture-ligne__quand">{quand(c)}</span>
                  </span>
                  {c.extrait && c.extrait.trim() !== c.titre.trim() && <span className="capture-ligne__extrait">{c.extrait}</span>}
                </a>
                {c.source && /^https?:\/\//i.test(c.source) && (
                  <a className="capture-ligne__lien" href={c.source} target="_blank" rel="noopener noreferrer" title={c.source}>
                    <ExternalLink size={14} aria-hidden="true" />{hote(c.source)}
                  </a>
                )}
                <div className="capture-ligne__actions">
                  <button type="button" className="bouton-icone capture-ligne__action" aria-label={`Déplacer « ${c.titre} » vers une page`} onClick={() => void deplacer(c)} title="Déplacer vers…">
                    <FolderInput size={18} />
                  </button>
                  <button type="button" className="bouton-icone capture-ligne__action" aria-label={`Mettre « ${c.titre} » à la corbeille`} onClick={() => void supprimer(c)} title="Mettre à la corbeille">
                    <Trash2 size={18} />
                  </button>
                  <button type="button" className="bouton-icone capture-ligne__menu" aria-label={`Actions : ${c.titre}`} onClick={() => void menu(c)}>
                    <MoreHorizontal size={18} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </main>
    </>
  );
}
