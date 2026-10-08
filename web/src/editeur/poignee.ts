// Poignée de bloc (⋮⋮) : au survol sur ordinateur (avec « + »), sur le bloc courant au toucher.
// Clic : menu du bloc. Glisser (souris) : déplacer le bloc (ligne d'insertion de Dropcursor).
import { Extension, type Editor } from "@tiptap/core";
import { Plugin, PluginKey, NodeSelection, TextSelection } from "@tiptap/pm/state";
import { Fragment, Slice } from "@tiptap/pm/model";
import type { EditorView } from "@tiptap/pm/view";
import { blocEn, blocCourant, type Bloc } from "./blocs";
import { ic } from "./icones";
import type { Magasin } from "./ui/magasin";
import { rectDe } from "./ui/magasin";

const tactile = () => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function extensionPoignee(magasin: Magasin) {
  return Extension.create({
    name: "carnetPoignee",
    addProseMirrorPlugins() {
      const editor = this.editor;
      let poignee: Poignee | null = null;
      return [new Plugin({
        key: new PluginKey("carnetPoignee"),
        view: (vue) => (poignee = new Poignee(vue, editor, magasin)),
        props: {
          handleDOMEvents: {
            dragover: (_v, e) => { poignee?.survolDepot(e); return false; },
            dragleave: (_v, e) => { if (!(e.relatedTarget instanceof Node) || !_v.dom.contains(e.relatedTarget)) poignee?.cacherRepere(); return false; },
          },
          // dépôt d'un bloc glissé par la poignée : avant ou après le bloc visé (moitié haute / basse), comme Notion
          handleDrop: (_v, e) => (poignee ? poignee.deposer(e as DragEvent) : false),
        },
      })];
    },
  });
}

class Poignee {
  private el: HTMLDivElement;
  private plus: HTMLButtonElement;
  private grip: HTMLDivElement;
  private bloc: Bloc | null = null;
  private conteneur: HTMLElement;
  private masque: number | null = null;
  private appui: number | null = null;
  private vue: EditorView;
  private editor: Editor;
  private magasin: Magasin;
  /** bloc en cours de glissement (par la poignée) */
  private glisse: Bloc | null = null;
  private repere: HTMLDivElement;
  private cible: { pos: number; avant: boolean } | null = null;

