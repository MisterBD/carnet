// Visionneuse d'image plein écran (lot 4, issue #12) : fond sombre, image en grand avec sa légende, fermeture par
// Échap, ✕, un toucher à côté de l'image ou le geste retour ; zoom au pincement (iPhone) et au clic (ordinateur).
// Aucune écriture de fichier, aucune ressource externe (même adresse que l'image de la page). Le focus revient à
// l'élément d'origine à la fermeture.
import { icDivers } from "./icones";

let ouverte: (() => void) | null = null;

export function ouvrirVisionneuse(src: string, legende: string, retour: HTMLElement | (() => void) | null): void {
  ouverte?.();
  const voile = document.createElement("div");
  voile.className = "carnet-visionneuse";
  voile.setAttribute("role", "dialog");
  voile.setAttribute("aria-modal", "true");
  voile.setAttribute("aria-label", legende ? `Image : ${legende}` : "Image en grand");
  const fermerBtn = document.createElement("button");
  fermerBtn.type = "button";
  fermerBtn.className = "carnet-visionneuse__fermer";
  fermerBtn.setAttribute("aria-label", "Fermer l'image");
  fermerBtn.title = "Fermer (Échap)";
  fermerBtn.innerHTML = icDivers.fermer;
  const scene = document.createElement("div");
  scene.className = "carnet-visionneuse__scene";
  const img = document.createElement("img");
  img.className = "carnet-visionneuse__img";
  img.src = src;
  img.alt = legende;
  img.draggable = false;
  scene.append(img);
  voile.append(fermerBtn, scene);
  if (legende) {
    const lg = document.createElement("p");
    lg.className = "carnet-visionneuse__legende";
    lg.textContent = legende; // texte du fichier : jamais interprété comme HTML
    voile.append(lg);
  }

  // ---- zoom et déplacement (transform sur l'image) ----
  let echelle = 1, dx = 0, dy = 0;
  const appliquer = () => {
    img.style.transform = `translate(${dx}px, ${dy}px) scale(${echelle})`;
    voile.dataset.zoom = echelle > 1.01 ? "oui" : "non";
  };
  const borner = () => {
    echelle = Math.min(5, Math.max(1, echelle));
    if (echelle <= 1.01) { echelle = 1; dx = 0; dy = 0; return; }
    const r = img.getBoundingClientRect();
    const l = (r.width / echelle) * (echelle - 1) / 2 + 40;
    const h = (r.height / echelle) * (echelle - 1) / 2 + 40;
    dx = Math.min(l, Math.max(-l, dx));
    dy = Math.min(h, Math.max(-h, dy));
  };
  const zoomerVers = (e: number, cx: number, cy: number) => {
    const r = scene.getBoundingClientRect();
    const ox = cx - (r.left + r.width / 2);
    const oy = cy - (r.top + r.height / 2);
    const k = e / echelle;
    dx = ox - (ox - dx) * k;
    dy = oy - (oy - dy) * k;
    echelle = e;
    borner();
    appliquer();
  };
  appliquer();

  // Pincer (deux doigts), glisser (un doigt, zoomé), double toucher (zoom ×2,5 / retour)
  const doigts = new Map<number, { x: number; y: number }>();
  let depart: { dist: number; echelle: number; cx: number; cy: number } | null = null;
  let glisse: { x: number; y: number; dx: number; dy: number } | null = null;
  let dernierToucher = 0;
  let bouge = false;
  let dernierType = "mouse";
  scene.addEventListener("pointerdown", (e) => {
    dernierType = e.pointerType;
    if (e.pointerType === "mouse") return;
    scene.setPointerCapture(e.pointerId);
    doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    bouge = false;
    if (doigts.size === 2) {
      const [a, b] = [...doigts.values()];
      depart = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1, echelle, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
      glisse = null;
    } else if (doigts.size === 1) glisse = { x: e.clientX, y: e.clientY, dx, dy };
  });
  scene.addEventListener("pointermove", (e) => {
    if (!doigts.has(e.pointerId)) return;
    doigts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (depart && doigts.size >= 2) {
      const [a, b] = [...doigts.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      bouge = true;
      zoomerVers(depart.echelle * (d / depart.dist), depart.cx, depart.cy);
    } else if (glisse && echelle > 1) {
      if (Math.abs(e.clientX - glisse.x) + Math.abs(e.clientY - glisse.y) > 6) bouge = true;
      dx = glisse.dx + (e.clientX - glisse.x);
      dy = glisse.dy + (e.clientY - glisse.y);
      borner();
      appliquer();
    } else if (glisse && Math.abs(e.clientX - glisse.x) + Math.abs(e.clientY - glisse.y) > 6) bouge = true;
  });
  const lever = (e: PointerEvent) => {
    if (!doigts.has(e.pointerId)) return;
    doigts.delete(e.pointerId);
    if (doigts.size < 2) depart = null;
    if (doigts.size === 1) { const [a] = [...doigts.values()]; glisse = { x: a.x, y: a.y, dx, dy }; }
    if (doigts.size === 0) {
      glisse = null;
      if (bouge || e.type === "pointercancel") return;
      const t = performance.now();
      if (t - dernierToucher < 320) { zoomerVers(echelle > 1 ? 1 : 2.5, e.clientX, e.clientY); dernierToucher = 0; }
      else {
        dernierToucher = t;
        // un toucher simple hors de l'image ferme (après le délai du double toucher)
        const hors = e.target !== img;
        if (hors && echelle === 1) window.setTimeout(() => { if (dernierToucher === t) fermer(); }, 330);
      }
    }
  };
  scene.addEventListener("pointerup", lever);
  scene.addEventListener("pointercancel", lever);
  // Souris : clic sur l'image = zoom ×2 au point visé / retour ; clic à côté = fermer ; molette + Ctrl = zoom
  scene.addEventListener("click", (e) => {
    // au doigt, le « click » de compatibilité suit le toucher (déjà traité ci-dessus) : ignoré (Safari n'y met pas pointerType)
    if (dernierType !== "mouse" || e.detail === 0) return;
    if (e.target === img) zoomerVers(echelle > 1 ? 1 : 2, e.clientX, e.clientY);
    else if (echelle === 1) fermer();
  });
  scene.addEventListener("wheel", (e) => {
    if (!e.ctrlKey && echelle === 1) return;
    e.preventDefault();
    if (e.ctrlKey) zoomerVers(echelle * Math.exp(-e.deltaY / 300), e.clientX, e.clientY);
    else { dx -= e.deltaX; dy -= e.deltaY; borner(); appliquer(); }
  }, { passive: false });

  // ---- clavier, historique, fermeture ----
  const surTouche = (e: KeyboardEvent) => {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); fermer(); return; }
    if (e.key === "Tab") { e.preventDefault(); fermerBtn.focus(); return; } // un seul élément actif : le focus reste ici
    if (e.key === "+" || e.key === "=") { e.preventDefault(); const r = scene.getBoundingClientRect(); zoomerVers(echelle * 1.5, r.left + r.width / 2, r.top + r.height / 2); }
    if (e.key === "-") { e.preventDefault(); const r = scene.getBoundingClientRect(); zoomerVers(echelle / 1.5, r.left + r.width / 2, r.top + r.height / 2); }
  };
  const surRetour = (e: PopStateEvent) => { if (!e.state?.carnetVisionneuse) fermer(true); };
  let posee = false;
  try { history.pushState({ ...(history.state ?? {}), carnetVisionneuse: true }, ""); posee = true; } catch { /* sans historique */ }
  const html = document.documentElement;
  const debordement = html.style.overflow;
  html.style.overflow = "hidden";

  let fini = false;
  function fermer(parRetour = false) {
    if (fini) return;
    fini = true;
    ouverte = null;
    window.removeEventListener("keydown", surTouche, true);
    window.removeEventListener("popstate", surRetour);
    html.style.overflow = debordement;
    voile.remove();
    if (posee && !parRetour && history.state?.carnetVisionneuse) history.back();
    if (typeof retour === "function") retour();
    else if (retour?.isConnected) retour.focus({ preventScroll: true });
  }
  fermerBtn.addEventListener("click", () => fermer());
  window.addEventListener("keydown", surTouche, true);
  window.addEventListener("popstate", surRetour);
  ouverte = () => fermer();
  document.body.append(voile);
  fermerBtn.focus({ preventScroll: true });
}
