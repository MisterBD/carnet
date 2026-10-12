// Lot 1 « Aujourd'hui » : tâches datées dans l'éditeur (format Obsidian Tasks : 📅 échéance, ⏫ priorité, 🔁 récurrence…).
//
// Principe : DÉCORATIONS seulement. Le document (donc le fichier) ne change pas tant que la personne ne modifie pas la
// tâche : hors saisie, les marqueurs reconnus sont masqués à l'écran et remplacés par des pastilles (date relative
// cliquable avec sélecteur, priorité, « chaque semaine » pour la récurrence, statut « en cours » / « annulée »,
// anomalie visible) ; dès que le curseur entre dans la tâche, le texte brut réapparaît, tel qu'il est dans le fichier.
// Une ligne avec une anomalie (date invalide, marqueur en double) n'est jamais masquée ni « réparée ».
// Modifier l'échéance ou la priorité passe par `modifierTache` (socle) sur la ligne reconstituée : seule la portion
// changée du texte est remplacée. Cocher une tâche au format Tasks ajoute `✅ <date du jour>` ; la décocher le retire
// (demande explicite). La récurrence est affichée et conservée, jamais exécutée.
import { Extension } from "@tiptap/core";
import type { Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState, type Transaction } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import { analyserTache, modifierTache, type TacheAnalysee } from "../../../shared/taches.ts";
import {
  resumerAnomalie, dateDuJour, dateEnToutesLettres, demanderDate, demanderPriorite, libelleDate, libellePriorite, libelleRecurrence, libelleStatut,
  messageRefusTache, tonEcheance, tonPriorite,
} from "../taches-ui";
import type { Priorite } from "../api";

interface EtatPlugin { focus: boolean; decos: DecorationSet }
const cle = new PluginKey<EtatPlugin>("carnetTachesDatees");
const META_INTERNE = "carnetTachesDateesInterne";
/** Caractère qui tient la place d'un nœud en ligne non textuel (lien de page, image) dans la ligne reconstituée. */
const OBJET = "￼";

/** Marqueurs masqués hors saisie (les autres, étiquettes, 🆔, ⛔, `^id`, restent visibles tels quels). */
const MASQUABLES = new Set(["echeance", "prevue", "debut", "creee", "faite", "annulee", "priorite", "recurrence"]);

interface TacheDoc {
  /** Position du paragraphe (avant son ouverture). */
  pos: number;
  para: PMNode;
  /** Texte reconstitué du paragraphe et position doc de chaque unité UTF-16. */
  texte: string;
  positions: number[];
  /** Préfixe Markdown reconstitué : « - [ ] », « - [x] » ou « - » (statut personnalisé écrit dans le texte). */
  prefixe: string;
  analyse: TacheAnalysee;
}

function texteEtPositions(para: PMNode, pos: number): { texte: string; positions: number[] } {
  let texte = "";
  const positions: number[] = [];
  para.forEach((enfant, decalage) => {
    const debut = pos + 1 + decalage;
    if (enfant.isText) {
      const t = enfant.text ?? "";
      for (let i = 0; i < t.length; i++) positions.push(debut + i);
      texte += t;
    } else {
      positions.push(debut);
      texte += OBJET;
    }
  });
  return { texte, positions };
}

/** Tâches du document : élément de liste coché/décochable, ou élément de liste dont le texte commence par « [c] ». */
function taches(doc: PMNode): TacheDoc[] {
  const res: TacheDoc[] = [];
  doc.descendants((n, pos) => {
    if (n.type.name !== "listItem") return true;
    const para = n.firstChild;
    if (!para || para.type.name !== "paragraph") return true;
    const pPos = pos + 1;
    const { texte, positions } = texteEtPositions(para, pPos);
    let prefixe: string;
    if (n.attrs.checked != null) prefixe = n.attrs.checked ? "- [x] " : "- [ ] ";
    else if (/^\[[^\]\n]\] /u.test(texte)) prefixe = "- ";
    else return true;
    const analyse = analyserTache(prefixe + texte);
    if (analyse) res.push({ pos: pPos, para, texte, positions, prefixe, analyse });
    return true;
  });
  return res;
}

