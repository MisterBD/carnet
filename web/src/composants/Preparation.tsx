// Dossier de rendez-vous (lot 11) : aperçu d'une préparation assemblée par le serveur depuis les
// sources d'une fiche (rien n'est écrit), puis « Conserver cette préparation » = NOUVELLE page dans Préparations/.
// iPhone d'abord : sections repliables, chaque extrait ouvre sa source, bandeau de couverture, actions en bas d'écran.
// Tout le texte vient des fichiers : affiché comme du texte (React échappe), jamais interprété comme HTML.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Check, ChevronDown, CircleDashed, ClipboardList, ExternalLink, FileCheck, FileText, FileX, Gavel, ListChecks, Lock, NotebookText, Package,
  RefreshCw, Square, TriangleAlert,
} from "lucide-react";
import { api, ErreurApi, nouvelleRequete, type ApercuPreparation, type RefPagePrep, type RevisionPrep, type SourcePrep } from "../api";
import { useApp, ancetres } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe, type Route } from "../navigation";
import { Entete, type MaillonFil } from "./Entete";
import { EtatVide } from "./EtatVide";
import { ilYA } from "../outils";
import { feuille } from "../../../shared/page.ts";

const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric" });
const fmtJourCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });
const fmtComplet = new Intl.DateTimeFormat("fr-FR", { dateStyle: "long", timeStyle: "short" });

function jour(iso: string): string {
  const [a, m, j] = iso.slice(0, 10).split("-").map(Number);
  const d = new Date(a, m - 1, j);
  return (a === new Date().getFullYear() ? fmtJourCourt : fmtJour).format(d);
}

function lien(chemin: string): Route {
  return { vue: "page", chemin };
}

function LienPage({ chemin, children, className }: { chemin: string; children: ReactNode; className?: string }) {
  const r = lien(chemin);
  return <a className={className} href={urlDe(r)} onClick={(e) => surLienInterne(e, r)}>{children}</a>;
}

function Revision({ r }: { r: RevisionPrep }) {
  return (
    <span className="prep-rev" title={`Révision lue : ${r.etag} · fichier modifié le ${fmtComplet.format(new Date(r.mtime))}`}>
      rév. <code>{r.court}</code> · {jour(r.modifiee)}
    </span>
  );
}

function Quand({ r }: { r: RevisionPrep }) {
  return <span className="prep-quand" title={`Révision lue : ${r.etag}`}>{jour(r.modifiee)}</span>;
}

function Provenance({ source }: { source: RefPagePrep }) {
  return (
    <span className="prep-provenance">
      <LienPage chemin={source.chemin} className="prep-provenance__page">{source.titre}</LienPage>
      <Quand r={source.revision} />
    </span>
  );
}

// ---------- Sections repliables (état d'interface gardé dans le navigateur) ----------

const CLE_REPLIS = "carnet:preparation:replis";

function lireReplis(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(CLE_REPLIS) ?? "[]")); } catch { return new Set(); }
}

function Section({ id, titre, icone, nombre, replie, basculer, children }: {
  id: string; titre: string; icone: ReactNode; nombre: number; replie: boolean; basculer: (id: string) => void; children: ReactNode;
}) {
  return (
    <section className="prep-section" aria-labelledby={`prep-${id}`} data-replie={replie ? "true" : undefined}>
      <h2 className="prep-section__titre" id={`prep-${id}`}>
        <button type="button" aria-expanded={!replie} aria-controls={`prep-${id}-corps`} onClick={() => basculer(id)}>
          <span className="prep-section__icone" aria-hidden="true">{icone}</span>
          <span className="prep-section__libelle">{titre}</span>
          <span className="prep-section__nombre" aria-label={`${nombre} élément${nombre > 1 ? "s" : ""}`}>{nombre}</span>
          <ChevronDown className="prep-section__chevron" size={18} aria-hidden="true" />
        </button>
      </h2>
      <div className="prep-section__corps" id={`prep-${id}-corps`} hidden={replie}>{children}</div>
    </section>
  );
}

