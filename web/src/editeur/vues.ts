// Vues des nœuds maison (sans React) : encadrés, liens de page et dates, artefacts, images, cases à cocher,
// repliables, blocs de code (langage, copier, aperçus Mermaid / Vega-Lite isolés via le serveur d'artefacts), sommaire.
import type { Editor, NodeViewRendererProps } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { NodeSelection, TextSelection } from "@tiptap/pm/state";
import { resoudre } from "../../../shared/page.ts";
import type { ContexteEditeur } from "./contexte";
import { enregistrerCadre, themeCadres } from "./cadres";
import { ic, icDivers, icEncadre, CASE_VIDE, CASE_COCHEE } from "./icones";
import type { Magasin } from "./ui/magasin";
import { rectDe } from "./ui/magasin";
import { libelleLangue, typeApercu } from "./langues";

type Props = NodeViewRendererProps;
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, attrs: Record<string, string> = {}): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
};
const posDe = (p: Props): number | null => {
  const r = typeof p.getPos === "function" ? p.getPos() : undefined;
  return typeof r === "number" ? r : null;
};

export const GENRES = ["NOTE", "TIP", "IMPORTANT", "WARNING", "CAUTION"] as const;
export const LIBELLES_ENCADRE: Record<string, string> = {
  NOTE: "Note", TIP: "Astuce", IMPORTANT: "Important", WARNING: "Attention", CAUTION: "Prudence",
};

// ------------------------------------------------------------------------------------------------ encadré

export function vueEncadre() {
  return (p: Props) => {
    let node = p.node;
    const { editor } = p;
    const dom = el("div", "carnet-encadre");
    const tete = el("div", "carnet-encadre__tete", { contenteditable: "false" });
    const bouton = el("button", "carnet-encadre__genre", { type: "button", title: "Changer le type d'encadré" });
    const titre = el("input", "carnet-encadre__titre", { placeholder: "Titre (facultatif)", "aria-label": "Titre de l'encadré", spellcheck: "true" });
    tete.append(bouton, titre);
    const contenu = el("div", "carnet-encadre__contenu");
    dom.append(tete, contenu);

    const rendre = () => {
      const g = String(node.attrs.genre);
      dom.setAttribute("data-encadre", g);
      bouton.innerHTML = `${icEncadre[g] ?? icEncadre.NOTE}<span></span>`;
      (bouton.lastChild as HTMLElement).textContent = LIBELLES_ENCADRE[g] ?? g;
      if (document.activeElement !== titre) titre.value = String(node.attrs.titre ?? "");
      titre.style.display = editor.isEditable || node.attrs.titre ? "" : "none";
    };
    rendre();
    const poser = (attrs: Record<string, unknown>) => {
      const pos = posDe(p);
      if (pos == null) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
    };
    bouton.addEventListener("click", (e) => {
      e.preventDefault();
      if (!editor.isEditable) return;
      const i = GENRES.indexOf(String(node.attrs.genre) as never);
      poser({ genre: GENRES[(i + 1) % GENRES.length] });
    });
    titre.addEventListener("input", () => poser({ titre: titre.value.replace(/\n/g, " ") }));
    titre.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === "ArrowDown") {
        e.preventDefault();
        const pos = posDe(p);
        if (pos == null) return;
        editor.view.focus();
        editor.view.dispatch(editor.state.tr.setSelection(TextSelection.near(editor.state.doc.resolve(pos + 2))));
      }
    });
    return {
      dom,
      contentDOM: contenu,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        node = n;
        rendre();
        return true;
      },
      stopEvent: (e: Event) => tete.contains(e.target as Node),
      ignoreMutation: (m: { type: string; target: Node }) => m.type !== "selection" && (tete.contains(m.target) || m.target === dom),
    };
  };
}

// ------------------------------------------------------------------------------------------------ liens de page

const RE_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const fmtDate = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short" });
const fmtDateAn = new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", year: "numeric" });