  constructor(vue: EditorView, editor: Editor, magasin: Magasin) {
    this.vue = vue;
    this.editor = editor;
    this.magasin = magasin;
    this.conteneur = vue.dom.parentElement ?? vue.dom;
    this.el = document.createElement("div");
    this.el.className = "carnet-poignee";
    this.el.hidden = true;
    this.plus = document.createElement("button");
    this.plus.type = "button";
    this.plus.className = "carnet-poignee__plus";
    this.plus.title = "Ajouter un bloc dessous (Alt : dessus)";
    this.plus.setAttribute("aria-label", "Ajouter un bloc");
    this.plus.innerHTML = ic.plus;
    // une <div> (et non un <button>) : un bouton ne se laisse pas glisser dans tous les navigateurs
    this.grip = document.createElement("div");
    this.grip.setAttribute("role", "button");
    this.grip.tabIndex = 0;
    this.grip.className = "carnet-poignee__grip";
    this.grip.title = "Glisser pour déplacer · Cliquer pour le menu";
    this.grip.setAttribute("aria-label", "Actions du bloc");
    this.grip.draggable = true;
    this.grip.innerHTML = ic.poignee;
    this.el.append(this.plus, this.grip);
    this.repere = document.createElement("div");
    this.repere.className = "carnet-repere-depot";
    this.repere.hidden = true;
    this.conteneur.append(this.el, this.repere);

    this.conteneur.addEventListener("mousemove", this.survol);
    this.conteneur.addEventListener("mouseleave", this.quitter);
    this.el.addEventListener("mouseenter", () => { if (this.masque) { window.clearTimeout(this.masque); this.masque = null; } });
    this.plus.addEventListener("mousedown", (e) => e.preventDefault());
    this.plus.addEventListener("click", this.ajouter);
    this.grip.addEventListener("mousedown", (e) => { if (!tactile()) e.stopPropagation(); });
    this.grip.addEventListener("click", this.menu);
    this.grip.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); this.menu(); } });
    this.grip.addEventListener("dragstart", this.debutGlisser);
    this.grip.addEventListener("dragend", this.finGlisser);
    // appui long sur la poignée (tactile) : même menu
    this.grip.addEventListener("touchstart", () => {
      this.appui = window.setTimeout(() => { this.appui = null; this.menu(); }, 450);
    }, { passive: true });
    const annuler = () => { if (this.appui) { window.clearTimeout(this.appui); this.appui = null; } };
    this.grip.addEventListener("touchend", annuler);
    this.grip.addEventListener("touchmove", annuler, { passive: true });
  }

  update(vue: EditorView): void {
    this.vue = vue;
    if (tactile()) {
      // au toucher : la poignée suit le bloc où se trouve le curseur, tant que l'éditeur a le focus
      if (!vue.hasFocus() || !this.editor.isEditable) { this.cacher(); return; }
      const b = blocCourant(vue.state);
      if (b) this.montrer(b); else this.cacher();
      return;
    }
    if (this.bloc) {
      // le document a changé : on revérifie la position du bloc survolé
      const n = vue.state.doc.nodeAt(this.bloc.pos);
      if (!n || n !== this.bloc.node) this.cacher();
    }
  }

  destroy(): void {
    this.conteneur.removeEventListener("mousemove", this.survol);
    this.conteneur.removeEventListener("mouseleave", this.quitter);
    this.el.remove();
    this.repere.remove();
  }

  /** Bloc visé sous le pointeur pendant un glissement, et le côté (avant / après). */
  private viser(e: DragEvent): { pos: number; avant: boolean; dom: HTMLElement } | null {
    const r = this.vue.dom.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX, r.left + 4), r.right - 4);
    const y = Math.min(Math.max(e.clientY, r.top + 1), r.bottom - 1);
    const p = this.vue.posAtCoords({ left: x, top: y });
    if (!p) return null;
    const b = blocEn(this.vue.state, p.inside >= 0 ? p.inside : p.pos);
    if (!b) return null;
    const dom = this.vue.nodeDOM(b.pos) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) return null;
    const rb = dom.getBoundingClientRect();
    return { pos: b.pos, avant: e.clientY < rb.top + rb.height / 2, dom };
  }

  survolDepot(e: DragEvent): void {
    if (!this.glisse) return;
    const v = this.viser(e);
    if (!v) { this.cacherRepere(); return; }
    const g = this.glisse;
    if (v.pos >= g.pos && v.pos < g.pos + g.node.nodeSize) { this.cacherRepere(); this.cible = null; return; }
    this.cible = { pos: v.pos, avant: v.avant };
    const c = this.conteneur.getBoundingClientRect();
    const rb = v.dom.getBoundingClientRect();
    this.repere.hidden = false;
    this.repere.style.top = `${Math.round((v.avant ? rb.top - 4 : rb.bottom + 2) - c.top)}px`;
    this.repere.style.left = `${Math.round(rb.left - c.left)}px`;
    this.repere.style.width = `${Math.round(rb.width)}px`;
  }

  cacherRepere(): void {
    this.repere.hidden = true;
  }

  deposer(e: DragEvent): boolean {
    const g = this.glisse;
    if (!g) return false;
    e.preventDefault();
    this.glisse = null;
    this.cacherRepere();
    (this.vue as unknown as { dragging: unknown }).dragging = null;
    const v = this.viser(e) ?? (this.cible ? { ...this.cible, dom: null } : null);
    document.body.classList.remove("carnet-glisse-bloc");
    if (!v || (v.pos >= g.pos && v.pos < g.pos + g.node.nodeSize)) return true;
    const state = this.vue.state;
    const cibleNoeud = state.doc.nodeAt(v.pos);
    if (!cibleNoeud) return true;
    const ou = v.avant ? v.pos : v.pos + cibleNoeud.nodeSize;
    const noeud = state.doc.nodeAt(g.pos);
    if (!noeud) return true;
    let tr = state.tr.delete(g.pos, g.pos + noeud.nodeSize);
    const p = tr.mapping.map(ou, v.avant ? 1 : -1);
    tr = tr.replaceRange(p, p, new Slice(Fragment.from(noeud), 0, 0));
    const debut = tr.mapping.map(p, -1);
    try { tr.setSelection(NodeSelection.create(tr.doc, Math.min(debut, tr.doc.content.size - 1))); } catch { /* sélection impossible */ }
    this.vue.dispatch(tr.scrollIntoView());
    this.vue.focus();
    return true;
  }

  private survol = (e: MouseEvent) => {
    if (tactile() || !this.editor.isEditable || this.vue.dragging) return;
    if (this.el.contains(e.target as Node)) return;
    const r = this.vue.dom.getBoundingClientRect();
    const x = Math.min(Math.max(e.clientX, r.left + 4), r.right - 4);
    const p = this.vue.posAtCoords({ left: x, top: e.clientY });
    if (!p) return;
    const b = blocEn(this.vue.state, p.inside >= 0 ? p.inside : p.pos);
    if (!b) { this.cacherBientot(); return; }
    if (this.masque) { window.clearTimeout(this.masque); this.masque = null; }
    this.montrer(b);
  };

  private quitter = () => this.cacherBientot();

  private cacherBientot(): void {
    if (this.masque) return;
    this.masque = window.setTimeout(() => { this.masque = null; this.cacher(); }, 260);
  }

  private cacher(): void {
    this.el.hidden = true;
    this.bloc = null;
  }

  private montrer(b: Bloc): void {
    const dom = this.vue.nodeDOM(b.pos) as HTMLElement | null;
    if (!dom || !(dom instanceof HTMLElement)) { this.cacher(); return; }
    this.bloc = b;
    const c = this.conteneur.getBoundingClientRect();
    const r = dom.getBoundingClientRect();
    // centrée sur la première ligne du bloc
    const premiere = (dom.matches("li") ? dom : dom.querySelector(".carnet-code__tete, .carnet-encadre__tete, .carnet-artefact__tete, .carnet-sommaire__tete, p, h1, h2, h3, h4, h5, h6, li, summary, pre") ?? dom) as HTMLElement;
    const lh = parseFloat(getComputedStyle(premiere).lineHeight) || 28;
    const rp = premiere.getBoundingClientRect();
    const haut = (premiere === dom ? r.top : rp.top) - c.top + Math.min(lh, Math.max(24, rp.height)) / 2 - 14;
    this.el.hidden = false;
    this.el.dataset.mode = tactile() ? "tactile" : "souris";
    this.el.style.top = `${Math.round(haut)}px`;
    this.el.style.left = `${Math.round(r.left - c.left)}px`;
  }

  private ajouter = (e: MouseEvent) => {
    e.preventDefault();
    const b = this.bloc;
    if (!b) return;
    const ed = this.editor;
    const pos = e.altKey ? b.pos : b.pos + b.node.nodeSize;
    const n = ed.state.doc.nodeAt(b.pos);
    // bloc vide : on y tape directement « / »
    if (n && n.type.name === "paragraph" && n.content.size === 0) {
      ed.chain().focus().setTextSelection(b.pos + 1).insertContent("/").run();
      return;
    }
    const type = ed.schema.nodes.paragraph;
    const tr = ed.state.tr.insert(pos, type.create());
    tr.setSelection(TextSelection.create(tr.doc, pos + 1));
    ed.view.dispatch(tr);
    ed.chain().focus().insertContent("/").run();
  };

  private menu = () => {
    const b = this.bloc ?? blocCourant(this.vue.state);
    if (!b) return;
    this.magasin.maj({ menuBloc: { pos: b.pos, ancre: rectDe(this.grip), feuille: tactile(), vue: "principal" } });
  };

  private debutGlisser = (e: DragEvent) => {
    const b = this.bloc;
    if (!b || !e.dataTransfer) return;
    const sel = NodeSelection.create(this.vue.state.doc, b.pos);
    this.vue.dispatch(this.vue.state.tr.setSelection(sel));
    const tranche = sel.content();
    // `dragging` : la dépose de ProseMirror déplace le bloc (et retire l'original)
    (this.vue as unknown as { dragging: { slice: typeof tranche; move: boolean } | null }).dragging = { slice: tranche, move: true };
    e.dataTransfer.effectAllowed = "copyMove";
    e.dataTransfer.clearData();
    e.dataTransfer.setData("text/plain", b.node.textContent);
    e.dataTransfer.setData("text/html", (this.vue.nodeDOM(b.pos) as HTMLElement | null)?.outerHTML ?? "");
    const dom = this.vue.nodeDOM(b.pos) as HTMLElement | null;
    if (dom) e.dataTransfer.setDragImage(dom, 0, 0);
    this.el.classList.add("est-glisse");
    this.glisse = b;
    document.body.classList.add("carnet-glisse-bloc");
  };

  private finGlisser = () => {
    this.el.classList.remove("est-glisse");
    this.glisse = null;
    this.cacherRepere();
    document.body.classList.remove("carnet-glisse-bloc");
    this.cacher();
  };
}
