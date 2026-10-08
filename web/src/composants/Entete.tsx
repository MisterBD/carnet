// En-tête collant : menu (iPhone), retour (iPhone), fil d'Ariane cliquable, état d'enregistrement (la vague), actions.
// Sur iPhone le fil se résume au parent (« Projets › ») et le titre de la page n'y apparaît qu'une fois le grand titre
// sorti de l'écran ; le bouton retour revient à l'écran précédent de Carnet, ou au parent s'il n'y en a pas
// (appli lancée depuis l'écran d'accueil : Safari n'a alors aucun bouton retour).
import { useEffect, useState, type ReactNode } from "react";
import { ChevronLeft, Menu } from "lucide-react";
import { useApp } from "../contexte-app";
import { lireRoute, naviguer, peutRevenir, surLienInterne, urlDe, type Route } from "../navigation";
import { Vague } from "./Icone";

export interface MaillonFil { titre: string; route?: Route }

export type EtatEnregistrement = "repos" | "modifie" | "enregistrement" | "enregistre" | "hors-ligne" | "erreur" | "conflit";

const TEXTES: Record<EtatEnregistrement, string> = {
  repos: "",
  modifie: "Modifié",
  enregistrement: "Enregistrement…",
  enregistre: "Enregistré",
  "hors-ligne": "Hors ligne, nouvel essai…",
  erreur: "Pas enregistré",
  conflit: "Modifiée ailleurs",
};

/** Au-delà de ce défilement, le grand titre est sorti de l'écran : le fil montre le titre courant (iPhone). */
const SEUIL_TITRE = 96;

export function Entete({ fil, etat, actions }: { fil: MaillonFil[]; etat?: EtatEnregistrement; actions?: ReactNode }) {
  const app = useApp();
  const [defile, setDefile] = useState(false);
  const [titreVisible, setTitreVisible] = useState(false);
  useEffect(() => {
    const f = () => { setDefile(window.scrollY > 4); setTitreVisible(window.scrollY > SEUIL_TITRE); };
    f();
    window.addEventListener("scroll", f, { passive: true });
    return () => window.removeEventListener("scroll", f);
  }, []);
  const parent = [...fil].reverse().find((m, i) => i > 0 && m.route) ?? null;
  const retour = () => {
    if (peutRevenir()) history.back();
    else naviguer(parent?.route ?? { vue: "accueil" });
  };
  // Retour sur les pages, fichiers et historiques ; pas sur les écrans racine (accueil, projets, corbeille).
  const vue = lireRoute().vue;
  const racine = vue !== "page" && vue !== "fichier" && vue !== "historique";
  return (
    <header className="entete" data-defile={defile} data-titre-visible={titreVisible ? "true" : undefined}>
      <button type="button" className="bouton-icone entete__menu" onClick={app.ouvrirTiroir} aria-label="Ouvrir la liste des pages">
        <Menu size={22} />
      </button>
      {!racine && (
        <button type="button" className="bouton-icone entete__retour" onClick={retour}
          aria-label={peutRevenir() ? "Revenir à l'écran précédent" : `Remonter à ${parent?.titre ?? "l'accueil"}`}>
          <ChevronLeft size={24} />
        </button>
      )}
      <nav className="fil" aria-label="Fil d'Ariane">
        {fil.map((m, i) => {
          const dernier = i === fil.length - 1;
          return (
            <span key={i} className="fil__maillon" data-dernier={dernier ? "true" : undefined} data-parent={m === parent ? "true" : undefined}>
              {i > 0 && <span className="fil__sep" aria-hidden="true">/</span>}
              {dernier || !m.route ? (
                <span className="fil__courant" aria-current={dernier ? "page" : undefined} title={m.titre}>{m.titre}</span>
              ) : (
                <a className="fil__ancetre" href={urlDe(m.route)} title={m.titre} onClick={(e) => surLienInterne(e, m.route!)}>{m.titre}</a>
              )}
            </span>
          );
        })}
      </nav>
      {etat && etat !== "repos" && (
        <span className="vague-etat" data-etat={etat} role="status" aria-live="polite" title={TEXTES[etat]}>
          <Vague />
          <span className="vague-etat__texte">{TEXTES[etat]}</span>
        </span>
      )}
      {actions}
    </header>
  );
}
