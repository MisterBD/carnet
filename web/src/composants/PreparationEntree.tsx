// Dossier de rendez-vous (lot 11) : points d'entrée légers, chargés avec la page.
//   - <EntreePreparation> en tête d'une page (UNE ligne dans PageVue) : bouton « Préparer » si la page a `sources`,
//     état « À rafraîchir » si c'est une préparation conservée (`type: preparation`) ;
//   - elementMenuPreparer(chemin) : entrée du menu « … » (UNE ligne dans actions-pages.tsx) ;
//   - <VuePreparation> : l'écran d'aperçu, chargé à la demande (UNE ligne dans App.tsx).
// Le reste (écran, styles) vit dans Preparation.tsx et styles/preparation.css.
import { lazy, Suspense, useEffect, useState } from "react";
import { ClipboardList, RefreshCw } from "lucide-react";
import { api, type EtatPreparation } from "../api";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe, type Route } from "../navigation";
import type { ElementMenu } from "./MenuPage";
import { lireChampSimple, plier } from "../../../shared/page.ts";
import { useApp } from "../contexte-app";
import "../styles/preparation.css";

const Preparation = lazy(() => import("./Preparation").then((m) => ({ default: m.Preparation })));

/** Le frontmatter déclare-t-il `sources` (liste en bloc, liste en ligne ou valeur seule) ? */
export function aDesSources(yaml: string): boolean {
  return /^sources[ \t]*:/m.test(yaml);
}

export function estPreparation(yaml: string): boolean {
  const t = lireChampSimple(yaml, "type");
  return t !== undefined && plier(t).trim() === "preparation";
}

/** Fiches ouvertes dont le frontmatter a `sources` : le menu « … » (synchrone) s'en sert pour proposer « Préparer ». */
const fiches = new Set<string>();

export function elementMenuPreparer(chemin: string): ElementMenu | null {
  if (!fiches.has(chemin)) return null;
  return {
    cle: "preparer", libelle: "Préparer un dossier de rendez-vous", icone: <ClipboardList size={18} />,
    faire: () => naviguer({ vue: "preparation", chemin }),
  };
}

export function VuePreparation({ route }: { route: Route }) {
  if (route.vue !== "preparation") return null;
  return (
    <Suspense fallback={<main className="feuille" aria-busy="true"><div className="squelette" style={{ width: "50%", height: 34, marginTop: 30 }} /></main>}>
      <Preparation key={route.chemin} chemin={route.chemin} />
    </Suspense>
  );
}

export function EntreePreparation({ chemin, yaml }: { chemin: string; yaml: string }) {
  const sources = aDesSources(yaml);
  const prep = estPreparation(yaml);
  useEffect(() => {
    if (!sources) return;
    fiches.add(chemin);
    return () => { fiches.delete(chemin); };
  }, [chemin, sources]);
  if (prep) return <EtatConservee chemin={chemin} />;
  if (!sources) return null;
  const route: Route = { vue: "preparation", chemin };
  return (
    <div className="prep-entree">
      <a className="prep-entree__bouton" href={urlDe(route)} onClick={(e) => surLienInterne(e, route)}>
        <ClipboardList size={17} aria-hidden="true" />
        <span>Préparer</span>
      </a>
      <span className="prep-entree__aide">Dossier de rendez-vous assemblé depuis les sources de cette page</span>
    </div>
  );
}

/** Préparation conservée : « À rafraîchir » si ses sources ont changé (calculé par le serveur, jamais écrit). */
function fuseauValide(f: string | undefined): string | undefined {
  if (!f) return undefined;
  try { new Intl.DateTimeFormat("fr-FR", { timeZone: f }); return f; } catch { return undefined; }
}

function EtatConservee({ chemin }: { chemin: string }) {
  const fuseau = useApp().config?.fuseau;
  const [etat, setEtat] = useState<EtatPreparation | null>(null);
  useEffect(() => {
    let vivant = true;
    let minuterie: number | null = null;
    const charger = () => { api.etatPreparation(chemin).then((e) => { if (vivant) setEtat(e); }).catch(() => {}); };
    charger();
    // une source modifiée (agent, Obsidian, Carnet) : l'état est recalculé
    const fin = ecouter((ev) => {
      if (ev.type !== "modif" && ev.type !== "arbre" && !(ev.type === "connexion" && ev.etat === "ouverte")) return;
      if (minuterie) window.clearTimeout(minuterie);
      minuterie = window.setTimeout(charger, 400);
    });
    return () => { vivant = false; fin(); if (minuterie) window.clearTimeout(minuterie); };
  }, [chemin]);
  if (!etat) return null;
  // K10-03 : la date de la photographie, avant l'état de fraîcheur (le titre « Préparation — … » est juste au-dessus)
  // dans le fuseau du carnet (celui du résumé écrit dans le fichier), pas celui du navigateur
  const d = etat.cree ? new Date(etat.cree) : null;
  const tz = fuseauValide(fuseau);
  const quand = d && !Number.isNaN(d.getTime())
    ? `${d.toLocaleDateString("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: tz })} à ${d.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", timeZone: tz }).replace(":", " h ")}`
    : null;
  const date = quand ? <p className="prep-date">Préparée le {quand}</p> : null;
  const fiche = etat.fiche && etat.ficheExiste ? etat.fiche : null;
  const regenerer = fiche ? () => naviguer({ vue: "preparation", chemin: fiche }) : undefined;
  if (!etat.aRafraichir) {
    return (
      <>
        {date}
        <p className="prep-etat" data-etat="a-jour" role="status">
          À jour : aucune source n'a changé depuis cette préparation.
        </p>
      </>
    );
  }
  const n = etat.changements.length;
  const libelles: Record<string, string> = { modifiee: "modifiée", disparue: "supprimée", retiree: "n'est plus une source", nouvelle: "nouvelle source" };
  return (
    <>
    {date}
    <div className="prep-etat" data-etat="a-rafraichir" role="status">
      <p className="prep-etat__titre"><strong>À rafraîchir</strong> · {n > 1 ? `${n} sources ont changé` : "une source a changé"} depuis cette préparation</p>
      <ul className="prep-etat__liste">
        {etat.changements.slice(0, 5).map((c) => (
          <li key={c.chemin}>
            {c.etat === "disparue" ? <span>{c.titre}</span> : (
              <a href={urlDe({ vue: "page", chemin: c.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: c.chemin })}>{c.titre}</a>
            )} : {libelles[c.etat]}
          </li>
        ))}
        {n > 5 && <li>et {n - 5} autres</li>}
      </ul>
      {regenerer && (
        <>
          <p className="prep-etat__note">Actualiser ouvre un aperçu à jour ; le conserver crée une nouvelle version. Celle-ci reste telle quelle.</p>
          <button type="button" className="prep-etat__bouton" onClick={regenerer}>
            <RefreshCw size={16} aria-hidden="true" /> Actualiser la préparation
          </button>
        </>
      )}
      {!fiche && <p className="prep-etat__note">La fiche d'origine n'existe plus : impossible de régénérer.</p>}
    </div>
    </>
  );
}
