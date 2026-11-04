// Carnet · panneau « Propriétés » en tête de page (sous le titre, repliable, comme Notion).
// Propriétés du frontmatter, typées par la base dont la page est une entrée (sinon type de la valeur, pour
// l'affichage seulement). Modifier, ajouter, retirer : UNE propriété à la fois, par le même mécanisme que les
// cellules d'une base (révision attendue, refus explicite, conflit visible). Replié, il garde l'essentiel visible
// (statut, étiquettes, résumé), comme l'en-tête d'avant.
import { useCallback, useEffect, useId, useMemo, useRef, useState } from "react";
import { AlertTriangle, ChevronDown, ChevronRight, Lock, MoreHorizontal, Plus, Table2, Trash2 } from "lucide-react";
import { apiBases, ErreurApi, type ProprietePage, type ProprietesPage } from "../api";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe } from "../navigation";
import { tonStatut } from "../outils";
import { CLES_PROVENANCE, LIBELLES_TYPES, validerSaisie } from "../../../shared/bases.ts";
import type { TypePropriete, ValeurSaisie } from "../../../shared/bases.ts";
import { ChampValeur } from "./ChampValeur";
import { lireSaisie } from "./format";
import { ICONES_TYPES } from "./icones";
import "./bases.css";

export type EcrirePropriete = (cle: string, valeur: ValeurSaisie | undefined, decl: { type: TypePropriete | null; options: string[] | null }, revision: string) => Promise<void>;

const CLE_PREF = "carnet:proprietes-repliees";
/** Comme le socle (shared/proprietes.ts) : une lettre ou « _ » d'abord, puis lettres, chiffres, « _ », « - », espaces, points. */
const RE_CLE = /^[\p{L}_][\p{L}\p{N}_ .-]{0,63}$/u;
const TYPES_AJOUT: TypePropriete[] = ["texte", "nombre", "date", "case", "liste"];

function lirePref(): boolean {
  try { return localStorage.getItem(CLE_PREF) === "1"; } catch { return false; }
}

