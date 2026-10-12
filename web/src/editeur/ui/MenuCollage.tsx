// Menu « Lien · Signet » proposé juste après le collage d'une adresse seule (lot 4, réflexe Notion).
// « Lien » (choisi d'office) garde l'adresse dans le texte ; « Signet » en fait une carte (domaine + adresse), écrite
// `<https://…>` seule sur sa ligne. Le menu ne prend jamais le focus : continuer à écrire le ferme.
import { useEffect, useRef } from "react";
import { Bookmark, Link2 } from "lucide-react";
import type { Magasin } from "./magasin";
import { useMagasin, garderFocus, sansFocus } from "./communs";
import { usePosition } from "./position";
import { enSignet } from "../signet";

export function MenuCollage({ magasin }: { magasin: Magasin }) {
  const etat = useMagasin(magasin);
  const c = etat.collage;
  const ref = useRef<HTMLDivElement>(null);
  const pos = usePosition(ref, c?.ancre ?? null, "bottom-start", 6);
  const ed = magasin.editeur;
  // toute autre modification du document (frappe, autre collage) ferme le menu
  const perime = Boolean(c && ed && ed.state.doc !== c.doc);
  useEffect(() => { if (perime) magasin.maj({ collage: null }); }, [perime, magasin]);
  useEffect(() => {
    if (!c) return;
    const fermer = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) magasin.maj({ collage: null }); };
    const touche = (e: KeyboardEvent) => { if (e.key === "Escape") magasin.maj({ collage: null }); };
    window.addEventListener("pointerdown", fermer, true);
    window.addEventListener("keydown", touche, true);
    window.addEventListener("scroll", fermer, true);
    return () => {
      window.removeEventListener("pointerdown", fermer, true);
      window.removeEventListener("keydown", touche, true);
      window.removeEventListener("scroll", fermer, true);
    };
  }, [c, magasin]);
  if (!c || !ed || perime) return null;
  return (
    <div ref={ref} className="carnet-menu carnet-collage" role="toolbar" aria-label="Coller l'adresse comme" onMouseDown={sansFocus}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      <button type="button" className="carnet-collage__choix" aria-pressed="true" onPointerDown={garderFocus}
        onClick={() => { magasin.maj({ collage: null }); ed.commands.focus(); }}>
        <Link2 size={16} /> Lien
      </button>
      <button type="button" className="carnet-collage__choix" aria-pressed="false" onPointerDown={garderFocus}
        onClick={() => { magasin.maj({ collage: null }); enSignet(ed, c.from, c.to); }}>
        <Bookmark size={16} /> Signet
      </button>
    </div>
  );
}
