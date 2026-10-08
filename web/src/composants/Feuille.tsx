// Feuille modale : fenêtre centrée sur ordinateur, feuille qui monte du bas sur iPhone.
import { useEffect, useRef, type ReactNode } from "react";
import { X } from "lucide-react";

export function Feuille({ titre, onFermer, children, enHaut = false, sansTete = false, etiquette, large = false }: {
  titre?: string;
  onFermer: () => void;
  children: ReactNode;
  enHaut?: boolean;
  sansTete?: boolean;
  etiquette?: string;
  /** Plus large sur ordinateur (recherche avec aperçu). */
  large?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const precedent = document.activeElement as HTMLElement | null;
    const surTouche = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); onFermer(); return; }
      // Tab reste dans la feuille (le focus ne file pas vers la page derrière le voile).
      if (e.key === "Tab" && ref.current) {
        const l = [...ref.current.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([type=hidden]):not([hidden]), textarea, select, a[href], [tabindex]:not([tabindex='-1'])")]
          .filter((x) => x.offsetParent !== null || x === document.activeElement);
        if (!l.length) return;
        const i = l.indexOf(document.activeElement as HTMLElement);
        if (e.shiftKey && (i <= 0)) { e.preventDefault(); l[l.length - 1].focus(); }
        else if (!e.shiftKey && (i === -1 || i === l.length - 1)) { e.preventDefault(); l[0].focus(); }
      }
    };
    window.addEventListener("keydown", surTouche, true);
    // Focus : premier champ (sauf ceux marqués data-sans-focus : sur iPhone le clavier cacherait la feuille),
    // sinon la feuille elle-même
    const champ = ref.current?.querySelector<HTMLElement>("input:not([data-sans-focus]), textarea:not([data-sans-focus]), [data-autofocus]");
    if (champ) champ.focus({ preventScroll: true }); else ref.current?.focus({ preventScroll: true });
    // Hauteur visible (clavier iPhone) pour les feuilles plein écran
    const vv = window.visualViewport;
    const majHauteur = () => {
      if (vv) document.documentElement.style.setProperty("--hauteur-visible", `${vv.height}px`);
    };
    majHauteur();
    vv?.addEventListener("resize", majHauteur);
    return () => {
      window.removeEventListener("keydown", surTouche, true);
      vv?.removeEventListener("resize", majHauteur);
      precedent?.focus?.({ preventScroll: true });
    };
  }, [onFermer]);

  return (
    <div className="voile" data-haut={enHaut} onMouseDown={(e) => { if (e.target === e.currentTarget) onFermer(); }}>
      <div className="dialogue" role="dialog" aria-modal="true" aria-label={etiquette ?? titre} ref={ref} tabIndex={-1} data-large={large ? "true" : undefined}>
        {!sansTete && (
          <div className="dialogue__tete">
            <h2 className="dialogue__titre">{titre}</h2>
            <button type="button" className="bouton-icone" onClick={onFermer} aria-label="Fermer">
              <X size={20} />
            </button>
          </div>
        )}
        {children}
      </div>
    </div>
  );
}