function aDesMarqueurs(a: TacheAnalysee): boolean {
  return Boolean(a.echeance || a.prevue || a.debut || a.creee || a.faite || a.annulee || a.priorite || a.recurrence !== undefined);
}

/** Remplace dans le paragraphe la seule portion qui diffère entre l'ancienne et la nouvelle ligne. */
function appliquerLigne(tr: Transaction, t: TacheDoc, nouvelle: string): boolean {
  const ancienne = t.prefixe + t.texte;
  if (nouvelle === ancienne) return false;
  if (!nouvelle.startsWith(t.prefixe)) throw new Error("le début de la tâche a changé : modification refusée");
  const a = t.texte;
  const b = nouvelle.slice(t.prefixe.length);
  let debut = 0;
  while (debut < a.length && debut < b.length && a[debut] === b[debut]) debut++;
  let finA = a.length;
  let finB = b.length;
  while (finA > debut && finB > debut && a[finA - 1] === b[finB - 1]) { finA--; finB--; }
  const retire = a.slice(debut, finA);
  const ajoute = b.slice(debut, finB);
  if (retire.includes(OBJET) || ajoute.includes(OBJET)) throw new Error("la tâche contient un lien ou une image à cet endroit : modifie-la au clavier");
  const de = debut < t.positions.length ? t.positions[debut] : t.pos + 1 + t.para.content.size;
  const a2 = finA < t.positions.length ? t.positions[finA] : t.pos + 1 + t.para.content.size;
  const debutDoc = tr.mapping.map(de);
  const finDoc = tr.mapping.map(a2);
  if (ajoute) tr.insertText(ajoute, debutDoc, finDoc);
  else tr.delete(debutDoc, finDoc);
  return true;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, classe: string, texte?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = classe;
  if (texte !== undefined) e.textContent = texte;
  return e;
}

/** Modifie la tâche située au paragraphe `pos` (s'il y est toujours) avec `modifierTache`. */
function modifier(view: EditorView, pos: number, changements: Parameters<typeof modifierTache>[1], notifier: (m: string) => void): void {
  const t = taches(view.state.doc).find((x) => x.pos === pos);
  if (!t) return;
  try {
    const nouvelle = modifierTache(t.prefixe + t.texte, changements);
    const tr = view.state.tr;
    if (appliquerLigne(tr, t, nouvelle)) view.dispatch(tr.setMeta(META_INTERNE, true));
  } catch (e) {
    notifier(`Tâche non modifiée : ${messageRefusTache(e)}`);
  }
}

function bouton(classe: string, texte: string, ton: string, etiquette: string, faire: () => void): HTMLButtonElement {
  const b = el("button", `pastille-tache ${classe}`, texte);
  b.type = "button";
  b.dataset.ton = ton;
  b.setAttribute("aria-label", etiquette);
  b.title = etiquette;
  b.addEventListener("mousedown", (e) => e.preventDefault());
  b.addEventListener("click", (e) => { e.preventDefault(); e.stopPropagation(); faire(); });
  return b;
}