// ---------- Couverture ----------

/** Le concret d'abord : « Contrat signé introuvable · une autre source inaccessible ». */
function resumeCouverture(a: ApercuPreparation): { incomplet: boolean; texte: string } {
  const c = a.couverture;
  const noms = a.sources.filter((s) => s.etat === "introuvable").map((s) => s.nom || s.brut);
  const m: string[] = [];
  if (noms.length) m.push(`${noms.slice(0, 2).join(", ")}${noms.length > 2 ? ` et ${noms.length - 2} autres` : ""} introuvable${noms.length > 1 ? "s" : ""}`);
  if (c.nonAccessibles) {
    m.push(noms.length ? (c.nonAccessibles > 1 ? `${c.nonAccessibles} autres sources inaccessibles` : "une autre source inaccessible")
      : (c.nonAccessibles > 1 ? `${c.nonAccessibles} sources inaccessibles` : "une source inaccessible"));
  }
  if (c.tronquee) m.push("liste tronquée (trop de pages)");
  if (c.entreesIgnorees) m.push(`${c.entreesIgnorees} sources au-delà de 50 ignorées`);
  return m.length ? { incomplet: true, texte: m.join(" · ") } : { incomplet: false, texte: `${c.lues} ${c.lues > 1 ? "sources lues" : "source lue"}` };
}

const ORIGINES: Record<string, string> = {
  fiche: "la fiche", source: "source", dossier: "dans un dossier source", mission: "mission rattachée", decision: "décision d'une mission", livrable: "livrable d'une mission",
};

