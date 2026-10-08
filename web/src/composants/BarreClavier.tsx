// Barre d'outils au-dessus du clavier (iPhone) : fond opaque, tout accessible en 390 px.
// À gauche (défilante) : insérer, bloc, tâche, liste, titre, gras, italique, surligner, lien, retrait, monter, descendre.
// À droite (toujours visibles) : annuler, rétablir, fermer le clavier. Les boutons ne volent jamais le focus.
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  Plus, GripVertical, ListTodo, List, Heading, Bold, Italic, Highlighter, Link2, IndentIncrease, IndentDecrease,
  ArrowUp, ArrowDown, Undo2, Redo2, ChevronDown,
} from "lucide-react";
import type { EditeurCarnet } from "../editeur/creer";

export function BarreClavier({ ed, surAction }: { ed: EditeurCarnet; surAction: () => void }) {
  const [decalage, setDecalage] = useState(0);
  const [titres, setTitres] = useState(false);
  const [bord, setBord] = useState(true);
  const defile = useRef<HTMLDivElement>(null);
  // se redessine à chaque transaction (états actifs, annuler/rétablir)
  useSyncExternalStore(ed.magasin.abonner, () => ed.magasin.lire().rev, () => 0);
  const f = ed.etatFormat();

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let image = 0;
    const maj = () => {
      cancelAnimationFrame(image);
      image = requestAnimationFrame(() => {
        const bas = window.innerHeight - (vv.height + vv.offsetTop);
        setDecalage(-Math.max(0, Math.round(bas)));
      });
    };
    maj();
    vv.addEventListener("resize", maj);
    vv.addEventListener("scroll", maj);
    return () => { cancelAnimationFrame(image); vv.removeEventListener("resize", maj); vv.removeEventListener("scroll", maj); };
  }, []);

  const surDefilement = () => {
    const d = defile.current;
    if (d) setBord(d.scrollLeft + d.clientWidth < d.scrollWidth - 4);
  };
  useEffect(surDefilement, []);

  const agir = (fn: () => void) => (e: React.PointerEvent) => {
    e.preventDefault(); // garder le focus (et le clavier) dans l'éditeur
    surAction();
    fn();
  };
  const o = ed.outils;
  const dansListe = f.liste || f.tache;

  return (
    // mousedown annulé sur toute la barre : aucun bouton ne prend le focus (le clavier reste ouvert), dans tous les moteurs
    <div className="carnet-barre-clavier" style={{ ["--decalage-clavier" as string]: `${decalage}px` }} role="toolbar" aria-label="Mise en forme"
      onMouseDown={(e) => e.preventDefault()}>
      {titres && (
        <div className="carnet-barre-clavier__titres" role="menu" aria-label="Type de texte">
          {([[0, "Texte"], [1, "Titre 1"], [2, "Titre 2"], [3, "Titre 3"]] as const).map(([n, nom]) => (
            <button key={n} type="button" role="menuitemradio" aria-checked={f.titre === n} data-actif={f.titre === n}
              onPointerDown={agir(() => { o.titre(n); setTitres(false); })}>{nom}</button>
          ))}
        </div>
      )}
      <div className="carnet-barre-clavier__defile" ref={defile} onScroll={surDefilement} data-bord={bord}>
        <button type="button" tabIndex={-1} data-principal="true" onPointerDown={agir(o.inserer)} aria-label="Insérer un bloc">
          <Plus size={20} /> <span>Insérer</span>
        </button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.menuBloc)} aria-label="Actions du bloc"><GripVertical size={20} /></button>
        <span className="carnet-barre-clavier__sep" />
        <button type="button" tabIndex={-1} onPointerDown={agir(o.caseACocher)} aria-label="Tâche" data-actif={f.tache}><ListTodo size={21} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.liste)} aria-label="Liste à puces" data-actif={f.liste}><List size={21} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(() => setTitres((t) => !t))} aria-label="Titre" aria-expanded={titres} data-actif={f.titre > 0}>
          <Heading size={20} />
        </button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.gras)} aria-label="Gras" data-actif={f.gras}><Bold size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.italique)} aria-label="Italique" data-actif={f.italique}><Italic size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.surligner)} aria-label="Surligner" data-actif={f.surligne}><Highlighter size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.lien)} aria-label="Lien" data-actif={f.lien}><Link2 size={20} /></button>
        {dansListe && <button type="button" tabIndex={-1} onPointerDown={agir(o.retrait)} aria-label="Augmenter le retrait"><IndentIncrease size={20} /></button>}
        {dansListe && <button type="button" tabIndex={-1} onPointerDown={agir(o.desindenter)} aria-label="Diminuer le retrait"><IndentDecrease size={20} /></button>}
        <button type="button" tabIndex={-1} onPointerDown={agir(o.monter)} aria-label="Monter le bloc"><ArrowUp size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.descendre)} aria-label="Descendre le bloc"><ArrowDown size={20} /></button>
      </div>
      <div className="carnet-barre-clavier__fixe">
        <button type="button" tabIndex={-1} onPointerDown={agir(o.annuler)} aria-label="Annuler" disabled={!f.peutAnnuler}><Undo2 size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={agir(o.retablir)} aria-label="Rétablir" disabled={!f.peutRetablir}><Redo2 size={20} /></button>
        <button type="button" tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); ed.vueOuNull()?.dom.blur(); (document.activeElement as HTMLElement | null)?.blur?.(); }} aria-label="Fermer le clavier">
          <ChevronDown size={22} />
        </button>
      </div>
    </div>
  );
}
