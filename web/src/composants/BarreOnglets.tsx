// Lot 1 : barre d'onglets de l'iPhone (sous 900 px) : Aujourd'hui · Rechercher · ＋ (capturer) · Boîte · Pages.
// Sur ordinateur, la barre latérale suffit (Aujourd'hui, Boîte, Capturer ⌘⇧N). La barre s'efface quand on écrit
// (clavier ouvert) pour laisser la place à la barre au-dessus du clavier.
import { useEffect, useState } from "react";
import { Inbox, PanelLeft, Plus, Search, Sun } from "lucide-react";
import { useApp } from "../contexte-app";
import { naviguer, type Route } from "../navigation";

function enSaisie(): boolean {
  const a = document.activeElement as HTMLElement | null;
  if (!a) return false;
  if (a.isContentEditable) return true;
  if (a.tagName === "TEXTAREA") return true;
  if (a.tagName === "INPUT") return !["checkbox", "radio", "button", "submit"].includes((a as HTMLInputElement).type);
  return false;
}

export function BarreOnglets({ route, boite }: { route: Route; boite: number }) {
  const app = useApp();
  const [cachee, setCachee] = useState(false);
  useEffect(() => {
    const f = () => setCachee(enSaisie());
    const g = () => window.setTimeout(f, 0);
    document.addEventListener("focusin", f);
    document.addEventListener("focusout", g);
    return () => { document.removeEventListener("focusin", f); document.removeEventListener("focusout", g); };
  }, []);
  // Un champ retiré du document (feuille refermée) ne déclenche pas toujours « focusout » (WebKit) : tant que la barre
  // est masquée, on revérifie de temps en temps qu'une saisie est bien en cours.
  useEffect(() => {
    if (!cachee) return;
    const t = window.setInterval(() => { if (!enSaisie()) setCachee(false); }, 400);
    return () => window.clearInterval(t);
  }, [cachee]);
  const actif = (v: Route["vue"]) => (route.vue === v ? "page" : undefined);
  return (
    <nav className="onglets-bas" aria-label="Navigation principale" data-cachee={cachee ? "true" : undefined}>
      <button type="button" className="onglet" aria-current={actif("accueil")} onClick={() => naviguer({ vue: "accueil" })}>
        <Sun size={22} aria-hidden="true" /><span>Aujourd'hui</span>
      </button>
      <button type="button" className="onglet" onClick={app.ouvrirRecherche}>
        <Search size={22} aria-hidden="true" /><span>Rechercher</span>
      </button>
      <button type="button" className="onglet onglet--capturer" onClick={app.capturer} aria-label="Capturer">
        <span className="onglet__plus"><Plus size={26} aria-hidden="true" /></span>
      </button>
      <button type="button" className="onglet" aria-current={actif("boite")} onClick={() => naviguer({ vue: "boite" })}
        aria-label={boite ? `Boîte, ${boite} capture${boite > 1 ? "s" : ""}` : "Boîte"}>
        <span className="onglet__icone"><Inbox size={22} aria-hidden="true" />{boite > 0 && <span className="onglet__compteur" aria-hidden="true">{boite > 99 ? "99+" : boite}</span>}</span>
        <span>Boîte</span>
      </button>
      <button type="button" className="onglet" onClick={app.ouvrirTiroir}>
        <PanelLeft size={22} aria-hidden="true" /><span>Pages</span>
      </button>
    </nav>
  );
}
