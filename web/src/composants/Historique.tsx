// Historique des versions d'une page : versions git (lecture seule, côté serveur) et instantanés pris à la main,
// comparaison lisible (mots ajoutés surlignés, mots retirés barrés), restauration réversible, instantané à la demande.
// Ordinateur : liste à gauche, comparaison à droite. iPhone : la liste, puis la comparaison en plein écran.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, ChevronDown, ChevronLeft, ChevronUp, GitCommitHorizontal, RotateCcw } from "lucide-react";
import { api, type Version } from "../api";
import { useApp, ancetres } from "../contexte-app";
import { naviguer } from "../navigation";
import { Entete, type MaillonFil } from "./Entete";
import { IconePage } from "./Icone";
import { ilYA } from "../outils";
import { differencesLignes, bilan, type LigneDiff } from "../../../shared/diff.ts";
import { feuille } from "../../../shared/page.ts";

const ACTUELLE = "actuelle";
type Mode = "precedente" | "actuelle";

const fmtJour = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtJourAn = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric" });
const fmtHeure = new Intl.DateTimeFormat("fr-FR", { hour: "2-digit", minute: "2-digit" });
const fmtCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

function jourDe(ms: number): string {
  const d = new Date(ms);
  const auj = new Date();
  const hier = new Date(Date.now() - 86_400_000);
  if (d.toDateString() === auj.toDateString()) return "Aujourd'hui";
  if (d.toDateString() === hier.toDateString()) return "Hier";
  const s = (d.getFullYear() === auj.getFullYear() ? fmtJour : fmtJourAn).format(d);
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function titreVersion(v: Version): string {
  const j = jourDe(v.date);
  const h = fmtHeure.format(new Date(v.date));
  if (j === "Aujourd'hui") return `Version d'aujourd'hui à ${h}`;
  if (j === "Hier") return `Version d'hier à ${h}`;
  return `Version du ${j.charAt(0).toLowerCase()}${j.slice(1)} à ${h}`;
}

function libelleSource(v: Version): string {
  if (v.source === "instantane") return v.auto ? "Instantané avant restauration" : "Instantané";
  return "Sauvegarde git";
}

export function Historique({ chemin }: { chemin: string }) {
  const app = useApp();
  const noeud = app.index.get(chemin);
  const titrePage = noeud?.titre ?? feuille(chemin);
  const [versions, setVersions] = useState<Version[] | null>(null);
  const [git, setGit] = useState(true);
  const [actuelle, setActuelle] = useState<{ contenu: string; etag: string | null; absente: boolean } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [selection, setSelection] = useState<string | null>(null);
  const [detailMobile, setDetailMobile] = useState(false);
  const [mode, setMode] = useState<Mode>("precedente");
  const [surligner, setSurligner] = useState(true);
  const [contenus, setContenus] = useState<Map<string, string>>(new Map());
  const [occupe, setOccupe] = useState(false);
  const enCharge = useRef(new Set<string>());

  const charger = useCallback(async () => {
    try {
      const [h, p] = await Promise.all([api.historique(chemin), api.page(chemin)]);
      setVersions(h.versions);
      setGit(h.git);
      setActuelle({ contenu: p.contenu, etag: p.etag, absente: Boolean(p.absente) });
      setErreur(null);
      setSelection((s) => s ?? (h.versions[0]?.id ?? ACTUELLE));
    } catch (e) {
      setErreur((e as Error).message);
    }
  }, [chemin]);
  useEffect(() => { void charger(); }, [charger]);

  const contenuDe = useCallback((id: string | null): string | undefined => {
    if (id === null) return undefined;
    if (id === ACTUELLE) return actuelle?.contenu;
    return contenus.get(id);
  }, [actuelle, contenus]);

  const demander = useCallback((id: string | null) => {
    if (!id || id === ACTUELLE || contenus.has(id) || enCharge.current.has(id)) return;
    enCharge.current.add(id);
    api.version(chemin, id)
      .then((r) => setContenus((m) => new Map(m).set(id, r.contenu)))
      .catch((e) => app.notifier(`Version illisible : ${(e as Error).message}`))
      .finally(() => enCharge.current.delete(id));
  }, [chemin, contenus, app]);

  // Version comparée : la précédente (plus ancienne) ou la page actuelle.
  const idx = versions && selection ? (selection === ACTUELLE ? -1 : versions.findIndex((v) => v.id === selection)) : -1;
  const precedente = versions ? (selection === ACTUELLE ? versions[0]?.id ?? null : versions[idx + 1]?.id ?? null) : null;
  const modeEffectif: Mode = selection === ACTUELLE ? "precedente" : mode;
  useEffect(() => {
    demander(selection);
    if (modeEffectif === "precedente") demander(precedente);
  }, [selection, precedente, modeEffectif, demander]);

  const contenuSel = contenuDe(selection);
  const [avant, apres] = modeEffectif === "precedente"
    ? [precedente ? contenuDe(precedente) : "", contenuSel]
    : [actuelle?.contenu, contenuSel];

  const restaurer = async () => {
    if (!selection || selection === ACTUELLE) return;
    const v = versions?.find((x) => x.id === selection);
    setOccupe(true);
    try {
      const r = await api.restaurerVersion(chemin, selection, actuelle?.absente ? null : actuelle?.etag);
      await app.rechargerArbre();
      naviguer({ vue: "page", chemin }, true);
      const quand = v ? fmtCourt.format(new Date(v.date)) : "";
      app.notifier(`Version du ${quand} restaurée`, r.instantane ? {
        libelle: "Annuler",
        faire: () => {
          api.restaurerVersion(chemin, r.instantane!).then(() => app.notifier("Restauration annulée"))
            .catch((e) => app.notifier(`Annulation impossible : ${(e as Error).message}`));
        },
      } : undefined, 8000);
    } catch (e) {
      app.notifier(`Restauration impossible : ${(e as Error).message}`);
      void charger();
    } finally {
      setOccupe(false);
    }
  };

  const instantane = async () => {
    try {
      const r = await api.instantane(chemin);
      app.notifier(r.identique ? "Rien de neuf depuis le dernier instantané" : "Instantané enregistré");
      await charger();
      if (!r.identique) setSelection(r.id);
    } catch (e) {
      app.notifier(`Instantané impossible : ${(e as Error).message}`);
    }
  };

  const fil: MaillonFil[] = [
    ...ancetres(chemin).map((c) => ({ titre: app.index.get(c)?.titre ?? feuille(c), route: { vue: "page" as const, chemin: c } })),
    { titre: titrePage, route: { vue: "page", chemin } },
    { titre: "Historique" },
  ];

  const groupes = useMemo(() => {
    const g: Array<{ jour: string; versions: Version[] }> = [];
    for (const v of versions ?? []) {
      const j = jourDe(v.date);
      if (g.length && g[g.length - 1].jour === j) g[g.length - 1].versions.push(v);
      else g.push({ jour: j, versions: [v] });
    }
    return g;
  }, [versions]);

  const vSel = versions?.find((v) => v.id === selection) ?? null;
  const choisir = (id: string) => { setSelection(id); setDetailMobile(true); };

  return (
    <>
      <Entete fil={fil} />
      <main className="vue-historique" data-detail={detailMobile ? "true" : undefined}>
        <aside className="historique__liste" aria-label="Versions">
          <div className="historique__tete">
            <span className="historique__icone"><IconePage icone={noeud?.icone ?? null} taille={20} /></span>
            <div>
              <h1 className="historique__titre">Historique</h1>
              <p className="historique__sous-titre">{titrePage}</p>
            </div>
          </div>
          <p className="historique__note">
            {git ? "Les versions viennent des sauvegardes git de l'espace et des instantanés que tu prends." : "Pas de sauvegarde git ici : seuls tes instantanés sont gardés."}
          </p>
          <button type="button" className="bouton bouton--petit historique__instantane" onClick={() => void instantane()}>
            <Camera size={16} /> Prendre un instantané
          </button>
          {erreur && <p className="etat-page">Historique indisponible : {erreur}</p>}
          {!versions && !erreur && [0, 1, 2, 3].map((i) => <div key={i} className="squelette" style={{ height: 46 }} />)}
          {versions && (
            <ul className="historique__versions">
              <li>
                <button type="button" className="version" aria-current={selection === ACTUELLE ? "true" : undefined} onClick={() => choisir(ACTUELLE)}>
                  <span className="version__heure">Maintenant</span>
                  <span className="version__texte">
                    <span className="version__libelle">Version actuelle</span>
                    <span className="version__detail">{actuelle?.absente ? "page absente" : noeud ? `modifiée ${ilYA(noeud.mtime)}` : ""}</span>
                  </span>
                </button>
              </li>
              {groupes.map((g) => (
                <li key={g.jour}>
                  <div className="historique__jour">{g.jour}</div>
                  <ul>
                    {g.versions.map((v) => (
                      <li key={v.id}>
                        <button type="button" className="version" data-source={v.source} aria-current={selection === v.id ? "true" : undefined} onClick={() => choisir(v.id)}>
                          <span className="version__heure">{fmtHeure.format(new Date(v.date))}</span>
                          <span className="version__texte">
                            <span className="version__libelle">{libelleSource(v)}</span>
                            {v.source === "git" && v.message && <span className="version__detail">{v.message}</span>}
                          </span>
                          {v.source === "git" ? <GitCommitHorizontal size={15} aria-hidden="true" /> : <Camera size={14} aria-hidden="true" />}
                        </button>
                      </li>
                    ))}
                  </ul>
                </li>
              ))}
              {versions.length === 0 && (
                <li className="historique__vide">Aucune version enregistrée pour l'instant. Prends un instantané avant une grosse modification.</li>
              )}
            </ul>
          )}
        </aside>

        <section className="historique__detail" aria-label="Comparaison">
          <div className="historique__barre">
            <button type="button" className="historique__retour" onClick={() => setDetailMobile(false)}>
              <ChevronLeft size={18} /> Versions
            </button>
            <div className="historique__quoi">
              <div className="historique__quoi-titre">{selection === ACTUELLE ? "Version actuelle" : vSel ? titreVersion(vSel) : "…"}</div>
              {vSel && <div className="historique__quoi-source">{libelleSource(vSel)}{vSel.auteur ? ` · ${vSel.auteur}` : ""}</div>}
            </div>
            {selection !== ACTUELLE && vSel && (
              <button type="button" className="bouton bouton--primaire bouton--petit historique__restaurer" disabled={occupe || contenuSel === undefined} onClick={() => void restaurer()}>
                <RotateCcw size={16} /> Restaurer
              </button>
            )}
          </div>
          <div className="historique__reglages">
            {selection !== ACTUELLE && (
              <div className="segments" role="radiogroup" aria-label="Comparer à">
                <button type="button" role="radio" aria-checked={mode === "precedente"} onClick={() => setMode("precedente")}>Ce qui a changé</button>
                <button type="button" role="radio" aria-checked={mode === "actuelle"} onClick={() => setMode("actuelle")}>Écart avec aujourd'hui</button>
              </div>
            )}
            <label className="interrupteur">
              <input type="checkbox" checked={surligner} onChange={(e) => setSurligner(e.target.checked)} />
              <span>Surligner les changements</span>
            </label>
          </div>
          <p className="historique__explication">
            {!surligner ? "Contenu de cette version, tel qu'il était."
              : selection === ACTUELLE ? (precedente ? "Ce qui a changé depuis la dernière version enregistrée." : "Aucune version plus ancienne : voici la page actuelle.")
              : modeEffectif === "precedente" ? (precedente ? "Ce que cette version a changé par rapport à la précédente." : "Première version connue de la page.")
              : "Ce que la restauration changerait : en vert ce qui reviendrait, barré ce qui partirait."}
          </p>
          {apres === undefined || avant === undefined ? (
            <div aria-busy="true">{[0, 1, 2].map((i) => <div key={i} className="squelette" />)}</div>
          ) : surligner ? (
            <VueDifferences avant={avant} apres={apres} />
          ) : (
            <pre className="apercu-texte">{apres || "Page vide."}</pre>
          )}
        </section>
      </main>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Rendu d'une comparaison : lignes inchangées repliées (2 lignes de contexte), mots ajoutés et retirés, navigation
// « 3 sur 12 » qui boucle.
// ---------------------------------------------------------------------------------------------

type Bloc =
  | { type: "lignes"; lignes: LigneDiff[]; changement: number | null }
  | { type: "replie"; lignes: LigneDiff[]; cle: number };

const CONTEXTE = 2;

function construireBlocs(lignes: LigneDiff[]): { blocs: Bloc[]; nbChangements: number } {
  const blocs: Bloc[] = [];
  let i = 0;
  let n = 0;
  while (i < lignes.length) {
    if (lignes[i].type !== "=") {
      let j = i;
      while (j < lignes.length && lignes[j].type !== "=") j++;
      blocs.push({ type: "lignes", lignes: lignes.slice(i, j), changement: n++ });
      i = j;
      continue;
    }
    let j = i;
    while (j < lignes.length && lignes[j].type === "=") j++;
    const run = lignes.slice(i, j);
    const avantChangement = i > 0;
    const apresChangement = j < lignes.length;
    const garderDebut = avantChangement ? CONTEXTE : 0;
    const garderFin = apresChangement ? CONTEXTE : 0;
    if (run.length > garderDebut + garderFin + 2) {
      if (garderDebut) blocs.push({ type: "lignes", lignes: run.slice(0, garderDebut), changement: null });
      blocs.push({ type: "replie", lignes: run.slice(garderDebut, run.length - garderFin), cle: i });
      if (garderFin) blocs.push({ type: "lignes", lignes: run.slice(run.length - garderFin), changement: null });
    } else {
      blocs.push({ type: "lignes", lignes: run, changement: null });
    }
    i = j;
  }
  return { blocs, nbChangements: n };
}

function Ligne({ l }: { l: LigneDiff }) {
  if (l.type === "~") {
    return (
      <div className="ligne-diff" data-type="~">
        {l.morceaux.map((m, k) => (m.type === "=" ? <span key={k}>{m.texte}</span>
          : m.type === "+" ? <ins key={k}>{m.texte}</ins> : <del key={k}>{m.texte}</del>))}
      </div>
    );
  }
  const t = l.texte === "" ? " " : l.texte;
  if (l.type === "+") return <div className="ligne-diff" data-type="+"><ins>{t}</ins></div>;
  if (l.type === "-") return <div className="ligne-diff" data-type="-"><del>{t}</del></div>;
  return <div className="ligne-diff" data-type="=">{t}</div>;
}

export function VueDifferences({ avant, apres }: { avant: string; apres: string }) {
  const lignes = useMemo(() => differencesLignes(avant, apres), [avant, apres]);
  const { blocs, nbChangements } = useMemo(() => construireBlocs(lignes), [lignes]);
  const b = useMemo(() => bilan(lignes), [lignes]);
  const [ouverts, setOuverts] = useState<Set<number>>(new Set());
  const [courant, setCourant] = useState(0);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { setOuverts(new Set()); setCourant(0); }, [avant, apres]);

  const aller = (k: number) => {
    if (!nbChangements) return;
    const n = ((k % nbChangements) + nbChangements) % nbChangements;
    setCourant(n);
    const el = ref.current?.querySelector<HTMLElement>(`[data-changement="${n}"]`);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
      el.classList.remove("clignote");
      void el.offsetWidth;
      el.classList.add("clignote");
    }
  };

  return (
    <div className="comparaison" ref={ref}>
      <div className="comparaison__resume" role="status">
        {nbChangements === 0 ? (
          <span>Aucune différence.</span>
        ) : (
          <>
            <span className="comparaison__bilan">
              {b.ajouts > 0 && <span className="comparaison__plus">+{b.ajouts} mot{b.ajouts > 1 ? "s" : ""}</span>}
              {b.retraits > 0 && <span className="comparaison__moins">−{b.retraits} mot{b.retraits > 1 ? "s" : ""}</span>}
              {b.ajouts === 0 && b.retraits === 0 && <span>Mise en forme seulement</span>}
            </span>
            <span className="comparaison__nav">
              <span>{courant + 1} sur {nbChangements}</span>
              <button type="button" className="bouton-icone" onClick={() => aller(courant - 1)} aria-label="Changement précédent"><ChevronUp size={18} /></button>
              <button type="button" className="bouton-icone" onClick={() => aller(courant + 1)} aria-label="Changement suivant"><ChevronDown size={18} /></button>
            </span>
          </>
        )}
      </div>
      <div className="comparaison__texte">
        {blocs.map((bl, k) => {
          if (bl.type === "replie" && !ouverts.has(bl.cle)) {
            return (
              <button key={k} type="button" className="comparaison__replie" onClick={() => setOuverts((s) => new Set(s).add(bl.cle))}>
                ··· {bl.lignes.length} ligne{bl.lignes.length > 1 ? "s" : ""} inchangée{bl.lignes.length > 1 ? "s" : ""}
              </button>
            );
          }
          return (
            <div key={k} className="comparaison__bloc" data-changement={bl.type === "lignes" && bl.changement !== null ? bl.changement : undefined}
              data-courant={bl.type === "lignes" && bl.changement === courant ? "true" : undefined}>
              {bl.lignes.map((l, m) => <Ligne key={m} l={l} />)}
            </div>
          );
        })}
      </div>
    </div>
  );
}
