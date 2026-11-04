// « Sur cette page » (lot 4) : sommaire des titres d'une longue page (au moins 3 titres de niveau 1 à 3), qui suit le
// défilement. Grand écran : panneau discret à droite du texte. iPhone et écran plus étroit : bouton dans l'en-tête,
// qui ouvre la liste en feuille. Rien n'est écrit dans le fichier : c'est une vue de l'éditeur.
import { useCallback, useEffect, useState } from "react";
import { TableOfContents } from "lucide-react";
import type { EditeurCarnet } from "../editeur/creer";
import { Feuille } from "./Feuille";
import { defilerVersTitre } from "../ancres";
import "../styles/corrections.css";

export interface TitrePage { niveau: number; texte: string; pos: number }

/** Seuil d'affichage : en dessous, la page est assez courte pour se lire d'un coup d'œil. */
export const MIN_TITRES = 3;

function lireTitres(ed: EditeurCarnet): TitrePage[] {
  const vue = ed.vueOuNull();
  if (!vue) return [];
  const res: TitrePage[] = [];
  vue.state.doc.descendants((n, pos) => {
    if (n.type.name === "heading" && n.attrs.level <= 3 && n.textContent.trim()) res.push({ niveau: n.attrs.level, texte: n.textContent.trim(), pos });
    return n.type.name !== "codeBlock";
  });
  return res;
}

/** Titres de la page, tenus à jour (au plus toutes les 200 ms) pendant la saisie et les mises à jour en direct. */
function useTitres(ed: EditeurCarnet | null): TitrePage[] {
  const [titres, setTitres] = useState<TitrePage[]>([]);
  useEffect(() => {
    if (!ed) { setTitres([]); return; }
    let doc: unknown = null;
    let m: number | null = null;
    const lire = () => {
      m = null;
      const vue = ed.vueOuNull();
      if (!vue || vue.state.doc === doc) return;
      doc = vue.state.doc;
      const t = lireTitres(ed);
      setTitres((avant) => (JSON.stringify(avant) === JSON.stringify(t) ? avant : t));
    };
    lire();
    const f = () => { if (m === null) m = window.setTimeout(lire, 200); };
    ed.tiptap.on("transaction", f);
    return () => { ed.tiptap.off("transaction", f); if (m !== null) window.clearTimeout(m); };
  }, [ed]);
  return titres;
}

/** Index du titre en cours de lecture : le dernier passé sous l'en-tête collant. */
function useTitreCourant(ed: EditeurCarnet | null, titres: TitrePage[]): number {
  const [courant, setCourant] = useState(-1);
  useEffect(() => {
    if (!ed || titres.length < MIN_TITRES) return;
    let raf = 0;
    const calculer = () => {
      raf = 0;
      const vue = ed.vueOuNull();
      if (!vue) return;
      const seuil = 120;
      let k = -1;
      for (let i = 0; i < titres.length; i++) {
        const dom = vue.nodeDOM(titres[i].pos);
        if (!(dom instanceof HTMLElement)) continue;
        if (dom.getBoundingClientRect().top <= seuil) k = i; else break;
      }
      // tout en bas de la page : le dernier titre est le courant
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) k = titres.length - 1;
      setCourant(k);
    };
    const f = () => { if (!raf) raf = requestAnimationFrame(calculer); };
    calculer();
    window.addEventListener("scroll", f, { passive: true });
    window.addEventListener("resize", f);
    return () => { window.removeEventListener("scroll", f); window.removeEventListener("resize", f); if (raf) cancelAnimationFrame(raf); };
  }, [ed, titres]);
  return courant;
}

function ancreDe(t: TitrePage): string {
  return "#" + encodeURIComponent(t.texte);
}

function Liste({ ed, titres, courant, apres }: { ed: EditeurCarnet; titres: TitrePage[]; courant: number; apres?: () => void }) {
  const min = Math.min(...titres.map((t) => t.niveau));
  const aller = useCallback((t: TitrePage) => {
    const dom = ed.vueOuNull()?.nodeDOM(t.pos);
    apres?.();
    if (!(dom instanceof HTMLElement)) return;
    // l'adresse garde la section (lien à copier), sans nouvelle entrée d'historique
    try { history.replaceState(history.state, "", location.pathname + ancreDe(t)); } catch { /* bac à sable */ }
    // laisse la feuille se fermer avant de défiler (iPhone)
    window.setTimeout(() => defilerVersTitre(dom, true), apres ? 60 : 0);
  }, [ed, apres]);
  return (
    <ol className="sur-cette-page__liste">
      {titres.map((t, i) => (
        <li key={`${t.pos}-${t.texte}`} data-niveau={t.niveau - min + 1}>
          <a href={ancreDe(t)} aria-current={i === courant ? "location" : undefined}
            onClick={(e) => { e.preventDefault(); aller(t); }}>{t.texte}</a>
        </li>
      ))}
    </ol>
  );
}

/** Panneau flottant (grand écran, masqué par le CSS sinon). */
function Panneau({ ed }: { ed: EditeurCarnet | null }) {
  const titres = useTitres(ed);
  const courant = useTitreCourant(ed, titres);
  if (!ed || titres.length < MIN_TITRES) return null;
  return (
    <nav className="sur-cette-page" aria-label="Sur cette page">
      <p className="sur-cette-page__titre">Sur cette page</p>
      <Liste ed={ed} titres={titres} courant={courant} />
    </nav>
  );
}

/** Bouton de l'en-tête (iPhone et écrans où le panneau n'a pas la place), qui ouvre la liste en feuille. */
function Bouton({ ed }: { ed: EditeurCarnet | null }) {
  const titres = useTitres(ed);
  const courant = useTitreCourant(ed, titres);
  const [ouvert, setOuvert] = useState(false);
  const fermer = useCallback(() => setOuvert(false), []);
  if (!ed || titres.length < MIN_TITRES) return null;
  return (
    <>
      <button type="button" className="bouton-icone sur-cette-page__bouton" onClick={() => setOuvert(true)}
        aria-label="Sur cette page" title="Sur cette page" aria-haspopup="dialog">
        <TableOfContents size={20} />
      </button>
      {ouvert && (
        <Feuille titre="Sur cette page" onFermer={fermer}>
          <nav className="sur-cette-page sur-cette-page--feuille" aria-label="Sur cette page">
            <Liste ed={ed} titres={titres} courant={courant} apres={fermer} />
          </nav>
        </Feuille>
      )}
    </>
  );
}

export const SurCettePage = { Panneau, Bouton };
