// Vue Projets : tableau et kanban construits sur le frontmatter (statut, échéance, responsable, priorité).
// Changer un statut réécrit UNE ligne du fichier (`statut:`), rien d'autre.
import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type PageProjet } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe } from "../navigation";
import { Entete } from "./Entete";
import { IconePage } from "./Icone";
import { EtatVide } from "./EtatVide";
import { SqueletteListe } from "./Squelettes";
import { FolderKanban, Plus } from "lucide-react";
import { tonStatut, tactile } from "../outils";
import { plier, dossierDe } from "../../../shared/page.ts";

const ORDRE = ["à faire", "en cours", "à relire", "en pause", "terminé"];
const fmtDate = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

function dateCourte(s?: string): string {
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : fmtDate.format(d);
}

export function Projets() {
  const app = useApp();
  const [pages, setPages] = useState<PageProjet[] | null>(null);
  const [vue, setVue] = useState<"tableau" | "kanban">(() => {
    try { return (localStorage.getItem("carnet:vue-projets") as "tableau" | "kanban") || "kanban"; } catch { return "kanban"; }
  });
  const [cible, setCible] = useState<string | null>(null);

  const charger = useCallback(() => {
    api.projets().then((r) => setPages(r.pages)).catch(() => setPages([]));
  }, []);
  useEffect(() => { charger(); }, [charger]);
  useEffect(() => {
    let m: number | null = null;
    return ecouter((e) => {
      if (e.type === "modif" || e.type === "arbre") { if (m) window.clearTimeout(m); m = window.setTimeout(charger, 300); }
    });
  }, [charger]);
  useEffect(() => { try { localStorage.setItem("carnet:vue-projets", vue); } catch { /* navigation privée */ } }, [vue]);

  const statuts = useMemo(() => {
    const vus = new Map<string, string>();
    for (const s of ORDRE) vus.set(plier(s), s);
    for (const p of pages ?? []) { const s = p.meta.statut; if (s && !vus.has(plier(s))) vus.set(plier(s), s); }
    return [...vus.values()];
  }, [pages]);

  const changerStatut = async (p: PageProjet, statut: string) => {
    if (plier(p.meta.statut ?? "") === plier(statut)) return;
    setPages((ps) => ps?.map((x) => (x.chemin === p.chemin ? { ...x, meta: { ...x.meta, statut } } : x)) ?? null);
    try {
      await api.meta(p.chemin, { statut });
      app.notifier(`« ${p.titre} » passe en ${statut}`);
    } catch (e) {
      app.notifier(`Statut non modifié : ${(e as Error).message}`);
      charger();
    }
  };

  const Choix = ({ p }: { p: PageProjet }) => (
    <select className="choix-statut" data-ton={tonStatut(p.meta.statut)} value={statuts.find((s) => plier(s) === plier(p.meta.statut ?? "")) ?? ""}
      aria-label={`Statut de ${p.titre}`} onChange={(e) => void changerStatut(p, e.target.value)} onClick={(e) => e.stopPropagation()}>
      {!p.meta.statut && <option value="">sans statut</option>}
      {statuts.map((s) => <option key={s} value={s}>{s}</option>)}
    </select>
  );

  const parent = (c: string) => app.index.get(dossierDe(c) + ".md")?.titre ?? dossierDe(c);

  return (
    <>
      <Entete fil={[{ titre: "Projets" }]} />
      <main className="feuille" style={{ maxWidth: vue === "kanban" ? 1400 : undefined }}>
        <h1 className="accueil__salut" style={{ fontSize: 34 }}>Projets</h1>
        <p className="accueil__date">Tes projets et où ils en sont. Change un statut ici : seule cette ligne de la page est modifiée.</p>
        <div className="onglets" role="tablist" aria-label="Affichage">
          <button type="button" role="tab" aria-selected={vue === "kanban"} onClick={() => setVue("kanban")}>Kanban</button>
          <button type="button" role="tab" aria-selected={vue === "tableau"} onClick={() => setVue("tableau")}>Tableau</button>
        </div>
        {!pages && <SqueletteListe lignes={3} hauteur={72} />}
        {pages && pages.length === 0 && (
          <EtatVide
            icone={<FolderKanban size={26} />}
            titre="Aucun projet pour l'instant"
            texte={<>Une page devient un projet avec <code>tags: [projet]</code> et <code>statut: en cours</code> en tête du fichier.</>}
            actions={<button type="button" className="bouton bouton--primaire" onClick={() => void app.nouvellePage("")}><Plus size={18} /> Nouvelle page</button>}
          />
        )}
        {pages && pages.length > 0 && vue === "tableau" && (
          <div className="defile-x">
            <table className="tableau-projets">
              <thead><tr><th>Projet</th><th>Statut</th><th>Échéance</th><th>Responsable</th><th>Priorité</th></tr></thead>
              <tbody>
                {[...pages].sort((a, b) => (a.meta.echeance ?? "9999").localeCompare(b.meta.echeance ?? "9999")).map((p) => (
                  <tr key={p.chemin}>
                    <td>
                      <a href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })} style={{ display: "inline-flex", gap: 8, alignItems: "center" }}>
                        <IconePage icone={p.icone} /> {p.titre}
                      </a>
                    </td>
                    <td><Choix p={p} /></td>
                    <td>{dateCourte(p.meta.echeance)}</td>
                    <td>{p.meta.responsable ?? ""}</td>
                    <td>{p.meta.priorite ?? ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {pages && pages.length > 0 && vue === "kanban" && (
          <div className="kanban">
            {statuts.map((st) => {
              const cartes = pages.filter((p) => plier(p.meta.statut ?? "") === plier(st));
              return (
                <section key={st} className="colonne" data-cible={cible === st}
                  onDragOver={(e) => { if (e.dataTransfer.types.includes("application/x-carnet-projet")) { e.preventDefault(); setCible(st); } }}
                  onDragLeave={() => setCible((c) => (c === st ? null : c))}
                  onDrop={(e) => {
                    e.preventDefault(); setCible(null);
                    const c = e.dataTransfer.getData("application/x-carnet-projet");
                    const p = pages.find((x) => x.chemin === c);
                    if (p) void changerStatut(p, st);
                  }}>
                  <div className="colonne__titre">
                    <span className="pastille" data-ton={tonStatut(st)}>{st}</span>
                    <span className="colonne__compte">{cartes.length}</span>
                  </div>
                  {cartes.map((p) => (
                    <div key={p.chemin} className="carte-projet"
                      draggable={!tactile}
                      onDragStart={(e) => { e.dataTransfer.setData("application/x-carnet-projet", p.chemin); e.dataTransfer.effectAllowed = "move"; }}
                      onClick={(e) => { if ((e.target as HTMLElement).closest("select, a")) return; naviguer({ vue: "page", chemin: p.chemin }); }}>
                      <a className="carte-projet__titre" href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })}>{p.titre}</a>
                      <div className="carte-projet__meta">
                        {p.meta.echeance && <span>⏱ {dateCourte(p.meta.echeance)}</span>}
                        {p.meta.responsable && <span>{p.meta.responsable}</span>}
                        {p.meta.priorite && <span>priorité {p.meta.priorite}</span>}
                        <span>{parent(p.chemin)}</span>
                      </div>
                      {tactile && <Choix p={p} />}
                    </div>
                  ))}
                </section>
              );
            })}
          </div>
        )}
      </main>
    </>
  );
}
