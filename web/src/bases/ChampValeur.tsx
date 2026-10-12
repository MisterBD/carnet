// Carnet · bases : une valeur de propriété, affichée et modifiable (cellule de tableau ou ligne du panneau
// « Propriétés »). Toute écriture passe par `ecrire` (UNE propriété, à la révision connue) :
//   - refus (422) : message affiché, la saisie reste dans le champ ;
//   - conflit (412) : la valeur venue d'ailleurs est montrée, la saisie est conservée, rien n'est écrasé
//     sans un geste explicite (« Mettre la mienne » renvoie avec la révision reçue dans le 412).
import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Check } from "lucide-react";
import { ErreurApi } from "../api";
import { tonStatut } from "../outils";
import { validerSaisie } from "../../../shared/bases.ts";
import type { TypePropriete, ValeurBrute, ValeurSaisie } from "../../../shared/bases.ts";
import { lireSaisie, texteDate, texteNombre, typeEffectif, versSaisie } from "./format";

export interface ProprietesChamp {
  valeur: ValeurBrute | undefined;
  etat: "absente" | "nulle" | "valeur" | "anomalie";
  raison?: string;
  /** Type déclaré par la base (sinon : celui de la valeur, pour l'affichage seulement). */
  type: TypePropriete | null;
  options: string[] | null;
  horsListe?: boolean;
  modifiable: boolean;
  /** Nom lisible (lecteurs d'écran, messages). */
  libelle: string;
  /** Révision (etag) du fichier telle qu'affichée : celle du début de la saisie est envoyée (412 si le fichier a changé). */
  revision: string;
  ecrire: (v: ValeurSaisie, revision: string) => Promise<void>;
  /** Cellule de tableau (compacte) ou ligne du panneau. */
  dans: "cellule" | "panneau";
}

interface Conflit { etag: string; saisie: ValeurSaisie }

function texteValeur(type: TypePropriete, v: ValeurBrute | undefined): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.filter((x) => x !== null).map(String).join(", ");
  if (typeof v === "number") return texteNombre(v);
  if (typeof v === "boolean") return v ? "oui" : "non";
  if (type === "date") return texteDate(v);
  return v;
}

function texteSaisie(v: ValeurSaisie): string {
  if (v === null) return "vide";
  if (Array.isArray(v)) return v.join(", ") || "liste vide";
  return String(v);
}

