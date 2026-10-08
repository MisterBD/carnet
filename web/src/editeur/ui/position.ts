// Placement des menus flottants : sous (ou au-dessus de) l'ancre, bornés à la zone visible (clavier iPhone compris).
import { computePosition, flip, offset, shift, size, type Placement } from "@floating-ui/dom";
import { useLayoutEffect, useState, type RefObject } from "react";
import type { Rect } from "./magasin";

/** Zone réellement visible (au-dessus du clavier virtuel sur iPhone). */
export function zoneVisible(): { x: number; y: number; width: number; height: number } {
  const vv = window.visualViewport;
  // la barre au-dessus du clavier (≈ 52 px) ne doit pas recouvrir le menu
  const barre = document.querySelector(".carnet-barre-clavier") ? 56 : 0;
  if (!vv) return { x: 0, y: 0, width: window.innerWidth, height: window.innerHeight - barre };
  return { x: vv.offsetLeft, y: vv.offsetTop, width: vv.width, height: vv.height - barre };
}

export function usePosition(ref: RefObject<HTMLElement | null>, ancre: Rect | null, placement: Placement = "bottom-start", ecart = 6, dep: unknown = null) {
  const [pos, setPos] = useState<{ x: number; y: number; hMax: number } | null>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !ancre) { setPos(null); return; }
    const virtuel = { getBoundingClientRect: () => ({ ...ancre, x: ancre.left, y: ancre.top }) as DOMRect };
    let hMax = 400;
    let annule = false;
    void computePosition(virtuel, el, {
      strategy: "fixed",
      placement,
      middleware: [
        offset(ecart),
        flip({
          padding: 8, boundary: { ...zoneVisible() } as never,
          // garder le même alignement horizontal quand le menu passe de l'autre côté
          fallbackPlacements: placement.startsWith("top") ? ["bottom-start", "top-end", "bottom-end"] : ["top-start", "bottom-end", "top-end"],
        }),
        shift({ padding: 8, boundary: { ...zoneVisible() } as never }),
        size({ padding: 8, boundary: { ...zoneVisible() } as never, apply: ({ availableHeight }) => { hMax = Math.max(140, Math.floor(availableHeight)); } }),
      ],
    }).then(({ x, y }) => { if (!annule) setPos({ x, y, hMax }); });
    return () => { annule = true; };
  }, [ref, ancre?.left, ancre?.top, ancre?.width, ancre?.height, placement, ecart, dep]);
  return pos;
}