/** « Aujourd'hui », « Demain », « Hier » ou « jeu. 8 oct. » pour un lien de journal [[AAAA-MM-JJ]]. */
export function libelleDate(iso: string, maintenant = new Date()): string | null {
  const m = RE_DATE.exec(iso);
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(d.getTime())) return null;
  const jour = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const ecart = Math.round((jour(d) - jour(maintenant)) / 86400000);
  if (ecart === 0) return "Aujourd'hui";
  if (ecart === 1) return "Demain";
  if (ecart === -1) return "Hier";
  return (d.getFullYear() === maintenant.getFullYear() ? fmtDate : fmtDateAn).format(d);
}

export function decomposer(valeur: string): { cible: string; alias: string | null; ancre: string | null } {
  let v = valeur;
  let alias: string | null = null;
  const bar = v.indexOf("|");
  if (bar !== -1) { alias = v.slice(bar + 1).trim() || null; v = v.slice(0, bar); }
  let ancre: string | null = null;
  const diese = v.indexOf("#");
  if (diese !== -1) { ancre = v.slice(diese + 1) || null; v = v.slice(0, diese); }
  return { cible: v.trim(), alias, ancre };
}

export function vueWikilien(contexte: ContexteEditeur) {
  const libelle = (valeur: string): string => {
    const { cible, alias } = decomposer(valeur);
    if (alias) return alias;
    const t = contexte.titreDe(cible);
    if (t) return t;
    const d = libelleDate(cible);
    if (d) return d;
    const i = cible.lastIndexOf("/");
    return i === -1 ? cible : cible.slice(i + 1);
  };
  return (p: Props) => {
    let node = p.node;
    const dom = el("a", "carnet-wikilien");
    dom.contentEditable = "false";
    dom.draggable = false;
    const rendre = () => {
      const { cible } = decomposer(node.attrs.valeur);
      const connue = contexte.titreDe(cible) != null;
      const date = !connue && RE_DATE.test(cible);
      dom.setAttribute("data-wikilien", node.attrs.valeur);
      dom.href = "/p/" + cible.split("/").map(encodeURIComponent).join("/");
      dom.classList.toggle("carnet-wikilien--inconnue", !connue && !date);
      dom.classList.toggle("carnet-wikilien--date", date);
      dom.title = connue ? `Ouvrir « ${libelle(node.attrs.valeur)} »` : date ? `Journal du ${cible}` : `Page introuvable : ${cible}`;
      dom.innerHTML = `<span class="carnet-wikilien__icone">${date ? ic.calendrier : icDivers.page}</span><span class="carnet-wikilien__texte"></span>`;
      (dom.lastChild as HTMLElement).textContent = libelle(node.attrs.valeur);
    };
    rendre();
    dom.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      contexte.ouvrirPage(decomposer(node.attrs.valeur).cible);
    });
    return {
      dom,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        node = n;
        rendre();
        return true;
      },
      ignoreMutation: () => true,
      stopEvent: (e: Event) => e.type === "click" || e.type === "mousedown" || e.type === "touchend",
    };
  };
}

// ------------------------------------------------------------------------------------------------ artefacts

/** Chemin relatif à artefacts/ d'une URL de lien, vue depuis le dossier de la page. */
export function cheminArtefact(dossier: string, url: string): string | null {
  const r = resoudre(dossier, url);
  if (!r) return null;
  const m = /^(?:.*\/)?artefacts\/(.+)$/.exec(r);
  if (!m || !r.startsWith("artefacts/")) return null;
  return m[1];
}

export function lienVersArtefact(dossier: string, chemin: string): string {
  const prof = dossier ? dossier.split("/").length : 0;
  return "../".repeat(prof) + "artefacts/" + chemin;
}

