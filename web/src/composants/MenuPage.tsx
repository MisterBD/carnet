// Menu « … » d'une page : petit menu ancré sous le bouton sur ordinateur (comme Notion), feuille du bas sur iPhone.
// Les actions s'exécutent DANS le clic (copier le lien exige un geste de l'utilisateur, surtout sous Safari).
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Feuille } from "./Feuille";
import { IconePage } from "./Icone";
import { tactile } from "../outils";

export interface ElementMenu {
  cle: string;
  libelle: string;
  icone?: ReactNode;
  danger?: boolean;
  /** Raccourci ou précision affichée à droite (ordinateur). */
  indice?: string;
  separateurAvant?: boolean;
  faire: () => void;
}

const LARGEUR = 264;

function petitEcran(): boolean {
  return tactile || window.matchMedia("(max-width: 899.98px)").matches;
}

export function MenuPage({ titre, icone, sousTitre, elements, ancre, onFermer }: {
  titre: string;
  icone?: string | null;
  sousTitre?: string;
  elements: ElementMenu[];
  ancre: HTMLElement | null;
  onFermer: () => void;
}) {
  const [feuille] = useState(() => petitEcran() || !ancre || !ancre.isConnected);
  if (feuille) {
    return (
      <Feuille titre={titre} onFermer={onFermer}>
        {sousTitre && <p className="menu-page__sous-titre">{sousTitre}</p>}
        <ul className="menu-actions" role="menu" aria-label={`Actions pour ${titre}`}>
          {elements.map((it) => (
            <li key={it.cle} role="none" data-separateur={it.separateurAvant ? "true" : undefined}>
              <button type="button" role="menuitem" data-danger={it.danger ? "true" : undefined} onClick={() => { onFermer(); it.faire(); }}>
                {it.icone}
                <span>{it.libelle}</span>
              </button>
            </li>
          ))}
        </ul>
      </Feuille>
    );
  }
  return <Popover titre={titre} icone={icone} elements={elements} ancre={ancre!} onFermer={onFermer} />;
}

function Popover({ titre, icone, elements, ancre, onFermer }: {
  titre: string; icone?: string | null; elements: ElementMenu[]; ancre: HTMLElement; onFermer: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; haut: boolean; maxH: number } | null>(null);
  const [actif, setActif] = useState(0);

  useLayoutEffect(() => {
    const placer = () => {
      const r = ancre.getBoundingClientRect();
      const h = ref.current?.offsetHeight ?? 320;
      const vh = window.innerHeight;
      const vw = window.innerWidth;
      const dessous = vh - r.bottom - 12;
      const dessus = r.top - 12;
      const haut = dessous < Math.min(h, 300) && dessus > dessous;
      const maxH = Math.max(160, (haut ? dessus : dessous) - 4);
      // Aligné sur le bord gauche du bouton, sauf s'il déborderait à droite.
      let left = r.left;
      if (left + LARGEUR > vw - 8) left = Math.max(8, r.right - LARGEUR);
      const top = haut ? Math.max(8, r.top - Math.min(h, maxH) - 6) : r.bottom + 6;
      setPos({ top, left, haut, maxH });
    };
    placer();
    window.addEventListener("resize", placer);
    return () => window.removeEventListener("resize", placer);
  }, [ancre]);

  useEffect(() => {
    const precedent = document.activeElement as HTMLElement | null;
    const boutons = () => [...(ref.current?.querySelectorAll<HTMLButtonElement>("button[role=menuitem]") ?? [])];
    boutons()[0]?.focus({ preventScroll: true });
    const surTouche = (e: KeyboardEvent) => {
      const l = boutons();
      const i = l.indexOf(document.activeElement as HTMLButtonElement);
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onFermer(); precedent?.focus?.({ preventScroll: true }); }
      else if (e.key === "ArrowDown") { e.preventDefault(); const n = (i + 1) % l.length; l[n]?.focus(); setActif(n); }
      else if (e.key === "ArrowUp") { e.preventDefault(); const n = (i - 1 + l.length) % l.length; l[n]?.focus(); setActif(n); }
      else if (e.key === "Home") { e.preventDefault(); l[0]?.focus(); setActif(0); }
      else if (e.key === "End") { e.preventDefault(); l[l.length - 1]?.focus(); setActif(l.length - 1); }
      else if (e.key === "Tab") { e.preventDefault(); onFermer(); precedent?.focus?.({ preventScroll: true }); }
    };
    const surAppui = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t)) return;
      if (ancre.contains(t)) { e.preventDefault(); e.stopPropagation(); }
      onFermer();
    };
    const surDefilement = (e: Event) => { if (!ref.current?.contains(e.target as Node)) onFermer(); };
    window.addEventListener("keydown", surTouche, true);
    window.addEventListener("pointerdown", surAppui, true);
    window.addEventListener("scroll", surDefilement, true);
    return () => {
      window.removeEventListener("keydown", surTouche, true);
      window.removeEventListener("pointerdown", surAppui, true);
      window.removeEventListener("scroll", surDefilement, true);
    };
  }, [ancre, onFermer]);

  return (
    <div
      ref={ref}
      className="menu-ancre"
      role="menu"
      aria-label={`Actions pour ${titre}`}
      data-haut={pos?.haut ? "true" : undefined}
      style={{ top: pos?.top ?? -9999, left: pos?.left ?? -9999, maxHeight: pos?.maxH, width: LARGEUR, visibility: pos ? "visible" : "hidden" }}
    >
      <div className="menu-ancre__tete" aria-hidden="true">
        <span className="menu-ancre__icone"><IconePage icone={icone ?? null} taille={15} /></span>
        <span className="menu-ancre__titre">{titre}</span>
      </div>
      {elements.map((it, i) => (
        <div key={it.cle} role="none">
          {it.separateurAvant && <div className="menu-ancre__sep" role="separator" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={i === actif ? 0 : -1}
            data-danger={it.danger ? "true" : undefined}
            onMouseEnter={(e) => { e.currentTarget.focus({ preventScroll: true }); setActif(i); }}
            onClick={() => { onFermer(); it.faire(); }}
          >
            <span className="menu-ancre__pictogramme">{it.icone}</span>
            <span className="menu-ancre__libelle">{it.libelle}</span>
            {it.indice && <span className="menu-ancre__indice">{it.indice}</span>}
          </button>
        </div>
      ))}
    </div>
  );
}
