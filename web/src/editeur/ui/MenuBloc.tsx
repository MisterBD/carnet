// Menu d'un bloc (poignée ⋮⋮ sur ordinateur, appui long ou bouton « Bloc » sur iPhone) :
// transformer en, couleur du texte et du fond, dupliquer, monter, descendre, supprimer.
import { useEffect, useRef, useState } from "react";
import { ArrowDown, ArrowUp, ChevronLeft, ChevronRight, CopyPlus, Palette as IcPalette, Repeat2, Trash2, X } from "lucide-react";
import type { Magasin } from "./magasin";
import { useMagasin, ICONES, Palette, garderFocus, sansFocus } from "./communs";
import { usePosition } from "./position";
import { colorer, deplacer, dupliquer, nomDuBloc, supprimer, transformer, type Cible } from "../blocs";
import type { Icone } from "../menu";

const CIBLES: Array<[Cible, string, Icone]> = [
  ["texte", "Texte", "texte"], ["h1", "Titre 1", "h1"], ["h2", "Titre 2", "h2"], ["h3", "Titre 3", "h3"],
  ["puces", "Liste à puces", "puces"], ["numeros", "Liste numérotée", "numeros"], ["tache", "Tâche", "tache"],
  ["citation", "Citation", "citation"], ["encadre", "Encadré", "NOTE"], ["repliable", "Repliable", "repliable"], ["code", "Code", "code"],
];

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = mac ? "⌘" : "Ctrl+";