export function vueArtefact(contexte: ContexteEditeur) {
  return (p: Props) => {
    let node = p.node;
    const dom = el("div", "carnet-artefact", { contenteditable: "false" });
    const tete = el("div", "carnet-artefact__tete");
    const titre = el("span", "carnet-artefact__titre");
    const actions = el("span", "carnet-artefact__actions");
    const bPlein = el("button", "carnet-artefact__bouton", { type: "button" });
    bPlein.innerHTML = `${icDivers.pleinEcran}<span>Plein écran</span>`;
    const bOuvrir = el("a", "carnet-artefact__bouton carnet-artefact__bouton--icone", {
      target: "_blank", rel: "noopener noreferrer", title: "Ouvrir dans un onglet", "aria-label": "Ouvrir dans un onglet",
    });
    bOuvrir.innerHTML = icDivers.ouvrir;
    actions.append(bPlein, bOuvrir);
    tete.innerHTML = `<span class="carnet-artefact__icone">${ic.artefact}</span>`;
    tete.append(titre, actions);
    const corps = el("div", "carnet-artefact__corps");
    dom.append(tete, corps);

    let desinscrire: (() => void) | null = null;
    let iframe: HTMLIFrameElement | null = null;
    let observateur: IntersectionObserver | null = null;

    const rendre = () => {
      const chemin = cheminArtefact(contexte.dossier, String(node.attrs.url));
      titre.textContent = String(node.attrs.titre || chemin || "Artefact");
      dom.dataset.artefact = String(node.attrs.url);
      corps.replaceChildren();
      desinscrire?.();
      observateur?.disconnect();
      if (!chemin) {
        corps.innerHTML = `<p class="carnet-artefact__vide">Lien d'artefact invalide : il doit pointer vers le dossier artefacts/.</p>`;
        bPlein.hidden = true;
        bOuvrir.hidden = true;
        return;
      }
      const src = "/_art/" + chemin.split("/").map(encodeURIComponent).join("/");
      bOuvrir.href = src;
      bPlein.hidden = false;
      bOuvrir.hidden = false;
      bPlein.onclick = (e) => { e.preventDefault(); e.stopPropagation(); contexte.pleinEcranArtefact(chemin, titre.textContent || ""); };
      const charger = () => {
        if (iframe) return;
        iframe = el("iframe", "carnet-artefact__cadre", {
          sandbox: "allow-scripts allow-downloads", referrerpolicy: "no-referrer", title: titre.textContent || "Artefact", loading: "lazy",
        });
        iframe.src = src;
        iframe.addEventListener("load", () => {
          iframe?.contentWindow?.postMessage({ type: "hote:theme", theme: themeCadres() }, "*");
        });
        desinscrire = enregistrerCadre(iframe, (m) => {
          if (m.type === "artefact:hauteur" && iframe) {
            const h = Math.max(160, Math.min(1600, Number(m.h) || 0));
            iframe.style.height = `${h}px`;
          }
        });
        corps.replaceChildren(iframe);
      };
      iframe = null;
      corps.innerHTML = `<div class="carnet-artefact__attente">Chargement de l'aperçu…</div>`;
      observateur = new IntersectionObserver((entrees) => {
        if (entrees.some((e) => e.isIntersecting)) { observateur?.disconnect(); charger(); }
      }, { rootMargin: "300px" });
      observateur.observe(dom);
    };
    rendre();

    return {
      dom,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        const change = n.attrs.url !== node.attrs.url;
        node = n;
        if (change) rendre(); else titre.textContent = String(node.attrs.titre || "Artefact");
        return true;
      },
      stopEvent: (e: Event) => (e.target as Element)?.closest?.(".carnet-artefact__actions") != null,
      ignoreMutation: () => true,
      destroy: () => { desinscrire?.(); observateur?.disconnect(); },
    };
  };
}

// ------------------------------------------------------------------------------------------------ images

