// Lot 3 « Agents » : sous le titre d'une page, le bandeau « Modifiée depuis ta dernière lecture » (comparaison
// textuelle, « Marquer comme vu ») et, pour une page `type: decision`, la barre de décision (chargée à la demande).
// Branché dans PageVue.tsx par une seule ligne.
import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { Check, Eye, EyeOff, Sparkles } from "lucide-react";
import { apiAgents, type DetailNouveaute } from "../api";
import { useApp, type App } from "../contexte-app";
import { ecouter } from "../evenements";
import { lireChampSimple, nomDePage } from "../../../shared/page.ts";
import "../styles/agents.css";

const BarreDecision = lazy(() => import("./BarreDecision"));
export const Differences = lazy(() => import("./Historique").then((m) => ({ default: m.VueDifferences })));

const fmtQuand = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** « 10 oct. à 22:30 » (l'année si ce n'est pas l'année en cours) pour un horodatage ISO ; "" si illisible. */
export function quand(iso: string | null | undefined): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "";
  const p = Object.fromEntries(fmtQuand.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const annee = p.year && Number(p.year) !== new Date().getFullYear() ? ` ${p.year}` : "";
  return `${p.day} ${p.month}${annee} à ${p.hour}:${p.minute}`;
}

/** Texte de l'auteur d'une version : jamais « un agent » sans preuve. */
export function texteAuteur(auteur: string | undefined | null): string {
  if (!auteur || auteur === "non vérifié") return "modification externe, auteur non vérifié";
  return `écrite par Carnet sous l'identité ${auteur} (ne prouve pas qui a écrit)`;
}

/** Déclaration `maj_par` / `maj_motif` du fichier, affichée comme telle. */
export function texteDeclaration(par: string | null | undefined, motif: string | null | undefined): string {
  if (!par && !motif) return "";
  return `le fichier déclare : ${par ?? "?"}${motif ? ` (« ${motif} »)` : ""}, non vérifié`;
}

export function BandeauxAgents({ chemin, yaml }: { chemin: string; yaml: string }) {
  const decision = lireChampSimple(yaml, "type") === "decision";
  return (
    <>
      <BandeauNouveaute chemin={chemin} />
      {decision && (
        <Suspense fallback={<div className="squelette" style={{ height: 132, marginTop: 6 }} />}>
          <BarreDecision chemin={chemin} />
        </Suspense>
      )}
    </>
  );
}

function BandeauNouveaute({ chemin }: { chemin: string }) {
  const app = useApp();
  const [d, setD] = useState<DetailNouveaute | null>(null);
  const [voir, setVoir] = useState(false);
  const [occupe, setOccupe] = useState(false);
  const charger = useCallback(() => {
    apiAgents.nouveaute(chemin).then(setD).catch(() => setD(null));
  }, [chemin]);
  useEffect(() => { setVoir(false); charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    let enAttente = false;
    // Pendant la saisie, le bandeau ne bouge pas (pas de saut de mise en page sous les doigts) : on relit après.
    const enSaisie = () => !!(document.activeElement as HTMLElement | null)?.closest?.(".editeur, .carnet-barre-clavier, .carnet-interface");
    const relancer = () => {
      if (m) window.clearTimeout(m);
      m = window.setTimeout(() => { if (enSaisie()) { enAttente = true; return; } charger(); }, 350);
    };
    const finSaisie = () => window.setTimeout(() => { if (enAttente && !enSaisie()) { enAttente = false; charger(); } }, 200);
    const fin = ecouter((e) => { if ((e.type === "modif" && e.chemin === chemin) || e.type === "arbre") relancer(); });
    window.addEventListener("carnet:vu", relancer);
    document.addEventListener("focusout", finSaisie);
    return () => { fin(); if (m) window.clearTimeout(m); window.removeEventListener("carnet:vu", relancer); document.removeEventListener("focusout", finSaisie); };
  }, [chemin, charger]);

  if (!d || d.etat === "a-jour" || d.etat === "inconnue" || d.etat === "supprimee" || !d.actuel) return null;
  const actuel = d.actuel;

  const marquer = async () => {
    setOccupe(true);
    try {
      const renommee = d.etat === "renommee";
      const r = await apiAgents.marquerVu([{ chemin: renommee ? d.chemin! : chemin, vers: renommee ? chemin : null, etag: actuel.etag, contenu: actuel.contenu }]);
      if (r.marquees.includes(chemin)) {
        setD({ ...d, etat: "a-jour" });
        app.notifier("Marquée comme vue");
      } else {
        app.notifier("La page a encore changé : la nouvelle version reste à lire.");
        charger();
      }
      window.dispatchEvent(new Event("carnet:vu"));
    } catch (e) {
      app.notifier(`Impossible de marquer comme vu : ${(e as Error).message}`);
    } finally {
      setOccupe(false);
    }
  };

  const titre = d.etat === "nouvelle" ? "Nouvelle depuis ta dernière lecture"
    : d.etat === "renommee" ? (d.modifiee ? "Renommée et modifiée depuis ta dernière lecture" : "Renommée depuis ta dernière lecture")
    : "Modifiée depuis ta dernière lecture";
  const details = [
    d.etat === "renommee" && d.chemin ? `avant : ${d.chemin.replace(/\.md$/, "")}` : "",
    texteAuteur(d.auteur),
    texteDeclaration(d.maj_par_declare, d.motif_declare),
    d.vu?.t ? `vue le ${quand(d.vu.t)}` : "",
  ].filter(Boolean);
  const comparable = d.vu && (d.etat === "modifiee" || d.modifiee);

  return (
    <div className="bandeau-nouveaute" role="status" data-etat={d.etat}>
      <div className="bandeau-nouveaute__ligne">
        <span className="bandeau-nouveaute__icone" aria-hidden="true"><Sparkles size={18} /></span>
        <div className="bandeau-nouveaute__texte">
          <strong>{titre}</strong>
          <span>{details.join(" · ")}</span>
        </div>
      </div>
      <div className="bandeau-nouveaute__actions">
        {comparable && (
          <button type="button" className="bouton bouton--petit" aria-expanded={voir} onClick={() => setVoir((x) => !x)}>
            {voir ? <EyeOff size={16} /> : <Eye size={16} />} {voir ? "Masquer" : "Comparer"}
          </button>
        )}
        <button type="button" className="bouton bouton--petit bouton--primaire" disabled={occupe} onClick={() => void marquer()}>
          <Check size={16} /> Marquer comme vu
        </button>
      </div>
      {voir && comparable && (
        <div className="bandeau-nouveaute__diff">
          {d.vu?.contenu == null ? (
            <p className="bandeau-nouveaute__indispo">Comparaison indisponible : la copie de la version vue n'a pas été retrouvée.</p>
          ) : (
            <Suspense fallback={<div className="squelette" style={{ height: 80 }} />}>
              <Differences avant={d.vu.contenu} apres={actuel.contenu} />
            </Suspense>
          )}
        </div>
      )}
    </div>
  );
}

/** « / » → Demande de décision : titre demandé, demande créée sous la page (modèle), nom de page renvoyé. */
export async function creerDemandeDecision(app: App, parent: string): Promise<string | null> {
  const titre = await app.demanderTexte({
    titre: "Nouvelle demande de décision", placeholder: "Ce qu'il faut décider", bouton: "Créer la demande",
    texte: "Elle sera créée sous cette page, avec une section « Proposition » à compléter (seul ce qui y est écrit sera décidé).",
  });
  if (!titre) return null;
  try {
    const r = await apiAgents.creerDecision(titre, parent);
    app.deplier(parent);
    await app.rechargerArbre();
    return nomDePage(r.chemin);
  } catch (e) {
    app.notifier(`Demande non créée : ${(e as Error).message}`);
    return null;
  }
}