export function MenuBloc({ magasin }: { magasin: Magasin }) {
  const { menuBloc } = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const [vue, setVue] = useState<"principal" | "transformer" | "couleur">("principal");
  const feuille = Boolean(menuBloc?.feuille);
  const pos = usePosition(ref, !feuille && menuBloc ? menuBloc.ancre : null, "bottom-start", 6, vue);
  const ed = magasin.editeur;
  // Garde anti « clic fantôme » : sur iPhone, le clic qui suit l'appui sur le bouton « Bloc » de la barre
  // retombe sur la feuille qui vient de s'ouvrir. On ignore les clics des 350 premières ms.
  const ouvertA = useRef(0);

  useEffect(() => { setVue(menuBloc?.vue ?? "principal"); ouvertA.current = Date.now(); }, [menuBloc?.pos, menuBloc?.vue, menuBloc]);
  // le bloc visé reste repéré à l'écran tant que son menu est ouvert
  useEffect(() => {
    if (!menuBloc || !ed) return;
    const dom = ed.view.nodeDOM(menuBloc.pos) as HTMLElement | null;
    if (!(dom instanceof HTMLElement)) return;
    dom.classList.add("carnet-bloc-cible");
    return () => dom.classList.remove("carnet-bloc-cible");
  }, [menuBloc, ed]);

  useEffect(() => {
    if (!menuBloc) return;
    const fermer = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) magasin.maj({ menuBloc: null });
    };
    const echap = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); magasin.maj({ menuBloc: null }); ed?.commands.focus(); } };
    window.addEventListener("pointerdown", fermer, true);
    window.addEventListener("keydown", echap, true);
    return () => { window.removeEventListener("pointerdown", fermer, true); window.removeEventListener("keydown", echap, true); };
  }, [menuBloc, magasin, ed]);

  if (!menuBloc || !ed) return null;
  const noeud = ed.state.doc.nodeAt(menuBloc.pos);
  if (!noeud) return null;
  const pret = () => !feuille || Date.now() - ouvertA.current > 350;
  const fermer = () => { if (pret()) magasin.maj({ menuBloc: null }); };
  const agir = (f: () => void) => () => {
    if (!pret()) return;
    f();
    magasin.maj({ menuBloc: null });
    if (!ed.isDestroyed) ed.view.focus();
  };
  const vers = (v: "principal" | "transformer" | "couleur") => () => { if (pret()) setVue(v); };

  // couleurs actuelles (première marque trouvée dans le bloc)
  let texte: string | null = null;
  let fond: string | null = null;
  noeud.descendants((n) => {
    for (const m of n.marks) {
      if (m.type.name === "couleurTexte" && texte == null) texte = m.attrs.c;
      if (m.type.name === "couleurFond" && fond == null) fond = m.attrs.c;
    }
    return true;
  });
  const aDuTexte = noeud.isTextblock || noeud.type.name === "listItem" || noeud.content.size > 0 && noeud.type.name !== "codeBlock" && noeud.type.name !== "table";
  const transformable = !["imageBloc", "artefact", "horizontalRule", "sommaire", "table", "blocBrut"].includes(noeud.type.name);

  const corps = (
    <>
      {vue === "principal" && (
        <div className="carnet-menu__defile">
          <div className="carnet-menu__titre-bloc">{nomDuBloc(noeud)}</div>
          {transformable && (
            <button type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={vers("transformer")}>
              <span className="carnet-menu__icone"><Repeat2 size={18} /></span><span className="carnet-menu__libelle">Transformer en</span>
              <ChevronRight size={16} className="carnet-menu__chevron" />
            </button>
          )}
          {aDuTexte && (
            <button type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={vers("couleur")}>
              <span className="carnet-menu__icone"><IcPalette size={18} /></span><span className="carnet-menu__libelle">Couleur</span>
              <ChevronRight size={16} className="carnet-menu__chevron" />
            </button>
          )}
          <div className="carnet-menu__sep" />
          <button type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={agir(() => dupliquer(ed, menuBloc.pos))}>
            <span className="carnet-menu__icone"><CopyPlus size={18} /></span><span className="carnet-menu__libelle">Dupliquer</span>
            <kbd className="carnet-menu__md">{mod}D</kbd>
          </button>
          <button type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={agir(() => deplacer(ed, menuBloc.pos, -1))}>
            <span className="carnet-menu__icone"><ArrowUp size={18} /></span><span className="carnet-menu__libelle">Monter</span>
            <kbd className="carnet-menu__md">{mod}⇧↑</kbd>
          </button>
          <button type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={agir(() => deplacer(ed, menuBloc.pos, 1))}>
            <span className="carnet-menu__icone"><ArrowDown size={18} /></span><span className="carnet-menu__libelle">Descendre</span>
            <kbd className="carnet-menu__md">{mod}⇧↓</kbd>
          </button>
          <div className="carnet-menu__sep" />
          <button type="button" className="carnet-menu__entree carnet-menu__entree--danger" onPointerDown={garderFocus} onClick={agir(() => supprimer(ed, menuBloc.pos))}>
            <span className="carnet-menu__icone"><Trash2 size={18} /></span><span className="carnet-menu__libelle">Supprimer</span>
          </button>
        </div>
      )}
      {vue === "transformer" && (
        <div className="carnet-menu__defile">
          <button type="button" className="carnet-menu__retour" onPointerDown={garderFocus} onClick={vers("principal")}>
            <ChevronLeft size={16} /> Transformer en
          </button>
          {CIBLES.map(([c, nom, icone]) => {
            const Ic = ICONES[icone];
            return (
              <button key={c} type="button" className="carnet-menu__entree" onPointerDown={garderFocus} onClick={agir(() => transformer(ed, menuBloc.pos, c))}>
                <span className="carnet-menu__icone"><Ic size={18} /></span><span className="carnet-menu__libelle">{nom}</span>
              </button>
            );
          })}
        </div>
      )}
      {vue === "couleur" && (
        <div className="carnet-menu__defile">
          <button type="button" className="carnet-menu__retour" onPointerDown={garderFocus} onClick={vers("principal")}>
            <ChevronLeft size={16} /> Couleur
          </button>
          <Palette texte={texte} fond={fond} choisir={(quoi, c) => { if (!pret()) return; colorer(ed, menuBloc.pos, quoi, c); magasin.maj({ menuBloc: null }); }} />
        </div>
      )}
    </>
  );

  if (feuille) {
    return (
      <div className="carnet-feuille-voile" onPointerDown={(e) => { if (e.target === e.currentTarget) fermer(); }}>
        <div ref={ref} className="carnet-feuille" role="dialog" onMouseDown={sansFocus} aria-label={`Actions du bloc : ${nomDuBloc(noeud)}`}>
          <div className="carnet-feuille__poignee" />
          <button type="button" className="carnet-feuille__fermer" aria-label="Fermer" onPointerDown={garderFocus} onClick={fermer}><X size={20} /></button>
          {corps}
        </div>
      </div>
    );
  }
  return (
    <div ref={ref} className="carnet-menu carnet-menu-bloc" role="menu" onMouseDown={sansFocus} aria-label={`Actions du bloc : ${nomDuBloc(noeud)}`}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxHeight: pos ? Math.min(pos.hMax, 520) : undefined }}>
      {corps}
    </div>
  );
}