export function vueImageBloc(contexte: ContexteEditeur, choisirFichier: (pos: number) => void) {
  return (p: Props) => {
    let node = p.node;
    const { editor } = p;
    const dom = el("figure", "carnet-image");
    const cadre = el("div", "carnet-image__cadre", { contenteditable: "false" });
    const img = el("img", "carnet-image__img", { draggable: "false", loading: "lazy", decoding: "async" });
    const outils = el("div", "carnet-image__outils", { contenteditable: "false" });
    const bRemplacer = el("button", "carnet-image__outil", { type: "button", title: "Remplacer l'image", "aria-label": "Remplacer l'image" });
    bRemplacer.innerHTML = ic.remplacer;
    const bSuppr = el("button", "carnet-image__outil", { type: "button", title: "Supprimer l'image", "aria-label": "Supprimer l'image" });
    bSuppr.innerHTML = ic.corbeille;
    outils.append(bRemplacer, bSuppr);
    const attente = el("div", "carnet-image__attente");
    cadre.append(img, attente, outils);
    const legende = el("input", "carnet-image__legende", { placeholder: "Ajouter une légende", "aria-label": "Légende de l'image", spellcheck: "true" });
    const lg = el("figcaption", "carnet-image__lg", { contenteditable: "false" });
    lg.append(legende);
    dom.append(cadre, lg);

    const rendre = () => {
      const src = String(node.attrs.src || "");
      const envoi = node.attrs.envoi as string | null;
      dom.dataset.etat = envoi ? "envoi" : src ? "pret" : "vide";
      if (envoi) {
        img.removeAttribute("src");
        attente.innerHTML = `${ic.chargement}<span>Envoi de l'image…</span>`;
      } else if (!src) {
        img.removeAttribute("src");
        attente.innerHTML = `<button type="button" class="carnet-image__envoyer">${ic.envoyer}<span>Choisir une image</span></button><span class="carnet-image__aide">ou glisse-la ici, ou colle-la</span>`;
        attente.querySelector("button")!.addEventListener("click", (e) => { e.preventDefault(); const pos = posDe(p); if (pos != null) choisirFichier(pos); });
      } else {
        attente.replaceChildren();
        const u = contexte.urlFichier(src);
        if (img.getAttribute("src") !== u) img.src = u;
      }
      img.alt = String(node.attrs.alt ?? "");
      if (document.activeElement !== legende) legende.value = String(node.attrs.alt ?? "");
      lg.style.display = editor.isEditable || node.attrs.alt ? "" : "none";
    };
    img.addEventListener("error", () => { if (node.attrs.src) dom.dataset.etat = "erreur"; attente.textContent = `Image introuvable : ${node.attrs.src}`; });
    img.addEventListener("load", () => { if (dom.dataset.etat === "erreur") rendre(); });
    rendre();

    const poser = (attrs: Record<string, unknown>) => {
      const pos = posDe(p);
      if (pos == null) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs }));
    };
    legende.addEventListener("input", () => poser({ alt: legende.value.replace(/\n/g, " ") }));
    legende.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const pos = posDe(p);
        if (pos == null) return;
        const apres = pos + node.nodeSize;
        editor.chain().focus().insertContentAt(apres, { type: "paragraph" }).setTextSelection(apres + 1).run();
      }
    });
    bRemplacer.addEventListener("click", (e) => { e.preventDefault(); const pos = posDe(p); if (pos != null) choisirFichier(pos); });
    bSuppr.addEventListener("click", (e) => {
      e.preventDefault();
      const pos = posDe(p);
      if (pos == null) return;
      editor.chain().focus().deleteRange({ from: pos, to: pos + node.nodeSize }).run();
    });
    cadre.addEventListener("click", (e) => {
      if ((e.target as Element).closest("button")) return;
      const pos = posDe(p);
      if (pos == null) return;
      editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, pos)));
    });

    return {
      dom,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        node = n;
        rendre();
        return true;
      },
      selectNode: () => dom.classList.add("est-selectionne"),
      deselectNode: () => dom.classList.remove("est-selectionne"),
      stopEvent: (e: Event) => lg.contains(e.target as Node) || outils.contains(e.target as Node) || ((e.target as Element)?.closest?.(".carnet-image__envoyer") != null),
      ignoreMutation: () => true,
    };
  };
}

export function vueImageEnLigne(contexte: ContexteEditeur) {
  return (p: Props) => {
    let node = p.node;
    const img = el("img", "carnet-image-en-ligne", { draggable: "false" });
    const rendre = () => { img.src = contexte.urlFichier(String(node.attrs.src || "")); img.alt = String(node.attrs.alt ?? ""); };
    rendre();
    return { dom: img, update: (n: PMNode) => { if (n.type !== node.type) return false; node = n; rendre(); return true; }, ignoreMutation: () => true };
  };
}

