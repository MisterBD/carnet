// Menu « / » : blocs groupés, recherche sans accents, flèches + Entrée, toucher sur iPhone (au-dessus du clavier).
import { useEffect, useRef } from "react";
import type { Magasin } from "./magasin";
import { useMagasin, ICONES, garderFocus, sansFocus } from "./communs";
import { usePosition } from "./position";

export function MenuSlash({ magasin }: { magasin: Magasin }) {
  const { slash } = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const liste = useRef<HTMLDivElement>(null);
  const pos = usePosition(ref, slash.ouvert ? slash.rect : null, "bottom-start", 8, slash.entrees.length);

  useEffect(() => {
    const el = liste.current?.querySelector<HTMLElement>("[data-actif='true']");
    el?.scrollIntoView({ block: "nearest" });
  }, [slash.index]);

  // Le focus reste dans le texte : l'éditeur annonce la liste et l'entrée active (aria-activedescendant).
  const nb = slash.entrees.length;
  useEffect(() => {
    const ed = document.activeElement?.closest?.<HTMLElement>(".ProseMirror");
    if (!ed || !slash.ouvert) return;
    ed.setAttribute("aria-controls", "carnet-menu-slash");
    ed.setAttribute("aria-autocomplete", "list");
    if (nb) ed.setAttribute("aria-activedescendant", `carnet-slash-${slash.index}`);
    else ed.removeAttribute("aria-activedescendant");
    return () => { ["aria-controls", "aria-autocomplete", "aria-activedescendant"].forEach((a) => ed.removeAttribute(a)); };
  }, [slash.ouvert, slash.index, nb]);

  if (!slash.ouvert) return null;
  let groupe = "";
  return (
    <div ref={ref} id="carnet-menu-slash" className="carnet-menu carnet-menu-slash" role="listbox" onMouseDown={sansFocus} aria-label="Insérer un bloc"
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxHeight: pos ? Math.min(pos.hMax, 400) : undefined }}>
      <div ref={liste} className="carnet-menu__defile">
        {slash.entrees.length === 0 && (
          <div className="carnet-menu__vide">Aucun bloc ne correspond à « {slash.requete} ». Échap pour garder le texte.</div>
        )}
        {slash.entrees.map((e, i) => {
          const tete = e.groupe !== groupe ? (groupe = e.groupe) : null;
          const Ic = ICONES[e.icone];
          return (
            <div key={e.cle}>
              {tete && !slash.requete && <div className="carnet-menu__groupe">{tete}</div>}
              <button type="button" id={`carnet-slash-${i}`} role="option" aria-selected={i === slash.index} data-actif={i === slash.index}
                className="carnet-menu__entree" data-cle={e.cle}
                onPointerDown={garderFocus}
                onMouseEnter={() => magasin.majSlash({ index: i })}
                onClick={() => slash.executer?.(e)}>
                <span className="carnet-menu__icone" data-icone={e.icone}><Ic size={19} strokeWidth={1.8} /></span>
                <span className="carnet-menu__textes">
                  <span className="carnet-menu__libelle">{e.libelle}</span>
                  {e.aide && <span className="carnet-menu__aide">{e.aide}</span>}
                </span>
                {e.md && <kbd className="carnet-menu__md">{e.md}</kbd>}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