function pastilles(view: EditorView, t: TacheDoc, enSaisie: boolean, notifier: (m: string) => void): HTMLElement {
  const a = t.analyse;
  const jour = dateDuJour();
  const box = el("span", "carnet-pastilles-tache");
  box.contentEditable = "false";
  const pos = t.pos;
  const changerDate = () => {
    if (!view.editable) return; // page verrouillée (lot 6)
    void demanderDate({ titre: "Échéance", valeur: a.echeance ?? null }).then((v) => {
      if (v === undefined || v === (a.echeance ?? null)) return;
      modifier(view, pos, { echeance: v }, notifier);
    });
  };
  const changerPriorite = () => {
    if (!view.editable) return;
    void demanderPriorite((a.priorite as Priorite | undefined) ?? null).then((p) => {
      if (p === undefined || p === (a.priorite ?? null)) return;
      modifier(view, pos, { priorite: p }, notifier);
    });
  };
  if (enSaisie) {
    box.append(bouton("carnet-pastille-ajout", "📅", "gris", a.echeance ? "Changer l'échéance" : "Ajouter une échéance", changerDate));
    box.append(bouton("carnet-pastille-ajout", "⚑", "gris", a.priorite ? "Changer la priorité" : "Ajouter une priorité", changerPriorite));
    return box;
  }
  const statut = libelleStatut(a.coche);
  if (statut && t.prefixe === "- ") {
    const s = el("span", "pastille-tache", statut);
    s.dataset.ton = a.coche === "/" ? "bleu" : "gris";
    box.append(s);
  }
  if (a.echeance) {
    box.append(bouton("", `📅 ${libelleDate(a.echeance, jour)}`, a.coche === " " || a.coche === "/" ? tonEcheance(a.echeance, jour) : "gris",
      `Échéance : ${dateEnToutesLettres(a.echeance)}. Changer`, changerDate));
  }
  if (a.prevue && !a.echeance) {
    const s = el("span", "pastille-tache", `⏳ ${libelleDate(a.prevue, jour)}`);
    s.dataset.ton = "gris";
    s.title = `Prévue le ${dateEnToutesLettres(a.prevue)}`;
    box.append(s);
  }
  if (a.priorite) {
    box.append(bouton("", `${libellePriorite(a.priorite)}`, tonPriorite(a.priorite), `Priorité ${libellePriorite(a.priorite)}. Changer`, changerPriorite));
  }
  if (a.recurrence !== undefined) {
    const s = el("span", "pastille-tache", `🔁 ${libelleRecurrence(a.recurrence)}`);
    s.dataset.ton = "violet";
    s.title = "Récurrence conservée telle quelle : Carnet ne crée pas encore l'occurrence suivante.";
    box.append(s);
  }
  if (a.faite) {
    const s = el("span", "pastille-tache", `✅ ${libelleDate(a.faite, jour)}`);
    s.dataset.ton = "vert";
    s.title = `Terminée le ${dateEnToutesLettres(a.faite)}`;
    box.append(s);
  }
  if (a.annulee) {
    const s = el("span", "pastille-tache", `❌ ${libelleDate(a.annulee, jour)}`);
    s.dataset.ton = "gris";
    s.title = `Annulée le ${dateEnToutesLettres(a.annulee)}`;
    box.append(s);
  }
  for (const an of a.anomalies) {
    const s = el("span", "pastille-tache", `⚠ ${resumerAnomalie(an)}`);
    s.dataset.ton = "anomalie";
    s.title = `${an}. Laissé tel quel dans le fichier, rien n'est réparé automatiquement.`;
    box.append(s);
  }
  return box;
}

function decorer(state: EditorState, focus: boolean, notifier: (m: string) => void): DecorationSet {
  const decos: Decoration[] = [];
  const { from, to } = state.selection;
  for (const t of taches(state.doc)) {
    const finPara = t.pos + 1 + t.para.content.size;
    // « En saisie » : le curseur (ou la sélection) est dans le texte de la tâche ET l'éditeur a le focus.
    const enSaisie = focus && from <= finPara && to >= t.pos + 1;
    const a = t.analyse;
    const marqueurs = aDesMarqueurs(a);
    const statutPerso = t.prefixe === "- " && libelleStatut(a.coche) !== null;
    if (!marqueurs && !statutPerso && !a.anomalies.length && !enSaisie) continue;
    // Marqueurs masqués hors saisie, seulement si la ligne n'a aucune anomalie (sinon tout reste visible, brut).
    if (!enSaisie && !a.anomalies.length && marqueurs) {
      // Décalages fournis par l'analyse du socle (dans la ligne reconstituée « préfixe + texte »)
      const dec = t.prefixe.length;
      for (const m of a.marqueurs) {
        if (!MASQUABLES.has(m.type)) continue;
        const i = m.debutEspace - dec; // l'espace qui précède le marqueur est masqué avec lui (pas de blanc barré)
        const j = m.fin - dec;
        if (i < 0 || j <= i || j > t.texte.length || t.texte.slice(i, j).includes(OBJET)) continue;
        const de = t.positions[i];
        const a2 = j < t.positions.length ? t.positions[j] : finPara;
        decos.push(Decoration.inline(de, a2, { class: "carnet-marqueur-masque" }));
      }
    }
    if (marqueurs || statutPerso || a.anomalies.length || enSaisie) {
      const p = t.pos;
      const cleW = `tache:${p}:${enSaisie ? "s" : "v"}:${t.texte}`;
      decos.push(Decoration.widget(finPara, (view) => pastilles(view, taches(view.state.doc).find((x) => x.pos === p) ?? t, enSaisie, notifier), {
        side: 1, key: cleW, ignoreSelection: true, stopEvent: () => true,
      }));
    }
  }
  return DecorationSet.create(state.doc, decos);
}