// ------------------------------------------------------------------------------------------------ cases à cocher

export function vueElementListe() {
  return (p: Props) => {
    const { editor } = p;
    const node0 = p.node;
    const li = document.createElement("li");
    if (node0.attrs.checked == null) {
      return { dom: li, contentDOM: li, update: (n: PMNode) => n.type === node0.type && n.attrs.checked == null };
    }
    let node = node0;
    li.className = "carnet-tache";
    const caseEl = el("span", "carnet-tache__case", { contenteditable: "false" });
    const bouton = el("button", "carnet-tache__bouton", { type: "button", role: "checkbox" });
    caseEl.append(bouton);
    const contenu = el("div", "carnet-tache__contenu");
    li.append(caseEl, contenu);
    const rendre = () => {
      const c = Boolean(node.attrs.checked);
      li.dataset.coche = String(c);
      bouton.setAttribute("aria-checked", String(c));
      bouton.setAttribute("aria-label", c ? "Décocher la tâche" : "Cocher la tâche");
      bouton.innerHTML = c ? CASE_COCHEE : CASE_VIDE;
    };
    rendre();
    const basculer = (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      if (!editor.isEditable) return;
      const pos = posDe(p);
      if (pos == null) return;
      const n = editor.state.doc.nodeAt(pos);
      if (!n) return;
      editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...n.attrs, checked: !n.attrs.checked }));
    };
    bouton.addEventListener("mousedown", (e) => e.preventDefault());
    bouton.addEventListener("click", basculer);
    return {
      dom: li,
      contentDOM: contenu,
      update: (n: PMNode) => {
        if (n.type !== node.type || n.attrs.checked == null) return false;
        node = n;
        rendre();
        return true;
      },
      stopEvent: (e: Event) => caseEl.contains(e.target as Node),
      ignoreMutation: (m: { type: string; target: Node }) => m.type !== "selection" && caseEl.contains(m.target),
    };
  };
}

// ------------------------------------------------------------------------------------------------ repliables

export function vueRepliable(contexte: ContexteEditeur) {
  const cleDe = (n: PMNode) => `carnet:pli:${contexte.chemin}:${n.firstChild?.textContent ?? ""}`;
  return (p: Props) => {
    let node = p.node;
    const { editor } = p;
    const dom = el("div", "carnet-repliable", { "data-type": "details" });
    const bouton = el("button", "carnet-repliable__bascule", { type: "button", contenteditable: "false" });
    bouton.innerHTML = ic.chevronDroite;
    const contenu = el("div", "carnet-repliable__corps");
    dom.append(bouton, contenu);
    let ouvert = Boolean(node.attrs.ouvert);
    try {
      const m = localStorage.getItem(cleDe(node));
      if (m === "1" || m === "0") ouvert = m === "1";
    } catch { /* stockage indisponible */ }
    // un repliable qu'on vient de créer (vide) est ouvert, pour écrire dedans
    if (node.child(0).textContent === "" && node.child(1).textContent === "") ouvert = true;
    const appliquer = () => {
      dom.classList.toggle("est-ouvert", ouvert);
      bouton.setAttribute("aria-expanded", String(ouvert));
      bouton.setAttribute("aria-label", ouvert ? "Replier" : "Déplier");
      const c = contenu.querySelector(':scope > div[data-type="detailsContent"]');
      if (c) c.toggleAttribute("hidden", !ouvert);
    };
    queueMicrotask(appliquer);
    dom.addEventListener("carnet:ouvrir", () => { ouvert = true; appliquer(); });
    bouton.addEventListener("mousedown", (e) => e.preventDefault());
    bouton.addEventListener("click", (e) => {
      e.preventDefault();
      ouvert = !ouvert;
      appliquer();
      try { localStorage.setItem(cleDe(node), ouvert ? "1" : "0"); } catch { /* idem */ }
      if (ouvert) {
        // curseur dans le contenu quand on ouvre un repliable vide
        const pos = posDe(p);
        const c = node.child(1);
        if (pos != null && editor.isEditable && c.textContent === "" && c.childCount === 1) {
          const cible = pos + 1 + node.child(0).nodeSize + 1;
          editor.chain().focus().setTextSelection(cible + 1).run();
        }
      }
    });
    return {
      dom,
      contentDOM: contenu,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        node = n;
        queueMicrotask(appliquer);
        return true;
      },
      ouvrir: () => { ouvert = true; appliquer(); },
      stopEvent: (e: Event) => bouton.contains(e.target as Node),
      ignoreMutation: (m: { type: string; target: Node }) => {
        if (m.type === "selection") return false;
        return bouton.contains(m.target) || m.target === dom || (m.type === "attributes" && (m.target as Element).getAttribute?.("data-type") === "detailsContent");
      },
    };
  };
}