export function PanneauProprietes({ chemin, yaml, lectureSeule, ecrire, ajout, finAjout, surNombre }: {
  chemin: string;
  /** YAML courant de la page (change après chaque enregistrement) : déclenche la relecture. */
  yaml: string;
  lectureSeule?: boolean;
  ecrire?: EcrirePropriete;
  /** « Ajouter une propriété » demandé depuis l'en-tête (page sans propriété). */
  ajout: boolean;
  finAjout(): void;
  /** Nombre de propriétés (l'en-tête propose « Ajouter une propriété » quand il n'y en a aucune). */
  surNombre?(n: number): void;
}) {
  const [d, setD] = useState<ProprietesPage | null>(null);
  const [panne, setPanne] = useState<string | null>(null);
  // Intégration lots 2 et 3 : sur une demande de décision, le panneau commence replié (sans changer la préférence),
  // pour que la barre de décision reste en tête de la page, surtout sur iPhone. K10-03 (finale V3) : de même sur une
  // préparation conservée (`type: preparation`), où il s'appelle « Sources et traçabilité » (empreinte, sources…) :
  // le dossier se lit d'abord.
  const pagePreparation = /^type:[ \t]*["']?preparation["']?[ \t]*$/m.test(yaml);
  const pageDecision = pagePreparation || /^type:[ \t]*["']?decision["']?[ \t]*$/m.test(yaml);
  const intitule = pagePreparation ? "Sources et traçabilité" : "Propriétés";
  const [replie, setReplie] = useState(() => pageDecision || lirePref());
  const touche = useRef(false);
  useEffect(() => { if (pageDecision && !touche.current) setReplie(true); }, [pageDecision]);
  const [formulaire, setFormulaire] = useState(false);
  const [menu, setMenu] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const seq = useRef(0);
  const idProvenance = useId();

  const charger = useCallback(async () => {
    const n = ++seq.current;
    try {
      const r = await apiBases.proprietes(chemin);
      if (n === seq.current) { setD(r.absente ? null : r); setPanne(null); }
    } catch (e) {
      if (n !== seq.current) return;
      if (e instanceof ErreurApi && e.statut === 404) setD(null);
      else setPanne(e instanceof ErreurApi ? e.message : "Carnet ne répond pas.");
    }
  }, [chemin]);

  useEffect(() => { const t = window.setTimeout(() => void charger(), 60); return () => window.clearTimeout(t); }, [charger, yaml]);
  useEffect(() => {
    let m: number | null = null;
    return ecouter((e) => {
      // la page elle-même (changement extérieur) ou une base qui la type (déclarations)
      if (e.type === "modif" || e.type === "arbre") { if (m) window.clearTimeout(m); m = window.setTimeout(() => void charger(), 300); }
    });
  }, [charger]);
  useEffect(() => { if (ajout) { setReplie(false); setFormulaire(true); finAjout(); } }, [ajout, finAjout]);

  const basculer = () => {
    touche.current = true;
    setReplie((r) => {
      if (!pageDecision) { try { localStorage.setItem(CLE_PREF, r ? "0" : "1"); } catch { /* navigation privée */ } }
      return !r;
    });
  };

  const modifiable = !lectureSeule && !!ecrire && !!d && !d.yamlInvalide && !d.nonModifiable;

  const poser = async (p: Pick<ProprietePage, "cle" | "type" | "declare" | "options">, v: ValeurSaisie | undefined, revision: string) => {
    if (!ecrire) return;
    setMessage(null);
    await ecrire(p.cle, v, { type: p.declare ? p.type : null, options: p.declare ? p.options : null }, revision);
    await charger();
  };

  const retirer = async (p: ProprietePage) => {
    setMenu(null);
    if (!d) return;
    try {
      await poser(p, undefined, d.etag);
    } catch (e) {
      setMessage(e instanceof ErreurApi ? (e.statut === 412 ? "La page a changé ailleurs : vérifie la valeur, puis recommence." : `Propriété non retirée : ${e.message}`) : "Carnet ne répond pas.");
      void charger();
    }
  };

  const statut = d?.proprietes.find((p) => (p.cle === "statut" || p.cle === "status") && p.etat === "valeur" && typeof p.valeur === "string");
  const tags = d?.proprietes.find((p) => p.cle === "tags" && p.etat === "valeur");
  const etiquettes = tags && tags.etat === "valeur" ? (Array.isArray(tags.valeur) ? tags.valeur.map(String) : typeof tags.valeur === "string" ? tags.valeur.split(/[,\s]+/) : []).map((t) => t.replace(/^#/, "")).filter(Boolean).slice(0, 8) : [];
  const resume = d?.proprietes.find((p) => p.cle === "resume" && p.etat === "valeur" && typeof p.valeur === "string");
  const nb = d?.proprietes.length ?? 0;
  const provenance = d?.proprietes.filter((p) => CLES_PROVENANCE.has(p.cle)) ?? [];
  const estDecision = d?.proprietes.some((p) => p.cle === "type" && p.etat === "valeur" && p.valeur === "decision") ?? false;
  useEffect(() => { if (d) surNombre?.(d.yamlInvalide ? -1 : nb); }, [d, nb, surNombre]);

  if (panne && !d) return <p className="proprietes__panne" role="alert"><AlertTriangle size={14} aria-hidden="true" /> Propriétés indisponibles : {panne}</p>;
  if (!d) return null;
  if (d.yamlInvalide) {
    return (
      <div className="proprietes proprietes--invalide" role="note">
        <AlertTriangle size={15} aria-hidden="true" /> L'en-tête YAML de cette page est illisible ({d.yamlInvalide}) : Carnet ne modifie pas ses propriétés. Corrige le fichier.
      </div>
    );
  }
  if (nb === 0 && !formulaire) return null;

  return (
    <section className="proprietes" aria-label={intitule} data-replie={replie ? "true" : undefined} data-preparation={pagePreparation ? "true" : undefined}>
      <div className="proprietes__tete">
        <button type="button" className="proprietes__bascule" aria-expanded={!replie} onClick={basculer}>
          {replie ? <ChevronRight size={16} aria-hidden="true" /> : <ChevronDown size={16} aria-hidden="true" />}
          {intitule}{nb ? <span className="proprietes__nb">{nb}</span> : null}
        </button>
        {d.base && (
          <a className="proprietes__base" href={urlDe({ vue: "page", chemin: d.base.page })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: d.base!.page })}
            title="Les types viennent de cette base">
            <Table2 size={14} aria-hidden="true" /> {d.base.titre}
          </a>
        )}
        {replie && (statut || etiquettes.length > 0) && (
          <span className="proprietes__resume">
            {statut && <span className="pastille" data-ton={tonStatut(String(statut.valeur))}>{String(statut.valeur)}</span>}
            {etiquettes.map((t) => <span key={t} className="pastille pastille--etiquette">#{t}</span>)}
          </span>
        )}
      </div>
      {replie && resume && <p className="resume-page">{String(resume.valeur)}</p>}
      {!replie && d.nonModifiable && (
        <p className="proprietes__note"><AlertTriangle size={14} aria-hidden="true" /> Lecture seule : {d.nonModifiable}. Carnet ne réécrit pas cet en-tête ; corrige le fichier.</p>
      )}
      {!replie && (
        <div className="proprietes__liste" role="list">
          {d.proprietes.filter((p) => !CLES_PROVENANCE.has(p.cle)).map((p) => {
            const Ic = p.type ? ICONES_TYPES[p.type] : ICONES_TYPES.texte;
            // Intégration lots 2 et 3 : sur une demande de décision, « statut » et « engage » sont des déclarations ;
            // seul le geste de la barre de décision (attesté) les fait évoluer.
            const parDecision = estDecision && (p.cle === "statut" || p.cle === "engage");
            const modifiableIci = modifiable && !parDecision;
            return (
              <div key={p.cle} className="proprietes__ligne" role="listitem">
                <span className="proprietes__cle" title={p.declare ? `${LIBELLES_TYPES[p.type!]} (déclaré par la base)` : p.type ? `${LIBELLES_TYPES[p.type]} (d'après la valeur)` : "Vide"}>
                  <Ic size={14} aria-hidden="true" /> <span className="proprietes__nom" title={p.libelle ? `clé : ${p.cle}` : undefined}>{p.libelle ?? p.cle}</span>
                </span>
                <span className="proprietes__valeur">
                  <ChampValeur
                    dans="panneau"
                    valeur={p.etat === "valeur" ? p.valeur : undefined}
                    etat={p.etat === "anomalie" ? "anomalie" : p.valeur === null ? "nulle" : "valeur"}
                    raison={p.raison}
                    type={p.declare ? p.type : null}
                    options={p.declare ? p.options : null}
                    horsListe={p.horsListe}
                    modifiable={modifiableIci}
                    libelle={p.libelle ?? p.cle}
                    revision={d.etag}
                    ecrire={(v, rev) => poser(p, v, rev)}
                  />
                </span>
                {parDecision && <span className="proprietes__declare" title="Statut déclaré dans le fichier : la preuve affichée par la barre de décision fait foi">déclaré</span>}
                {/* lot 6 : en lecture seule (page verrouillée), la 3e colonne de la grille reste occupée */}
                {!modifiableIci && !parDecision && <span className="proprietes__menu" aria-hidden="true" />}
                {modifiableIci && (
                  <span className="proprietes__menu">
                    <button type="button" className="bouton-icone" aria-label={`Actions sur ${p.cle}`} aria-expanded={menu === p.cle}
                      onClick={() => setMenu((m) => (m === p.cle ? null : p.cle))}>
                      <MoreHorizontal size={17} />
                    </button>
                    {menu === p.cle && (
                      <span className="proprietes__menu-liste">
                        <button type="button" className="bouton bouton--petit bouton--danger" onClick={() => void retirer(p)}>
                          <Trash2 size={14} aria-hidden="true" /> Retirer « {p.cle} »
                        </button>
                      </span>
                    )}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      {!replie && message && <p className="champ-base__erreur" role="alert">{message}</p>}
      {!replie && modifiable && !formulaire && (
        <button type="button" className="proprietes__ajouter" onClick={() => setFormulaire(true)}>
          <Plus size={16} aria-hidden="true" /> Ajouter une propriété
        </button>
      )}
      {!replie && modifiable && formulaire && (
        <AjoutPropriete d={d} fermer={() => setFormulaire(false)}
          ajouter={async (cle, v, decl) => { await ecrire!(cle, v, decl, d.etag); await charger(); setFormulaire(false); }} />
      )}
      {!replie && provenance.length > 0 && (
        <>
          <p className="proprietes__provenance-titre" id={idProvenance}>Provenance</p>
          <div className="proprietes__liste proprietes__provenance" role="list" aria-labelledby={idProvenance}>
            {provenance.map((p) => (
              <div key={p.cle} className="proprietes__ligne" role="listitem">
                <span className="proprietes__cle" title="Propriété de provenance : jamais réécrite par Carnet">
                  <Lock size={13} aria-hidden="true" /> <span className="proprietes__nom">{p.libelle ?? p.cle}</span>
                </span>
                <span className="proprietes__valeur proprietes__valeur--lecture">
                  {p.etat === "anomalie" ? `⚠ ${p.raison ?? "valeur illisible"}`
                    : p.valeur === null || p.valeur === undefined ? "—"
                      : Array.isArray(p.valeur) ? p.valeur.join(", ") : String(p.valeur)}
                </span>
                <span />
              </div>
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function AjoutPropriete({ d, ajouter, fermer }: {
  d: ProprietesPage;
  ajouter: (cle: string, v: ValeurSaisie, decl: { type: TypePropriete | null; options: string[] | null }) => Promise<void>;
  fermer(): void;
}) {
  const [cle, setCle] = useState("");
  const [type, setType] = useState<TypePropriete>("texte");
  const [valeur, setValeur] = useState("");
  const [erreur, setErreur] = useState<string | null>(null);
  const [enCours, setEnCours] = useState(false);
  const presentes = useMemo(() => new Set(d.proprietes.map((p) => p.cle)), [d]);
  const suggestions = d.declarations.filter((x) => !presentes.has(x.cle));
  const decl = d.declarations.find((x) => x.cle === cle.trim()) ?? null;
  const typeEff: TypePropriete = decl?.type ?? type;

  const valider = async () => {
    const c = cle.trim();
    if (!RE_CLE.test(c)) { setErreur("Nom invalide : commence par une lettre ; lettres, chiffres, espaces, « - », « _ », « . » (64 au plus)."); return; }
    if (presentes.has(c)) { setErreur(`La propriété « ${c} » existe déjà.`); return; }
    if (["title", "icon", "cover"].includes(c)) { setErreur("Titre, icône et couverture se changent dans l'en-tête de la page."); return; }
    if (CLES_PROVENANCE.has(c)) { setErreur(`« ${c} » est une propriété de provenance : Carnet ne l'écrit pas.`); return; }
    let v: ValeurSaisie;
    if (typeEff === "case") v = valeur === "true";
    else if ((typeEff === "statut" || typeEff === "selection") && decl?.options) v = valeur === "" ? null : valeur;
    else {
      const s = lireSaisie(typeEff, valeur);
      if (!s.ok) { setErreur(s.message); return; }
      v = s.valeur;
    }
    const ok = validerSaisie(decl ? { type: decl.type, options: decl.options } : null, v);
    if (!ok.ok) { setErreur(ok.message); return; }
    setEnCours(true);
    setErreur(null);
    try {
      await ajouter(c, ok.valeur, decl ? { type: decl.type, options: decl.options } : { type: null, options: null });
    } catch (e) {
      setErreur(e instanceof ErreurApi ? (e.statut === 412 ? "La page a changé ailleurs : vérifie, puis recommence." : e.message) : "Carnet ne répond pas.");
    } finally {
      setEnCours(false);
    }
  };

  return (
    <form className="proprietes__form" aria-label="Ajouter une propriété" onSubmit={(e) => { e.preventDefault(); void valider(); }}>
      <input className="proprietes__form-cle" aria-label="Nom de la propriété" placeholder="Nom (ex. statut)" value={cle} autoFocus maxLength={64}
        list="carnet-proprietes-suggestions" onChange={(e) => { setCle(e.target.value); setErreur(null); }} />
      {suggestions.length > 0 && (
        <datalist id="carnet-proprietes-suggestions">{suggestions.map((s) => <option key={s.cle} value={s.cle} />)}</datalist>
      )}
      {decl
        ? <span className="proprietes__form-type">{LIBELLES_TYPES[decl.type]}</span>
        : (
          <select aria-label="Type" value={type} onChange={(e) => { setType(e.target.value as TypePropriete); setValeur(""); }}>
            {TYPES_AJOUT.map((t) => <option key={t} value={t}>{LIBELLES_TYPES[t]}</option>)}
          </select>
        )}
      {typeEff === "case"
        ? (
          <select aria-label="Valeur" value={valeur || "false"} onChange={(e) => setValeur(e.target.value)}>
            <option value="false">Non cochée</option><option value="true">Cochée</option>
          </select>
        )
        : (typeEff === "statut" || typeEff === "selection") && decl?.options
          ? (
            <select aria-label="Valeur" value={valeur} onChange={(e) => setValeur(e.target.value)}>
              <option value="">— vide —</option>
              {decl.options.map((o) => <option key={o} value={o}>{o}</option>)}
            </select>
          )
          : <input aria-label="Valeur" type={typeEff === "date" ? "date" : "text"} inputMode={typeEff === "nombre" ? "decimal" : undefined}
              placeholder={typeEff === "liste" ? "a, b, c" : "Valeur"} value={valeur} onChange={(e) => { setValeur(e.target.value); setErreur(null); }} />}
      <button type="submit" className="bouton bouton--petit bouton--primaire" disabled={enCours || !cle.trim()}>Ajouter</button>
      <button type="button" className="bouton bouton--petit" onClick={fermer}>Annuler</button>
      {erreur && <span className="champ-base__erreur" role="alert"><AlertTriangle size={14} aria-hidden="true" /> {erreur}</span>}
    </form>
  );
}
