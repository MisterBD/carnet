// Ancres de titre (lot 4) : [[Page#Titre]] (#5) et sommaire « Sur cette page ».
import type { EditeurCarnet } from "./editeur/creer";
import { plier } from "../../shared/page.ts";

/** Titre de l'éditeur visé par une ancre [[Page#Titre]] : texte exact, puis sans casse ni accents, puis lettres seules. */
export function titreVise(ed: EditeurCarnet, ancre: string): HTMLElement | null {
  const vue = ed.vueOuNull();
  if (!vue) return null;
  const titres: Array<{ texte: string; pos: number }> = [];
  vue.state.doc.descendants((n, pos) => {
    if (n.type.name === "heading") titres.push({ texte: n.textContent.trim(), pos });
    return n.type.name !== "codeBlock";
  });
  const a = ancre.trim();
  const souple = (x: string) => plier(x).replace(/\s+/g, " ").trim();
  const lettres = (x: string) => plier(x).replace(/[^\p{L}\p{N}]+/gu, "");
  const t = titres.find((x) => x.texte === a) ?? titres.find((x) => souple(x.texte) === souple(a))
    ?? (lettres(a) ? titres.find((x) => lettres(x.texte) === lettres(a)) : undefined);
  if (!t) return null;
  const dom = vue.nodeDOM(t.pos);
  return dom instanceof HTMLElement ? dom : null;
}

/** Défile jusqu'à un titre de l'éditeur (sous l'en-tête collant : scroll-padding-top du document) avec un léger surlignage. */
export function defilerVersTitre(el: HTMLElement, doux = false): void {
  const reduit = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  el.scrollIntoView({ behavior: doux && !reduit ? "smooth" : "auto", block: "start" });
  el.classList.add("carnet-flash");
  window.setTimeout(() => el.classList.remove("carnet-flash"), 1600);
}