/** Contenu d'un repliable : caché tant que le repliable est fermé (géré par la vue du repliable). */
export function vueContenuRepliable() {
  return (p: Props) => {
    const dom = el("div", "carnet-repliable__contenu", { "data-type": "detailsContent" });
    return {
      dom,
      contentDOM: dom,
      update: (n: PMNode) => n.type === p.node.type,
      ignoreMutation: (m: { type: string; target: Node }) => m.type !== "selection" && (m.target === dom && m.type === "attributes"),
    };
  };
}

// ------------------------------------------------------------------------------------------------ blocs de code

const hauteursApercu = new Map<string, number>();
const vuesCode = new Set<{ verifierSelection: () => void }>();

export function surSelectionCode(): void {
  for (const v of vuesCode) v.verifierSelection();
}

export function vueCode(contexte: ContexteEditeur, magasin: Magasin) {
  return (p: Props) => {
    let node = p.node;
    const { editor } = p;
    const dom = el("div", "carnet-code");
    const tete = el("div", "carnet-code__tete", { contenteditable: "false" });
    const bLangue = el("button", "carnet-code__langue", { type: "button", title: "Choisir le langage" });
    const espace = el("span", "carnet-code__espace");
    const bBascule = el("button", "carnet-code__bouton", { type: "button" });
    const bCopier = el("button", "carnet-code__bouton", { type: "button", title: "Copier le code" });
    bCopier.innerHTML = `${ic.copier}<span>Copier</span>`;
    tete.append(bLangue, espace, bBascule, bCopier);
    const pre = el("pre", "carnet-code__pre", { spellcheck: "false" });
    const code = el("code");
    pre.append(code);
    const apercu = el("div", "carnet-apercu", { contenteditable: "false" });
    dom.append(tete, pre, apercu);

    let mode: "apercu" | "code" = "apercu";
    let iframe: HTMLIFrameElement | null = null;
    let pret = false;
    let envoye: string | null = null;
    let desinscrire: (() => void) | null = null;
    let minuterie: number | null = null;
    const erreur = el("div", "carnet-apercu__erreur");
    erreur.hidden = true;
    const indice = el("div", "carnet-apercu__indice");
    indice.textContent = "Fais glisser pour voir tout le schéma";

    const envoyer = () => {
      const t = typeApercu(node.attrs.language);
      if (!t || !iframe || !pret) return;
      const spec = node.textContent;
      if (spec === envoye) return;
      envoye = spec;
      const h = hauteursApercu.get(spec);
      if (h) iframe.style.height = `${h}px`;
      iframe.contentWindow?.postMessage({ type: t, spec, theme: themeCadres() }, "*");
    };

    const creerCadre = (t: "mermaid" | "vega-lite") => {
      desinscrire?.();
      iframe = el("iframe", "carnet-apercu__cadre", {
        sandbox: "allow-scripts", referrerpolicy: "no-referrer", scrolling: "no",
        title: t === "mermaid" ? "Aperçu du schéma" : "Aperçu du graphique",
      });
      iframe.src = `${contexte.artBase}/rendu/${t}`;
      pret = false;
      envoye = null;
      apercu.replaceChildren(iframe, erreur, indice);
      const f = iframe;
      desinscrire = enregistrerCadre(f, (m) => {
        switch (m.type) {
          case "rendu:pret": pret = true; envoyer(); break;
          case "artefact:hauteur": {
            const h = Math.max(48, Math.min(2400, Number(m.h) || 0));
            f.style.height = `${h}px`;
            if (envoye != null) hauteursApercu.set(envoye, h);
            break;
          }
          case "rendu:largeur": {
            const w = Number(m.w) || 0;
            const dispo = apercu.getBoundingClientRect().width || f.getBoundingClientRect().width;
            const defile = w > 0 && dispo > 0 && dispo / w < 0.55;
            f.style.minWidth = defile ? `${Math.min(Math.round(dispo / 0.55), 4000)}px` : "";
            apercu.classList.toggle("carnet-apercu--defile", defile);
            break;
          }
          case "rendu:erreur":
            erreur.hidden = false;
            erreur.textContent = `Le rendu a échoué : ${String(m.message ?? "erreur inconnue").slice(0, 300)}`;
            break;
          case "rendu:ok":
            erreur.hidden = true;
            break;
        }
      });
    };

    // le cadre d'aperçu n'est créé qu'à l'approche de l'écran (ouverture de page plus rapide)
    let visible = false;
    let observateur: IntersectionObserver | null = null;
    const rendre = () => {
      const langue = node.attrs.language as string | null;
      const t = typeApercu(langue);
      dom.dataset.langue = langue ?? "";
      bLangue.innerHTML = `<span></span>${ic.chevron}`;
      (bLangue.firstChild as HTMLElement).textContent = libelleLangue(langue);
      if (t) {
        dom.dataset.apercu = t;
        dom.dataset.mode = mode;
        bBascule.hidden = false;
        bBascule.innerHTML = mode === "apercu" ? `${ic.accolades}<span>Modifier le code</span>` : `${ic.oeil}<span>Aperçu seul</span>`;
        if (!visible) {
          if (!observateur) {
            observateur = new IntersectionObserver((e) => {
              if (!e.some((x) => x.isIntersecting)) return;
              visible = true;
              observateur?.disconnect();
              observateur = null;
              rendre();
            }, { rootMargin: "600px" });
            observateur.observe(dom);
          }
          apercu.style.minHeight = `${hauteursApercu.get(node.textContent) ?? 160}px`;
        } else if (!iframe || apercu.dataset.type !== t) { apercu.style.minHeight = ""; apercu.dataset.type = t; creerCadre(t); }
        if (minuterie) window.clearTimeout(minuterie);
        minuterie = window.setTimeout(envoyer, 350);
      } else {
        delete dom.dataset.apercu;
        delete dom.dataset.mode;
        bBascule.hidden = true;
        if (iframe) { desinscrire?.(); desinscrire = null; iframe = null; apercu.replaceChildren(); delete apercu.dataset.type; }
      }
    };
    rendre();

    bLangue.addEventListener("mousedown", (e) => e.preventDefault());
    bLangue.addEventListener("click", (e) => {
      e.preventDefault();
      if (!editor.isEditable) return;
      magasin.maj({
        langue: {
          ancre: rectDe(bLangue)!,
          actuelle: node.attrs.language ?? null,
          choisir: (l) => {
            const pos = posDe(p);
            if (pos == null) return;
            editor.view.dispatch(editor.state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, language: l }));
            editor.view.focus();
          },
        },
      });
    });
    bBascule.addEventListener("mousedown", (e) => e.preventDefault());
    bBascule.addEventListener("click", (e) => {
      e.preventDefault();
      mode = mode === "apercu" ? "code" : "apercu";
      rendre();
      if (mode === "code") {
        const pos = posDe(p);
        if (pos != null && editor.isEditable) editor.chain().focus().setTextSelection(pos + 1 + node.content.size).run();
      }
    });
    bCopier.addEventListener("mousedown", (e) => e.preventDefault());
    bCopier.addEventListener("click", async (e) => {
      e.preventDefault();
      try {
        await navigator.clipboard.writeText(node.textContent);
        bCopier.innerHTML = `${ic.valider}<span>Copié</span>`;
        window.setTimeout(() => { bCopier.innerHTML = `${ic.copier}<span>Copier</span>`; }, 1500);
      } catch { magasin.editeur && contexte.notifier?.("Copie impossible dans ce navigateur"); }
    });

    const moi = {
      verifierSelection: () => {
        if (!typeApercu(node.attrs.language)) return;
        const pos = posDe(p);
        if (pos == null) return;
        const { from, to } = editor.state.selection;
        const dedans = from > pos && to < pos + node.nodeSize;
        if (dedans && mode === "apercu" && editor.isFocused) { mode = "code"; rendre(); }
      },
    };
    vuesCode.add(moi);

    return {
      dom,
      contentDOM: code,
      update: (n: PMNode) => {
        if (n.type !== node.type) return false;
        node = n;
        rendre();
        return true;
      },
      stopEvent: (e: Event) => tete.contains(e.target as Node) || apercu.contains(e.target as Node),
      ignoreMutation: (m: { type: string; target: Node }) => m.type !== "selection" && (tete.contains(m.target) || apercu.contains(m.target) || m.target === dom),
      destroy: () => { desinscrire?.(); observateur?.disconnect(); vuesCode.delete(moi); if (minuterie) window.clearTimeout(minuterie); },
    };
  };
}