function Couverture({ a }: { a: ApercuPreparation }) {
  const [ouvert, setOuvert] = useState(false);
  const r = resumeCouverture(a);
  const autres = a.sources.filter((s) => s.etat === "introuvable" || s.etat === "non_accessible" || s.etat === "externe" || s.tronque);
  return (
    <div className="prep-couverture" data-incomplet={r.incomplet ? "true" : undefined} role="status">
      <div className="prep-couverture__ligne">
        {r.incomplet ? <TriangleAlert size={18} aria-hidden="true" /> : <Check size={18} aria-hidden="true" />}
        <p className="prep-couverture__texte">{r.texte}</p>
        <button type="button" className="prep-couverture__detail" aria-expanded={ouvert} onClick={() => setOuvert((o) => !o)}>
          {ouvert ? "Masquer les sources" : "Voir les sources"}
        </button>
      </div>
      {ouvert && (
        <div className="prep-sources">
          <p className="prep-sources__titre">{a.couverture.lues} {a.couverture.lues > 1 ? "sources lues" : "source lue"}, plus la fiche</p>
          <ul>
            {a.pages.map((p) => (
              <li key={p.chemin} className="prep-sources__ligne">
                <span className="prep-sources__nom">
                  <LienPage chemin={p.chemin}>{p.titre}</LienPage>
                  <span className="prep-sources__chemin">{ORIGINES[p.origine] ?? p.origine} · <Revision r={p.revision} /></span>
                  <span className="prep-sources__chemin">{p.chemin.replace(/\.md$/i, "")}</span>
                </span>
              </li>
            ))}
            {autres.map((s, i) => (
              <li key={`x${i}`} className="prep-sources__ligne">
                <span className="prep-sources__nom">
                  {s.etat === "non_accessible" ? <span>Source non accessible</span> : <span>{s.nom || s.brut || feuille(s.chemin ?? "")}</span>}
                  {s.etat === "non_accessible" && <span className="prep-sources__chemin">zone masquée ou réservée : ni titre ni chemin affichés</span>}
                  {s.etat === "introuvable" && <span className="prep-sources__chemin">{s.brut}</span>}
                  {s.tronque && <span className="prep-sources__chemin">{s.pages} pages lues sur {s.total}</span>}
                </span>
                <span className="pastille" data-ton={s.etat === "introuvable" ? "rouge" : s.etat === "externe" ? "gris" : "ambre"}>
                  {s.etat === "introuvable" ? "introuvable" : s.etat === "non_accessible" ? "inaccessible" : s.etat === "externe" ? "lien externe, non récupéré" : "tronqué"}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// ---------- Écran ----------

type Etat =
  | { type: "chargement" }
  | { type: "pret"; a: ApercuPreparation }
  | { type: "erreur"; statut: number; raison: string; message: string };

export function Preparation({ chemin }: { chemin: string }) {
  const app = useApp();
  const [etat, setEtat] = useState<Etat>({ type: "chargement" });
  const [replis, setReplis] = useState<Set<string>>(lireReplis);
  const [occupe, setOccupe] = useState<"regenerer" | "conserver" | null>(null);
  const [conservee, setConservee] = useState<{ chemin: string; empreinte: string } | null>(null);
  const [perime, setPerime] = useState<"source" | "conflit" | null>(null);
  const requete = useRef<{ empreinte: string; id: string } | null>(null);
  const titreFiche = app.index.get(chemin)?.titre ?? feuille(chemin);

  const charger = useCallback(async (regenerer = false) => {
    if (regenerer) setOccupe("regenerer");
    try {
      const a = await api.preparation(chemin);
      setEtat((avant) => {
        if (regenerer && avant.type === "pret") app.notifier(avant.a.empreinte === a.empreinte ? "Aperçu actualisé : rien n'a changé" : "Aperçu actualisé");
        return { type: "pret", a };
      });
      setPerime(null);
    } catch (e) {
      if (e instanceof ErreurApi) setEtat({ type: "erreur", statut: e.statut, raison: String(e.corps.raison ?? ""), message: e.message });
      else setEtat({ type: "erreur", statut: 0, raison: "reseau", message: "Carnet ne répond pas." });
    } finally {
      setOccupe(null);
    }
  }, [chemin, app]);

  useEffect(() => { void charger(); }, [charger]);

  // Une source change pendant la lecture : on le dit, sans remplacer l'aperçu sous les yeux.
  const pret = etat.type === "pret" ? etat.a : null;
  useEffect(() => {
    if (!pret) return;
    const lues = new Set(pret.pages.map((p) => p.chemin));
    return ecouter((ev) => {
      if (ev.type === "modif" && lues.has(ev.chemin)) {
        const p = pret.pages.find((x) => x.chemin === ev.chemin);
        if (p && ev.etag.replace(/"/g, "") !== p.revision.etag) setPerime("source");
      }
    });
  }, [pret]);

  const basculer = useCallback((id: string) => {
    setReplis((r) => {
      const n = new Set(r);
      if (n.has(id)) n.delete(id); else n.add(id);
      try { localStorage.setItem(CLE_REPLIS, JSON.stringify([...n])); } catch { /* navigation privée */ }
      return n;
    });
  }, []);

  const conserver = async () => {
    if (!pret || occupe) return;
    // un identifiant par geste (et par aperçu) : un renvoi après une coupure ne crée pas de doublon
    if (!requete.current || requete.current.empreinte !== pret.empreinte + pret.genere) requete.current = { empreinte: pret.empreinte + pret.genere, id: nouvelleRequete() };
    setOccupe("conserver");
    try {
      let r: { chemin: string; rejoue: boolean };
      try {
        r = await api.conserverPreparation(pret, requete.current.id);
      } catch (e) {
        if (e instanceof ErreurApi) throw e;
        r = await api.conserverPreparation(pret, requete.current.id); // réseau : un renvoi, même identifiant
      }
      setConservee({ chemin: r.chemin, empreinte: pret.empreinte });
      void app.rechargerArbre();
      app.notifier("Préparation conservée", { libelle: "Ouvrir", faire: () => naviguer(lien(r.chemin)) });
    } catch (e) {
      if (e instanceof ErreurApi && e.statut === 409 && e.corps.raison === "apercu_perime") {
        requete.current = null;
        setPerime("conflit");
        await charger();
        setPerime("conflit");
      } else {
        app.notifier(`Préparation non conservée : ${(e as Error).message}`);
      }
    } finally {
      setOccupe(null);
    }
  };

  const fil: MaillonFil[] = [
    ...ancetres(chemin).map((c) => ({ titre: app.index.get(c)?.titre ?? feuille(c), route: lien(c) })),
    { titre: titreFiche, route: lien(chemin) },
    { titre: "Préparation" },
  ];

  if (etat.type === "chargement") {
    return (
      <>
        <Entete fil={fil} />
        <main className="feuille prep" aria-busy="true">
          <div className="squelette squelette--titre" style={{ width: "60%" }} />
          <div className="squelette" style={{ height: 52 }} />
          <div className="squelette squelette--carte" />
          <div className="squelette squelette--carte" />
        </main>
      </>
    );
  }

  if (etat.type === "erreur") {
    const sans = etat.raison === "sans_sources";
    return (
      <>
        <Entete fil={fil} />
        <main className="feuille prep">
          <EtatVide
            icone={sans ? <ClipboardList size={26} /> : <TriangleAlert size={26} />}
            titre={sans ? "Cette page n'a pas de sources" : etat.statut === 404 ? "Cette page n'existe pas" : "Préparation impossible"}
            texte={sans ? (
              <>Ajoute une propriété <code>sources</code> à la fiche, avec des liens vers ses comptes rendus, décisions ou dossiers :
                <code className="prep-exemple">{"sources:\n  - \"[[Clients/Atelier Nord/Compte rendu]]\"\n  - \"[[Clients/Atelier Nord/]]\""}</code></>
            ) : etat.message}
            actions={<>
              <button type="button" className="bouton" onClick={() => naviguer(lien(chemin))}>Revenir à la page</button>
              {!sans && etat.statut !== 404 && <button type="button" className="bouton bouton--primaire" onClick={() => void charger()}>Réessayer</button>}
            </>}
          />
        </main>
      </>
    );
  }

  const a = etat.a;
  const dejaConservee = conservee !== null && conservee.empreinte === a.empreinte;
  const aConfirmer = a.decisions.filter((d) => d.aConfirmer);
  const prises = a.decisions.filter((d) => !d.aConfirmer);
  return (
    <>
      <Entete fil={fil} />
      <main className="feuille prep" lang="fr">
        <header className="prep__tete">
          <p className="prep__surtitre"><ClipboardList size={15} aria-hidden="true" /> Dossier de rendez-vous</p>
          <h1 className="prep__titre">{a.fiche.titre}</h1>
          <p className="prep__meta">Décisions, tâches, notes et livrables tirés des sources de la fiche, prêts pour ton rendez-vous.</p>
          <p className="prep__aide">
            Assemblé le {jour(a.genere)} à {a.genere.slice(11, 16)}, sans IA, depuis <LienPage chemin={a.fiche.chemin}>{a.fiche.titre}</LienPage>.
            Rien n'est enregistré tant que tu ne le conserves pas.
          </p>
        </header>

        <Couverture a={a} />

        {perime && (
          <div className="bandeau prep-bandeau" role="alert">
            <p>{perime === "conflit"
              ? "Les sources avaient changé : voici l'aperçu à jour. Vérifie-le avant de le conserver."
              : "Une source a changé depuis cet aperçu."}</p>
            {perime === "source" && <button type="button" className="primaire" onClick={() => void charger(true)}>Actualiser l'aperçu</button>}
          </div>
        )}
        {dejaConservee && (
          <div className="prep-conservee" role="status">
            <Check size={18} aria-hidden="true" />
            <p>Conservée dans <LienPage chemin={conservee!.chemin}>{feuille(conservee!.chemin)}</LienPage></p>
          </div>
        )}

        {aConfirmer.length > 0 && (
          <Section id="decisions-a-confirmer" titre="Décisions à confirmer" icone={<Gavel size={18} />} nombre={aConfirmer.length} replie={replis.has("decisions-a-confirmer")} basculer={basculer}>
            {aConfirmer.map((d) => (
              <article key={d.source.chemin} className="prep-carte">
                <div className="prep-carte__haut">
                  <LienPage chemin={d.source.chemin} className="prep-carte__titre">{d.source.titre}</LienPage>
                  <Quand r={d.source.revision} />
                </div>
                <div className="prep-carte__pastilles"><span className="pastille" data-ton="ambre">Validation attendue</span></div>
                {d.extrait && <p className="prep-extrait">{d.extrait}</p>}
              </article>
            ))}
          </Section>
        )}

        <Section id="decisions-prises" titre="Décisions prises" icone={<Gavel size={18} />} nombre={prises.length} replie={replis.has("decisions-prises")} basculer={basculer}>
          {prises.length === 0 && <p className="prep-vide">Aucune décision prise dans les sources.</p>}
          {prises.map((d) => (
            <article key={d.source.chemin} className="prep-carte">
              <div className="prep-carte__haut">
                <LienPage chemin={d.source.chemin} className="prep-carte__titre">{d.source.titre}</LienPage>
                <Quand r={d.source.revision} />
              </div>
              <div className="prep-carte__pastilles">
                <span className="pastille" data-ton={d.preuve?.etat === "valide" ? "vert" : "gris"}>{d.statut ?? "statut non renseigné"}</span>
                {d.preuve?.etat === "valide"
                  ? <span className="prep-carte__note">{d.preuve.geste === "cle-d-acces" ? "geste prouvé (clé d'accès)" : "attestée, geste non prouvé"}</span>
                  : <span className="prep-carte__note">{d.preuve?.etat === "perimee" ? "attestation périmée" : d.preuve?.etat === "remplacee" ? "attestation remplacée" : "non attestée"}</span>}
              </div>
              {d.extrait && <p className="prep-extrait">{d.extrait}</p>}
            </article>
          ))}
          {a.masques.decisions > 0 && <p className="prep-plus">{a.masques.decisions} autres décisions non affichées (limite).</p>}
        </Section>

        <Section id="taches" titre="Tâches ouvertes" icone={<ListChecks size={18} />} nombre={a.taches.length} replie={replis.has("taches")} basculer={basculer}>
          {a.taches.length === 0 && <p className="prep-vide">Aucune tâche ouverte dans les sources.</p>}
          {a.taches.length > 0 && (
            <ul className="prep-taches">
              {a.taches.map((t) => (
                <li key={`${t.source.chemin}:${t.ligne}`} className="prep-tache">
                  <span className="prep-tache__case" aria-hidden="true">{t.enCours ? <CircleDashed size={19} /> : <Square size={19} />}</span>
                  <div className="prep-tache__corps">
                    <LienPage chemin={t.source.chemin} className="prep-tache__texte">{t.texte}</LienPage>
                    <div className="prep-tache__meta">
                      {t.echeance && <span className="pastille" data-ton={t.enRetard ? "rouge" : "bleu"}>{t.enRetard ? `en retard · ${jour(t.echeance)}` : `échéance ${jour(t.echeance)}`}</span>}
                      {t.enCours && <span className="pastille" data-ton="violet">en cours</span>}
                      {t.priorite && <span className="pastille pastille--etiquette">priorité {t.priorite}</span>}
                      {t.anomalies.length > 0 && <span className="pastille" data-ton="ambre" title={t.anomalies.join(" ; ")}>à vérifier</span>}
                      <Provenance source={t.source} />
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {a.masques.taches > 0 && <p className="prep-plus">{a.masques.taches} autres tâches non affichées (limite de 150).</p>}
        </Section>

        <Section id="notes" titre="Notes récentes" icone={<NotebookText size={18} />} nombre={a.notes.length} replie={replis.has("notes")} basculer={basculer}>
          {a.notes.length === 0 && <p className="prep-vide">Aucune source modifiée depuis 30 jours.</p>}
          {a.notes.map((n) => (
            <article key={n.source.chemin} className="prep-carte">
              <div className="prep-carte__haut">
                <LienPage chemin={n.source.chemin} className="prep-carte__titre"><FileText size={16} aria-hidden="true" /> {n.source.titre}</LienPage>
                <span className="prep-quand" title={`Révision lue : ${n.source.revision.etag}`}>{ilYA(n.source.revision.mtime)}</span>
              </div>
              {n.extrait && <p className="prep-extrait">{n.extrait}</p>}
            </article>
          ))}
          {a.masques.notesAnciennes > 0 && (
            <p className="prep-plus">{a.masques.notesAnciennes > 1 ? `${a.masques.notesAnciennes} sources plus anciennes (plus de 30 jours) non reprises.` : "1 source plus ancienne (plus de 30 jours) non reprise."}</p>
          )}
        </Section>

        <Section id="livrables" titre="Livrables" icone={<Package size={18} />} nombre={a.livrables.length} replie={replis.has("livrables")} basculer={basculer}>
          {a.livrables.length === 0 && <p className="prep-vide">Aucun livrable dans les sources.</p>}
          {a.livrables.length > 0 && (
            <ul className="prep-livrables">
              {a.livrables.map((l, i) => (
                <li key={i} className="prep-livrable" data-etat={l.etat}>
                  <span className="prep-livrable__icone" aria-hidden="true">
                    {l.etat === "present" ? <FileCheck size={19} /> : l.etat === "externe" ? <ExternalLink size={19} /> : l.etat === "non_accessible" ? <Lock size={19} /> : <FileX size={19} />}
                  </span>
                  <div className="prep-livrable__corps">
                    {l.etat === "present" && l.chemin ? (
                      <LienPage chemin={l.dossier ? l.chemin + ".md" : l.chemin} className="prep-livrable__titre">{l.titre}</LienPage>
                    ) : l.etat === "externe" && l.url ? (
                      <a className="prep-livrable__titre" href={l.url} target="_blank" rel="noopener noreferrer">{l.titre}</a>
                    ) : (
                      <span className="prep-livrable__titre">{l.titre}</span>
                    )}
                    <div className="prep-livrable__meta">
                      {l.etat === "absent" && <span className="pastille" data-ton="rouge">livrable absent</span>}
                      {l.etat === "externe" && <span className="pastille" data-ton="gris">lien externe, non vérifié</span>}
                      {l.etat === "non_accessible" && <span className="pastille" data-ton="ambre">non accessible</span>}
                      {l.mission && (
                        <span className="prep-livrable__mission">
                          mission <LienPage chemin={l.mission.chemin}>{l.mission.titre}</LienPage>{l.mission.etat ? ` · ${l.mission.etat} (déclaré)` : ""}
                        </span>
                      )}
                      {l.revision && <Quand r={l.revision} />}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Section>

        <div className="prep-actions">
          <button type="button" className="bouton prep-actions__regenerer" onClick={() => void charger(true)} disabled={occupe !== null} aria-busy={occupe === "regenerer"}
            aria-label="Actualiser l'aperçu" title="Actualiser l'aperçu (relire les sources)">
            <RefreshCw size={18} aria-hidden="true" className={occupe === "regenerer" ? "prep-tourne" : undefined} />
            <span className="prep-actions__libelle">Actualiser</span>
          </button>
          <button type="button" className="bouton bouton--primaire" onClick={() => void conserver()} disabled={occupe !== null || dejaConservee} aria-busy={occupe === "conserver"}>
            {dejaConservee ? <><Check size={17} aria-hidden="true" /> Conservée</> : "Conserver cette préparation"}
          </button>
        </div>
      </main>
    </>
  );
}
