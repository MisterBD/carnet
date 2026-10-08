// Bulle de mise en forme (sélection, ordinateur), édition de lien, choix du langage, barre d'outils des tableaux.
import { useEffect, useRef, useState } from "react";
import {
  Bold, Italic, Underline, Strikethrough, Code, Highlighter, Baseline, Link2, ChevronDown, ExternalLink, Pencil, Unlink,
  Check, Search, BetweenHorizontalEnd, BetweenVerticalEnd, Rows3, Columns3, AlignLeft, AlignCenter, AlignRight, Trash2,
} from "lucide-react";
import { NodeSelection } from "@tiptap/pm/state";
import type { Editor } from "@tiptap/core";
import type { Magasin, Rect } from "./magasin";
import { rectDe } from "./magasin";
import { useMagasin, Palette, garderFocus, sansFocus, tactile, ICONES } from "./communs";
import { usePosition } from "./position";
import { colorerSelection, transformer, blocCourant, type Cible } from "../blocs";
import { LANGUES } from "../langues";
import { plier } from "../../../../shared/page.ts";

const mac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const m = mac ? "⌘" : "Ctrl+";

function typeCourant(ed: Editor): { cle: Cible; nom: string } {
  if (ed.isActive("heading", { level: 1 })) return { cle: "h1", nom: "Titre 1" };
  if (ed.isActive("heading", { level: 2 })) return { cle: "h2", nom: "Titre 2" };
  if (ed.isActive("heading", { level: 3 })) return { cle: "h3", nom: "Titre 3" };
  if (ed.isActive("codeBlock")) return { cle: "code", nom: "Code" };
  if (ed.isActive("listItem")) {
    const { $from } = ed.state.selection;
    for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === "listItem") {
      if ($from.node(d).attrs.checked != null) return { cle: "tache", nom: "Tâche" };
      break;
    }
    return ed.isActive("orderedList") ? { cle: "numeros", nom: "Liste numérotée" } : { cle: "puces", nom: "Liste à puces" };
  }
  if (ed.isActive("blockquote")) return { cle: "citation", nom: "Citation" };
  return { cle: "texte", nom: "Texte" };
}

// ------------------------------------------------------------------------------------------------ bulle