export function ChampValeur(p: ProprietesChamp) {
  const type = typeEffectif(p.type, p.valeur);
  const [edition, setEdition] = useState(false);
  const [texte, setTexte] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [conflit, setConflit] = useState<Conflit | null>(null);
  const [enCours, setEnCours] = useState(false);
  const [ok, setOk] = useState(false);
  const champ = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const annule = useRef(false);
  const envoi = useRef(false);
  /** Révision vue au début de la saisie (une version arrivée pendant la saisie doit produire un conflit). */
  const depart = useRef(p.revision);

  useEffect(() => { if (edition) { champ.current?.focus(); champ.current?.select?.(); } }, [edition]);
  // un refus ou un conflit doit se voir en entier, même au bord droit d'un tableau qui défile
  const message = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (erreur || conflit) message.current?.scrollIntoView?.({ block: "nearest", inline: "nearest" }); }, [erreur, conflit]);
  useEffect(() => { if (!ok) return; const t = window.setTimeout(() => setOk(false), 1200); return () => window.clearTimeout(t); }, [ok]);

  const envoyer = async (v: ValeurSaisie, revision?: string): Promise<boolean> => {
    if (envoi.current) return false;
    const decl = p.type ? { type: p.type, options: p.options } : null;
    const r = validerSaisie(decl, v);
    if (!r.ok) { setErreur(r.message); return false; }
    envoi.current = true;
    setEnCours(true);
    setErreur(null);
    try {
      await p.ecrire(r.valeur, revision ?? (edition ? depart.current : p.revision));
      setConflit(null);
      setOk(true);
      return true;
    } catch (e) {
      if (e instanceof ErreurApi && e.statut === 412) {
        setConflit({ etag: String(e.corps.etag ?? ""), saisie: r.valeur });
      } else {
        setErreur(e instanceof ErreurApi ? e.message : "Carnet ne répond pas : réessaie dans un instant.");
      }
      return false;
    } finally {
      envoi.current = false;
      setEnCours(false);
    }
  };

  const valider = async () => {
    if (annule.current) { annule.current = false; return; }
    // conflit affiché : c'est à la personne de choisir (boutons) ; quitter le champ ne renvoie rien
    if (conflit) return;
    const s = lireSaisie(type, texte);
    if (!s.ok) { setErreur(s.message); return; }
    if (versSaisie(type, p.valeur) === texte && p.etat !== "absente") { setEdition(false); setErreur(null); return; }
    if (await envoyer(s.valeur)) setEdition(false);
  };

  const ouvrir = () => {
    if (!p.modifiable || p.etat === "anomalie") return;
    annule.current = false;
    depart.current = p.revision;
    setTexte(versSaisie(type, p.valeur));
    setErreur(null);
    setEdition(true);
  };

  const messages = (
    <>
      {erreur && <span ref={message} className="champ-base__erreur" role="alert"><AlertTriangle size={14} aria-hidden="true" /> Refusé : {erreur}</span>}
      {conflit && (
        <span ref={message} className="champ-base__conflit" role="alert">
          <span>
            Modifiée ailleurs pendant ta saisie. Maintenant : « {texteValeur(type, p.valeur) || "vide"} » ; ta saisie : « {texteSaisie(conflit.saisie)} ».
          </span>
          <span className="champ-base__actions">
            <button type="button" className="bouton bouton--petit" onMouseDown={(e) => e.preventDefault()}
              onClick={() => { setConflit(null); setEdition(false); }}>Garder l'actuelle</button>
            <button type="button" className="bouton bouton--petit bouton--primaire" onMouseDown={(e) => e.preventDefault()}
              onClick={() => void envoyer(conflit.saisie, conflit.etag).then((x) => { if (x) setEdition(false); })}>
              Mettre la mienne
            </button>
          </span>
        </span>
      )}
    </>
  );

  // ---------------------------------------------------------------- anomalie : jamais réécrite d'ici
  if (p.etat === "anomalie") {
    return (
      <span className="champ-base" data-etat="anomalie" data-dans={p.dans}>
        <span className="champ-base__anomalie" title={`${p.raison ?? "valeur illisible"} : valeur non modifiable ici (modifie le fichier)`}>
          <AlertTriangle size={14} aria-hidden="true" /> {p.raison ?? "valeur illisible"}
        </span>
      </span>
    );
  }

  // ---------------------------------------------------------------- case à cocher
  if (type === "case") {
    const coche = p.valeur === true;
    return (
      <span className="champ-base" data-etat={p.etat} data-dans={p.dans}>
        <button type="button" role="checkbox" aria-checked={coche} className="champ-base__case" data-etat={p.etat}
          disabled={!p.modifiable || enCours} aria-label={p.libelle}
          title={p.etat === "absente" ? "Non renseignée" : p.valeur === false ? "Décochée (false)" : undefined}
          onClick={() => void envoyer(!coche)}>
          <span className="champ-base__case-dessin" aria-hidden="true">{coche && <Check size={14} strokeWidth={3} />}</span>
        </button>
        {messages}
      </span>
    );
  }

  // ---------------------------------------------------------------- statut / sélection : liste native
  if ((type === "statut" || type === "selection") && p.options) {
    const v = typeof p.valeur === "string" ? p.valeur : "";
    const choix = conflit && typeof conflit.saisie === "string" ? conflit.saisie : v;
    return (
      <span className="champ-base" data-etat={p.etat} data-dans={p.dans}>
        <label className="champ-base__choix" data-vide={v === "" ? "true" : undefined}>
          {v !== "" && (
            <span className={type === "statut" ? "pastille" : "pastille pastille--choix"} data-ton={type === "statut" ? tonStatut(v) : undefined}
              data-hors-liste={p.horsListe ? "true" : undefined} title={p.horsListe ? "Valeur hors de la liste déclarée (affichée telle quelle)" : undefined}>
              {v}
            </span>
          )}
          {v === "" && (() => {
            const m = videDe(p, "Choisir…");
            return <span className="champ-base__vide" data-vide={m.genreVide} title={m.titre}>{m.marque}</span>;
          })()}
          {p.modifiable && (
            <select aria-label={p.libelle} value={choix} disabled={enCours}
              onChange={(e) => void envoyer(e.target.value === "" ? null : e.target.value)}>
              <option value="">— vide —</option>
              {p.horsListe && v !== "" && <option value={v} disabled>{v} (hors liste)</option>}
              {p.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )}
        </label>
        {ok && <span className="champ-base__ok" aria-hidden="true"><Check size={13} /></span>}
        {messages}
      </span>
    );
  }

  // ---------------------------------------------------------------- texte, nombre, date, liste
  if (edition) {
    const date = type === "date" && (texte === "" || /^\d{4}-\d{2}-\d{2}$/.test(texte));
    const multi = type === "texte" && texte.includes("\n");
    const commun = {
      ref: champ,
      className: "champ-base__saisie",
      "aria-label": p.libelle,
      "aria-invalid": erreur ? true : undefined,
      disabled: enCours,
      onBlur: () => void valider(),
      onKeyDown: (e: React.KeyboardEvent) => {
        if (e.nativeEvent.isComposing) return;
        if (e.key === "Escape") { e.preventDefault(); annule.current = true; setEdition(false); setErreur(null); }
        else if (e.key === "Enter" && !(multi && e.shiftKey)) { e.preventDefault(); void valider(); }
      },
    };
    return (
      <span className="champ-base" data-etat="edition" data-dans={p.dans}>
        {multi
          ? <textarea {...commun} rows={3} value={texte} onChange={(e) => setTexte(e.target.value)} />
          : <input {...commun} type={date ? "date" : "text"} value={texte} spellCheck={type === "texte"}
              inputMode={type === "nombre" ? "decimal" : undefined} enterKeyHint="done"
              placeholder={type === "date" ? "AAAA-MM-JJ" : type === "liste" ? "a, b, c" : undefined}
              onChange={(e) => { setTexte(e.target.value); if (erreur) setErreur(null); }} />}
        {messages}
      </span>
    );
  }

  const affichage = texteValeur(type, p.valeur);
  const { genreVide, marque } = videDe(p, "Ajouter…");
  return (
    <span className="champ-base" data-etat={p.etat} data-dans={p.dans} data-type={type}>
      <button type="button" className="champ-base__valeur" disabled={!p.modifiable} onClick={ouvrir}
        aria-label={`${p.libelle} : ${affichage || (genreVide === "nulle" ? "vide (null)" : genreVide === "chaine" ? "texte vide" : "non renseignée")}${p.modifiable ? " (modifier)" : ""}`}
        title={affichage ? undefined : videDe(p, "").titre}>
        {Array.isArray(p.valeur) && p.valeur.length > 0
          ? <span className="champ-base__liste">{p.valeur.filter((x) => x !== null).map((x, i) => <span key={i} className="pastille pastille--etiquette" title={String(x)}>{String(x)}</span>)}</span>
          : affichage
            ? <span className="champ-base__texte">{affichage}</span>
            : <span className="champ-base__vide" data-vide={genreVide}>{marque}</span>}
      </button>
      {ok && <span className="champ-base__ok" aria-hidden="true"><Check size={13} /></span>}
      {messages}
    </span>
  );
}

/**
 * K10-06 (finale V3) : absente, null et chaîne vide se distinguent à l'œil (estompés) et à l'infobulle :
 * absente = rien (`absentePanneau` dans le panneau), null = « — », chaîne vide = « "" ».
 */
function videDe(p: { etat: string; valeur?: unknown; dans?: string }, absentePanneau: string): { genreVide: "nulle" | "chaine" | "absente"; marque: string; titre: string | undefined } {
  const genreVide = p.etat === "nulle" ? "nulle" : p.etat === "valeur" && p.valeur === "" ? "chaine" : "absente";
  const marque = genreVide === "nulle" ? (p.dans === "panneau" ? "— (vide)" : "—") : genreVide === "chaine" ? "\"\"" : p.dans === "panneau" ? absentePanneau : "";
  const titre = genreVide === "nulle" ? "Vide (null)" : genreVide === "chaine" ? "Texte vide (\"\")" : p.etat === "absente" ? "Non renseignée (propriété absente)" : undefined;
  return { genreVide, marque, titre };
}