// ------------------------------------------------------------------------------------------------ sommaire

export function vueSommaire() {
  return (p: Props) => {
    const { editor } = p;
    const dom = el("nav", "carnet-sommaire", { contenteditable: "false", "aria-label": "Sommaire" });
    const rendre = () => {
      const titres: Array<{ niveau: number; texte: string; pos: number }> = [];
      editor.state.doc.descendants((n, pos) => {
        if (n.type.name === "heading" && n.attrs.level <= 3 && n.textContent.trim()) titres.push({ niveau: n.attrs.level, texte: n.textContent, pos });
        return n.type.name !== "codeBlock";
      });
      const cle = JSON.stringify(titres.map((t) => [t.niveau, t.texte]));
      if (dom.dataset.cle === cle) return;
      dom.dataset.cle = cle;
      dom.innerHTML = `<div class="carnet-sommaire__tete">${ic.sommaire}<span>Sommaire</span></div>`;
      if (!titres.length) {
        const v = el("p", "carnet-sommaire__vide");
        v.textContent = "Ajoute des titres à la page : ils apparaîtront ici.";
        dom.append(v);
        return;
      }
      const min = Math.min(...titres.map((t) => t.niveau));
      const liste = el("ol", "carnet-sommaire__liste");
      titres.forEach((t, i) => {
        const li = el("li", "", { "data-niveau": String(t.niveau - min + 1) });
        const a = el("a", "carnet-sommaire__lien", { href: "#" });
        a.textContent = t.texte;
        a.addEventListener("click", (e) => {
          e.preventDefault();
          let k = -1;
          let cible: number | null = null;
          editor.state.doc.descendants((n, pos) => {
            if (n.type.name === "heading" && n.attrs.level <= 3 && n.textContent.trim()) { k++; if (k === i) cible = pos; }
            return n.type.name !== "codeBlock";
          });
          if (cible == null) return;
          const d = editor.view.nodeDOM(cible) as HTMLElement | null;
          d?.scrollIntoView({ behavior: "smooth", block: "start" });
          d?.classList.add("carnet-flash");
          window.setTimeout(() => d?.classList.remove("carnet-flash"), 1600);
        });
        li.append(a);
        liste.append(li);
      });
      dom.append(liste);
    };
    rendre();
    const f = () => rendre();
    editor.on("update", f);
    return {
      dom,
      update: (n: PMNode) => n.type === p.node.type,
      ignoreMutation: () => true,
      stopEvent: (e: Event) => (e.target as Element)?.closest?.("a") != null,
      destroy: () => { editor.off("update", f); },
    };
  };
}

export type { Editor };