export function BulleFormat({ magasin }: { magasin: Magasin }) {
  const etat = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const [sous, setSous] = useState<null | "type" | "couleur">(null);
  const ed = magasin.editeur;
  const sel = ed?.state.selection;
  const visible = Boolean(ed && sel && !tactile && etat.focus && !sel.empty && !(sel instanceof NodeSelection)
    && !etat.slash.ouvert && !etat.menuBloc && !(etat.lien?.edition) && !ed.isActive("codeBlock") && !ed.isActive("blocBrut")
    && !ed.view.dragging && ed.state.doc.textBetween(sel.from, sel.to, " ").trim().length > 0);
  let ancre: Rect | null = null;
  if (visible && ed && sel) {
    const a = ed.view.coordsAtPos(sel.from);
    const b = ed.view.coordsAtPos(sel.to);
    const gauche = Math.min(a.left, b.left);
    const droite = a.top === b.top ? Math.max(a.right, b.right) : gauche + 40;
    ancre = { left: gauche, right: droite, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), width: droite - gauche, height: Math.max(a.bottom, b.bottom) - Math.min(a.top, b.top) };
  }
  const pos = usePosition(ref, ancre, "top-start", 8, sous);
  useEffect(() => { if (!visible) setSous(null); }, [visible]);
  if (!visible || !ed) return null;

  const t = typeCourant(ed);
  const actif = (nom: string) => ed.isActive(nom);
  const bouton = (nom: string, titre: string, Ic: typeof Bold, f: () => void) => (
    <button type="button" className="carnet-bulle__bouton" data-actif={actif(nom)} aria-pressed={actif(nom)} title={titre} aria-label={titre}
      onPointerDown={garderFocus} onClick={f}><Ic size={17} strokeWidth={2.1} /></button>
  );
  const couleurTexte = ed.getAttributes("couleurTexte").c as string | undefined;
  const couleurFond = ed.getAttributes("couleurFond").c as string | undefined;

  return (
    <div ref={ref} className="carnet-bulle" role="toolbar" aria-label="Mise en forme" onMouseDown={sansFocus}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      <div className="carnet-bulle__ligne">
        <button type="button" className="carnet-bulle__type" onPointerDown={garderFocus} onClick={() => setSous(sous === "type" ? null : "type")}
          aria-expanded={sous === "type"} title="Transformer en">
          {t.nom} <ChevronDown size={14} />
        </button>
        <span className="carnet-bulle__sep" />
        {bouton("bold", `Gras (${m}B)`, Bold, () => ed.chain().focus().toggleBold().run())}
        {bouton("italic", `Italique (${m}I)`, Italic, () => ed.chain().focus().toggleItalic().run())}
        {bouton("underline", `Souligné (${m}U)`, Underline, () => ed.chain().focus().toggleUnderline().run())}
        {bouton("strike", `Barré (${m}⇧S)`, Strikethrough, () => ed.chain().focus().toggleStrike().run())}
        {bouton("code", `Code (${m}E)`, Code, () => ed.chain().focus().toggleCode().run())}
        {bouton("highlight", `Surligner (${m}⇧H)`, Highlighter, () => ed.chain().focus().toggleHighlight().run())}
        <button type="button" className="carnet-bulle__bouton" data-actif={Boolean(couleurTexte || couleurFond)} title="Couleur" aria-label="Couleur"
          aria-expanded={sous === "couleur"} onPointerDown={garderFocus} onClick={() => setSous(sous === "couleur" ? null : "couleur")}>
          <Baseline size={17} strokeWidth={2.1} />
        </button>
        <span className="carnet-bulle__sep" />
        <button type="button" className="carnet-bulle__bouton" data-actif={actif("link")} title={`Lien (${m}K)`} aria-label="Lien"
          onPointerDown={garderFocus} onClick={() => {
            const { from, to } = ed.state.selection;
            const a = ed.view.coordsAtPos(from); const b = ed.view.coordsAtPos(to);
            magasin.maj({ lien: { ancre: { left: a.left, top: a.top, right: b.right, bottom: b.bottom, width: Math.max(1, b.right - a.left), height: b.bottom - a.top }, href: (ed.getAttributes("link").href as string) ?? "", edition: true, from, to } });
          }}>
          <Link2 size={17} strokeWidth={2.1} />
        </button>
      </div>
      {sous === "type" && (
        <div className="carnet-bulle__sous">
          {([["texte", "Texte", "texte"], ["h1", "Titre 1", "h1"], ["h2", "Titre 2", "h2"], ["h3", "Titre 3", "h3"], ["puces", "Liste à puces", "puces"],
            ["numeros", "Liste numérotée", "numeros"], ["tache", "Tâche", "tache"], ["citation", "Citation", "citation"], ["code", "Code", "code"]] as const).map(([c, nom, ic]) => {
            const Ic = ICONES[ic];
            return (
              <button key={c} type="button" className="carnet-menu__entree" data-actif={t.cle === c} onPointerDown={garderFocus}
                onClick={() => { const b = blocCourant(ed.state); const { from, to } = ed.state.selection; if (b) transformer(ed, b.pos, c); ed.commands.setTextSelection({ from: Math.min(from, ed.state.doc.content.size), to: Math.min(to, ed.state.doc.content.size) }); setSous(null); }}>
                <span className="carnet-menu__icone"><Ic size={17} /></span><span className="carnet-menu__libelle">{nom}</span>
                {t.cle === c && <Check size={15} className="carnet-menu__chevron" />}
              </button>
            );
          })}
        </div>
      )}
      {sous === "couleur" && (
        <div className="carnet-bulle__sous">
          <Palette texte={couleurTexte ?? null} fond={couleurFond ?? null} choisir={(quoi, c) => { colorerSelection(ed, quoi, c); setSous(null); }} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ lien

const RE_DANGER = /^\s*(javascript|data|vbscript|file):/i;

export function normaliserUrl(v: string): string | null {
  const t = v.trim();
  if (!t || RE_DANGER.test(t)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(t) || t.startsWith("/") || t.startsWith("#") || t.startsWith("./") || t.startsWith("../")) return t;
  if (/^[\w-]+(\.[\w-]+)+(\/|$|\?|#)/.test(t)) return "https://" + t;
  return t;
}

export function EditionLien({ magasin }: { magasin: Magasin }) {
  const { lien } = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const champ = useRef<HTMLInputElement>(null);
  const [valeur, setValeur] = useState("");
  const pos = usePosition(ref, lien?.ancre ?? null, "bottom-start", 8, lien?.edition);
  const ed = magasin.editeur;

  useEffect(() => {
    if (!lien) return;
    setValeur(lien.href);
    if (lien.edition) window.setTimeout(() => champ.current?.focus(), 0);
    const fermer = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) magasin.maj({ lien: null }); };
    const defiler = () => { if (!lien.edition) magasin.maj({ lien: null }); };
    window.addEventListener("pointerdown", fermer, true);
    window.addEventListener("scroll", defiler, true);
    return () => { window.removeEventListener("pointerdown", fermer, true); window.removeEventListener("scroll", defiler, true); };
  }, [lien, magasin]);

  if (!lien || !ed) return null;
  const fermer = () => { magasin.maj({ lien: null }); };
  const appliquer = () => {
    const url = normaliserUrl(valeur);
    const { from, to } = lien;
    if (!url) {
      if (!valeur.trim()) ed.chain().focus().setTextSelection({ from, to }).extendMarkRange("link").unsetLink().run();
      else ed.commands.focus();
      fermer();
      return;
    }
    if (from === to) {
      ed.chain().focus().insertContentAt(from, { type: "text", text: valeur.trim(), marks: [{ type: "link", attrs: { href: url } }] }).run();
    } else {
      ed.chain().focus().setTextSelection({ from, to }).setLink({ href: url }).setTextSelection(to).run();
    }
    fermer();
  };

  return (
    <div ref={ref} className="carnet-menu carnet-lien" role="dialog" aria-label="Lien" onMouseDown={sansFocus}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      {lien.edition ? (
        <form className="carnet-lien__form" onSubmit={(e) => { e.preventDefault(); appliquer(); }}>
          <input ref={champ} className="carnet-lien__champ" type="text" inputMode="url" enterKeyHint="done" placeholder="Colle ou tape un lien" value={valeur}
            autoCapitalize="off" autoCorrect="off" spellCheck={false}
            onChange={(e) => setValeur(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") { e.preventDefault(); fermer(); ed.commands.focus(); } }} />
          <button type="submit" className="carnet-lien__valider" aria-label="Valider le lien"><Check size={18} /></button>
        </form>
      ) : (
        <div className="carnet-lien__barre">
          <a className="carnet-lien__url" href={lien.href} target="_blank" rel="noopener noreferrer" title={lien.href}>
            <ExternalLink size={15} /> <span>{lien.href.replace(/^https?:\/\//, "").slice(0, 48) || "Lien"}</span>
          </a>
          <button type="button" className="carnet-lien__bouton" onPointerDown={garderFocus} onClick={() => magasin.maj({ lien: { ...lien, edition: true } })} aria-label="Modifier le lien" title="Modifier"><Pencil size={16} /></button>
          <button type="button" className="carnet-lien__bouton" onPointerDown={garderFocus} aria-label="Retirer le lien" title="Retirer le lien"
            onClick={() => { ed.chain().focus().setTextSelection({ from: lien.from, to: lien.to }).unsetLink().setTextSelection(lien.to).run(); fermer(); }}><Unlink size={16} /></button>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ langages

export function MenuLangue({ magasin }: { magasin: Magasin }) {
  const { langue } = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");
  const [index, setIndex] = useState(0);
  const pos = usePosition(ref, langue?.ancre ?? null, "bottom-start", 6, q);
  useEffect(() => {
    if (!langue) return;
    setQ(""); setIndex(0);
    const fermer = (e: Event) => { if (ref.current && !ref.current.contains(e.target as Node)) magasin.maj({ langue: null }); };
    window.addEventListener("pointerdown", fermer, true);
    return () => window.removeEventListener("pointerdown", fermer, true);
  }, [langue, magasin]);
  if (!langue) return null;
  const f = plier(q.trim());
  const liste = LANGUES.filter((l) => !f || plier(`${l.nom} ${l.id ?? ""} ${(l.alias ?? []).join(" ")}`).includes(f));
  const choisir = (id: string | null) => { langue.choisir(id); magasin.maj({ langue: null }); };
  return (
    <div ref={ref} className="carnet-menu carnet-menu-langue" role="dialog" aria-label="Langage du bloc de code" onMouseDown={sansFocus}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999, maxHeight: pos ? Math.min(pos.hMax, 380) : undefined }}>
      <div className="carnet-menu__recherche">
        <Search size={15} />
        <input autoFocus={!tactile} placeholder="Chercher un langage" value={q} onChange={(e) => { setQ(e.target.value); setIndex(0); }}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setIndex((i) => Math.min(i + 1, liste.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setIndex((i) => Math.max(i - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); const l = liste[index]; if (l) choisir(l.id); }
            else if (e.key === "Escape") { e.preventDefault(); magasin.maj({ langue: null }); magasin.editeur?.commands.focus(); }
          }} />
      </div>
      <div className="carnet-menu__defile">
        {liste.map((l, i) => (
          <button key={l.id ?? "brut"} type="button" className="carnet-menu__entree carnet-menu__entree--compacte" data-actif={i === index}
            onPointerDown={garderFocus} onMouseEnter={() => setIndex(i)} onClick={() => choisir(l.id)}>
            <span className="carnet-menu__libelle">{l.nom}</span>
            {(langue.actuelle ?? null) === l.id && <Check size={15} className="carnet-menu__chevron" />}
          </button>
        ))}
        {!liste.length && <div className="carnet-menu__vide">Aucun langage ne correspond.</div>}
      </div>
    </div>
  );
}

// ------------------------------------------------------------------------------------------------ tableaux

export function BarreTableau({ magasin }: { magasin: Magasin }) {
  const etat = useMagasin(magasin);
  const ref = useRef<HTMLDivElement>(null);
  const ed = magasin.editeur;
  const dansTableau = Boolean(ed && etat.focus && ed.isActive("table") && !etat.slash.ouvert && !etat.menuBloc);
  let ancre: Rect | null = null;
  let alignActuel: string | null = null;
  if (dansTableau && ed) {
    const { $from } = ed.state.selection;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if ((n.type.name === "tableCell" || n.type.name === "tableHeader") && alignActuel == null) alignActuel = n.attrs.align ?? "left";
      if (n.type.name === "table") {
        const dom = ed.view.nodeDOM($from.before(d)) as HTMLElement | null;
        const cadre = (dom?.closest?.(".tableWrapper") ?? dom) as HTMLElement | null;
        ancre = rectDe(cadre);
        break;
      }
    }
  }
  const pos = usePosition(ref, ancre, "top-start", 6, etat.rev);
  if (!dansTableau || !ed || !ancre) return null;
  const c = () => ed.chain().focus();
  const aligner = (a: "left" | "center" | "right" | null) => {
    // alignement de toute la colonne (GFM : par colonne)
    const { $from } = ed.state.selection;
    let tablePos = -1, col = -1;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type.name === "tableRow") col = $from.index(d);
      if (n.type.name === "table") { tablePos = $from.before(d); break; }
    }
    if (tablePos < 0 || col < 0) return;
    const table = ed.state.doc.nodeAt(tablePos)!;
    const tr = ed.state.tr;
    let p = tablePos + 1;
    table.forEach((ligne) => {
      let q = p + 1;
      ligne.forEach((cellule, _o, j) => {
        if (j === col) tr.setNodeMarkup(q, undefined, { ...cellule.attrs, align: a === "left" ? null : a });
        q += cellule.nodeSize;
      });
      p += ligne.nodeSize;
    });
    ed.view.dispatch(tr);
  };
  const b = (titre: string, Ic: typeof Bold, f: () => void, actif = false) => (
    <button type="button" className="carnet-bulle__bouton" title={titre} aria-label={titre} data-actif={actif} onPointerDown={garderFocus} onClick={f}>
      <Ic size={17} strokeWidth={2} />
    </button>
  );
  return (
    <div ref={ref} className="carnet-bulle carnet-barre-tableau" role="toolbar" aria-label="Tableau" onMouseDown={sansFocus}
      style={{ left: pos?.x ?? -9999, top: pos?.y ?? -9999 }}>
      <div className="carnet-bulle__ligne">
        {b("Ajouter une ligne dessous", BetweenHorizontalEnd, () => c().addRowAfter().run())}
        {b("Ajouter une colonne à droite", BetweenVerticalEnd, () => c().addColumnAfter().run())}
        <span className="carnet-bulle__sep" />
        {b("Supprimer la ligne", Rows3, () => c().deleteRow().run())}
        {b("Supprimer la colonne", Columns3, () => c().deleteColumn().run())}
        <span className="carnet-bulle__sep" />
        {b("Aligner la colonne à gauche", AlignLeft, () => aligner("left"), alignActuel === "left")}
        {b("Centrer la colonne", AlignCenter, () => aligner("center"), alignActuel === "center")}
        {b("Aligner la colonne à droite", AlignRight, () => aligner("right"), alignActuel === "right")}
        <span className="carnet-bulle__sep" />
        {b("Supprimer le tableau", Trash2, () => c().deleteTable().run())}
      </div>
    </div>
  );
}