/** Cocher (décocher) une tâche au format Tasks ajoute (retire) `✅ <date du jour>`, en une seule étape d'annulation. */
function clotures(trs: readonly Transaction[], avant: EditorState, apres: EditorState): Transaction | null {
  if (!trs.some((tr) => tr.docChanged) || trs.some((tr) => tr.getMeta(META_INTERNE))) return null;
  let mapping = trs[0].mapping.slice(0);
  for (let i = 1; i < trs.length; i++) mapping.appendMapping(trs[i].mapping);
  const basculees = new Map<number, boolean>();
  avant.doc.descendants((n, pos) => {
    if (n.type.name !== "listItem" || n.attrs.checked == null) return true;
    const r = mapping.mapResult(pos, 1);
    if (r.deleted) return true;
    const m = apres.doc.nodeAt(r.pos);
    if (m && m.type.name === "listItem" && m.attrs.checked != null && Boolean(m.attrs.checked) !== Boolean(n.attrs.checked)
      && m.firstChild?.textContent === n.firstChild?.textContent) basculees.set(r.pos + 1, Boolean(m.attrs.checked));
    return true;
  });
  if (!basculees.size) return null;
  const tr = apres.tr;
  let change = false;
  for (const t of taches(apres.doc)) {
    const coche = basculees.get(t.pos);
    if (coche === undefined) continue;
    const a = t.analyse;
    if (coche && !aDesMarqueurs(a)) continue;      // simple case à cocher : on n'ajoute rien
    if (!coche && !a.faite) continue;
    try {
      const nouvelle = modifierTache(t.prefixe + t.texte, coche ? { faite: dateDuJour() } : { faite: null });
      change = appliquerLigne(tr, t, nouvelle) || change;
    } catch { /* marqueur ✅ en double ou ligne ambiguë : on ne touche à rien */ }
  }
  return change ? tr.setMeta(META_INTERNE, true) : null;
}

/** Extension Tiptap (à ajouter à la liste des extensions de l'éditeur). */
export function extensionTachesDatees(notifier: (m: string) => void) {
  return Extension.create({
    name: "carnetTachesDatees",
    addProseMirrorPlugins() {
      return [
        new Plugin<EtatPlugin>({
          key: cle,
          state: {
            init: (_c, state) => ({ focus: false, decos: decorer(state, false, notifier) }),
            apply: (tr, ancien, _a, nouveau) => {
              const f = tr.getMeta(cle) as { focus: boolean } | undefined;
              const focus = f ? f.focus : ancien.focus;
              if (!f && !tr.docChanged && !tr.selectionSet) return ancien;
              return { focus, decos: decorer(nouveau, focus, notifier) };
            },
          },
          props: {
            decorations: (state) => cle.getState(state)?.decos,
            handleDOMEvents: {
              focus: (view) => { view.dispatch(view.state.tr.setMeta(cle, { focus: true }).setMeta("addToHistory", false)); return false; },
              blur: (view) => {
                // après le clic éventuel sur une pastille (qui garde le focus) : rien ne bouge pendant le geste
                window.setTimeout(() => { if (!view.isDestroyed && !view.hasFocus()) view.dispatch(view.state.tr.setMeta(cle, { focus: false }).setMeta("addToHistory", false)); }, 0);
                return false;
              },
            },
          },
          appendTransaction: (trs, avant, apres) => clotures(trs, avant, apres),
        }),
      ];
    },
  });
}

// Exporté pour les tests unitaires éventuels (aucun effet de bord).
export const _interne = { taches, appliquerLigne };
