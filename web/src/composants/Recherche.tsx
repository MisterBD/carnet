// Recherche (⌘K ou bouton) : titres et contenus, sans accents. Sert aussi de sélecteur de page.
// À vide : pages consultées récemment, puis modifiées récemment. Sur ordinateur, aperçu de la page active à droite.
// Rien ne correspond : « Créer la page « … » ».
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus, Search, Table2, X } from "lucide-react";
import { api, type Apercu, type DestinationBase, type Noeud, type Resultat } from "../api";
import { destinationsBases, libelleAjout, lieuEntrees, nomEntrees } from "../ranger-base"; // K10-01
import { useApp } from "../contexte-app";
import { naviguer, pagesRecentes } from "../navigation";
import { Feuille } from "./Feuille";
import { IconePage } from "./Icone";
import { plier, dossierDe, nomDePage } from "../../../shared/page.ts";
import { ilYA, tactile } from "../outils";
import { useTechniques } from "../techniques";
import { estTechnique } from "../../../shared/techniques.ts";
import "../styles/pages.css"; // lot 6 : filtre « Inclure les archives »

const CREER = "__creer__";

/** K10-01 : ligne « Ajouter à <base> » (choisie, elle rend le dossier des entrées : `parent` de api.deplacer). */
function ligneBase(d: DestinationBase): Ligne {
  const lieu = lieuEntrees(d).split(" › ").slice(0, -1).join(" › ");
  return { chemin: d.parent, titre: libelleAjout(d), icone: null, sous: `Dossier ${nomEntrees(d)}${lieu ? ` · ${lieu}` : ""}`, groupe: "Ranger dans une base", base: true };
}
const cacheApercus = new Map<string, { t: number; a: Apercu }>();

/** Retire la syntaxe Markdown d'un extrait (affichage seulement). */
function propre(t: string | undefined): string {
  return (t ?? "")
    .replace(/\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][+-]?/gi, "")
    .replace(/(^|\s)[-*+] \[[ xX]\] /g, "$1")
    .replace(/\|\s*:?-{3,}:?\s*(?=\|)/g, "")
    .replace(/\*\*|__|`/g, "")
    .replace(/(^|\s)(#{1,6}|>|[-*+]|\d+\.)\s/g, "$1")
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g, (_m, c, a) => a ?? String(c).split("/").pop())
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\s*\|\s*/g, " · ")
    .replace(/\s+/g, " ");
}

interface Ligne { chemin: string; titre: string; icone: string | null; sous: string; avant?: string; extrait?: string; apres?: string; mtime?: number; groupe?: string; archive?: boolean; base?: boolean }

/** Lot 6 : préférence « Inclure les archives » (le temps de l'onglet). */
const CLE_ARCHIVES = "carnet:recherche-archives";

function aplatir(noeuds: Noeud[], res: Noeud[] = []): Noeud[] {
  for (const n of noeuds) {
    if (n.type === "page") res.push(n);
    aplatir(n.enfants, res);
  }
  return res;
}

export function Recherche({ arbre, index, titre = "Rechercher", choix = false, exclure, racine = false, onChoisir, onFermer }: {
  racine?: boolean;
  arbre: Noeud[];
  index: Map<string, Noeud>;
  titre?: string;
  choix?: boolean;
  exclure?: string;
  onChoisir: (chemin: string) => void;
  onFermer: () => void;
}) {
  const app = useApp();
  const [texte, setTexte] = useState("");
  const [resultats, setResultats] = useState<Resultat[] | null>(null);
  const [actif, setActif] = useState(0);
  const [apercu, setApercu] = useState<Apercu | null>(null);
  const [large] = useState(() => !choix && !tactile && window.matchMedia("(min-width: 900px)").matches);
  const listeRef = useRef<HTMLUListElement>(null);
  const toutes = useMemo(() => aplatir(arbre), [arbre]);
  // Lot 3 : les fichiers des agents ne figurent pas dans les listes à vide (récents) ; une recherche les trouve.
  const techniques = useTechniques();
  const quotidien = (c: string) => !techniques || !estTechnique(techniques, c);
  // Lot 6 : pages archivées (elles-mêmes ou sous une page archivée) hors des listes, sauf « Inclure les archives »
  const [archives, setArchives] = useState(() => { try { return sessionStorage.getItem(CLE_ARCHIVES) === "1"; } catch { return false; } });
  const changerArchives = (v: boolean) => { setArchives(v); try { sessionStorage.setItem(CLE_ARCHIVES, v ? "1" : "0"); } catch { /* privé */ } };
  const archivee = (c: string) => {
    const segs = c.replace(/\.md$/i, "").split("/");
    for (let i = segs.length; i > 0; i--) if (index.get(segs.slice(0, i).join("/") + ".md")?.archive) return true;
    return false;
  };

  // K10-01 : en mode « Déplacer vers… », les bases de l'espace sont des destinations explicites (« Ajouter à … »)
  const [bases, setBases] = useState<DestinationBase[]>([]);
  useEffect(() => {
    if (!racine) return;
    let vivant = true;
    destinationsBases(true).then((l) => { if (vivant) setBases(l.filter((d) => !exclure || d.parent !== exclure)); }).catch(() => {});
    return () => { vivant = false; };
  }, [racine, exclure]);

  // Recherche serveur (titres + contenus), avec un premier filtre instantané sur les titres de l'arbre
  useEffect(() => {
    const t = texte.trim();
    if (!t) { setResultats(null); return; }
    const ctrl = new AbortController();
    const minuterie = window.setTimeout(() => {
      api.recherche(t, ctrl.signal, archives).then((r) => setResultats(r.resultats)).catch(() => { /* interrompu */ });
    }, 90);
    return () => { window.clearTimeout(minuterie); ctrl.abort(); };
  }, [texte, archives]);

  const lignes: Ligne[] = useMemo(() => {
    const t = plier(texte.trim());
    const chemin = (c: string) => {
      const d = dossierDe(c);
      if (!d) return "";
      return d.split("/").map((seg, i, tout) => index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ");
    };
    const pasDansExclu = (c: string) => !exclure || (c !== exclure && (!racine || !c.startsWith(exclure.replace(/\.md$/i, "") + "/")));
    if (!t) {
      const recentes = choix ? [] : pagesRecentes().map((c) => index.get(c)).filter((n): n is Noeud => !!n && pasDansExclu(n.chemin) && quotidien(n.chemin) && !archivee(n.chemin)).slice(0, 6);
      const vues = new Set(recentes.map((n) => n.chemin));
      const l: Ligne[] = recentes.map((n) => ({ chemin: n.chemin, titre: n.titre, icone: n.icone, sous: chemin(n.chemin), groupe: "Consultées récemment" }));
      l.push(...[...toutes].filter((n) => pasDansExclu(n.chemin) && n.type === "page" && !vues.has(n.chemin) && quotidien(n.chemin) && !archivee(n.chemin)).sort((a, b) => b.mtime - a.mtime)
        .slice(0, recentes.length ? 8 : 12)
        .map((n) => ({ chemin: n.chemin, titre: n.titre, icone: n.icone, sous: chemin(n.chemin), mtime: n.mtime, groupe: choix ? "Pages récentes" : "Modifiées récemment" })));
      if (racine) l.unshift({ chemin: "__racine__", titre: "Racine de l'espace", icone: "🏠", sous: "Tout en haut de l'arbre" });
      if (bases.length) l.unshift(...bases.map((d) => ligneBase(d)));
      return l;
    }
    const vus = new Set<string>();
    const res: Ligne[] = bases.filter((d) => t.split(/\s+/).every((m) => plier(d.titre + " " + d.dossier).includes(m))).map((d) => ligneBase(d));
    for (const r of resultats ?? []) {
      if (!pasDansExclu(r.chemin) || vus.has(r.chemin) || (choix && !r.chemin.endsWith(".md"))) continue;
      vus.add(r.chemin);
      res.push({ chemin: r.chemin, titre: r.titre, icone: r.icone, sous: chemin(r.chemin), avant: propre(r.avant), extrait: r.extrait, apres: propre(r.apres), archive: r.archive || archivee(r.chemin) });
    }
    // Filtre local immédiat sur les titres (avant la réponse du serveur)
    if (resultats === null) {
      for (const n of toutes) {
        if (!pasDansExclu(n.chemin) || vus.has(n.chemin) || (choix && n.type !== "page") || (!archives && archivee(n.chemin))) continue;
        if (t.split(/\s+/).every((m) => plier(n.titre + " " + n.nom).includes(m))) {
          res.push({ chemin: n.chemin, titre: n.titre, icone: n.icone, sous: chemin(n.chemin) });
        }
      }
    }
    const l = res.slice(0, 40);
    if (!choix && resultats !== null && !l.some((x) => plier(x.titre) === t)) {
      l.push({ chemin: CREER, titre: `Créer la page « ${texte.trim()} »`, icone: null, sous: "À la racine de l'espace" });
    }
    return l;
  }, [texte, resultats, toutes, index, exclure, racine, choix, techniques, archives, bases]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setActif(0); }, [texte]);
  useEffect(() => {
    listeRef.current?.querySelector(`[data-i="${actif}"]`)?.scrollIntoView({ block: "nearest" });
  }, [actif]);

  // Aperçu de la ligne active (ordinateur) : demandé 120 ms après l'arrêt sur la ligne, gardé 30 s.
  const cheminActif = lignes[actif]?.base ? undefined : lignes[actif]?.chemin;
  useEffect(() => {
    if (!large || !cheminActif || cheminActif === CREER || cheminActif === "__racine__" || !cheminActif.endsWith(".md")) { setApercu(null); return; }
    const c = cacheApercus.get(cheminActif);
    if (c && Date.now() - c.t < 30_000) { setApercu(c.a); return; }
    const ctrl = new AbortController();
    const m = window.setTimeout(() => {
      api.apercu(cheminActif, ctrl.signal).then((a) => { cacheApercus.set(cheminActif, { t: Date.now(), a }); setApercu(a); }).catch(() => {});
    }, 120);
    return () => { window.clearTimeout(m); ctrl.abort(); };
  }, [large, cheminActif]);

  const lieuDe = (c: string) => {
    const d = dossierDe(c);
    return d ? d.split("/").map((seg, i, tout) => index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ") : "";
  };

  const creer = async (titre: string) => {
    onFermer();
    try {
      const r = await api.creer("", titre);
      await app.rechargerArbre();
      naviguer({ vue: "page", chemin: r.chemin });
    } catch (e) {
      app.notifier(`Page non créée : ${(e as Error).message}`);
    }
  };

  const choisir = (l?: Ligne) => {
    if (!l) return;
    if (l.chemin === CREER) { void creer(texte.trim()); return; }
    onChoisir(l.chemin);
  };

  return (
    <Feuille onFermer={onFermer} enHaut sansTete etiquette={titre} large={large}>
      <div className="recherche__champ">
        <Search size={20} />
        <input
          type="text"
          inputMode="search"
          enterKeyHint="go"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          placeholder={racine ? "Chercher une page ou une base…" : choix ? "Chercher une page à lier…" : "Chercher une page, un mot…"}
          aria-label={titre}
          role="combobox"
          aria-expanded={lignes.length > 0}
          aria-controls="recherche-liste"
          aria-autocomplete="list"
          aria-activedescendant={lignes.length ? `recherche-option-${actif}` : undefined}
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActif((a) => Math.min(a + 1, lignes.length - 1)); }
            else if (e.key === "ArrowUp") { e.preventDefault(); setActif((a) => Math.max(a - 1, 0)); }
            else if (e.key === "Enter") { e.preventDefault(); choisir(lignes[actif]); }
          }}
        />
        <button type="button" className="bouton-icone" onClick={onFermer} aria-label="Fermer">
          <X size={20} />
        </button>
      </div>
      <div className="recherche__filtres">
        <label className="recherche-archives">
          <input type="checkbox" checked={archives} onChange={(e) => changerArchives(e.target.checked)} />
          Inclure les archives
        </label>
      </div>
      <div className="recherche__zone">
      <ul className="recherche__liste" role="listbox" id="recherche-liste" aria-label="Résultats" ref={listeRef}>
        {lignes.map((l, i) => (
          <li key={(l.base ? "base:" : "") + l.chemin} role="presentation" style={{ display: "contents" }}>
          {l.groupe && l.groupe !== lignes[i - 1]?.groupe && <div className="recherche__groupe" role="presentation">{l.groupe}</div>}
          <div
            data-i={i}
            id={`recherche-option-${i}`}
            role="option"
            aria-selected={i === actif}
            className="resultat"
            data-creer={l.chemin === CREER ? "true" : undefined}
            data-base={l.base ? "true" : undefined}
            onMouseMove={() => setActif(i)}
            onClick={() => choisir(l)}
          >
            <span className="resultat__icone">{l.chemin === CREER ? <FilePlus size={18} /> : l.base ? <Table2 size={18} aria-hidden="true" /> : <IconePage icone={l.icone} />}</span>
            <span className="resultat__texte">
              <div className="resultat__titre">{l.titre}{l.archive && <span className="pastille-archivee">Archivée</span>}</div>
              <div className="resultat__chemin">{l.sous || "Racine"}{l.mtime ? ` · ${ilYA(l.mtime)}` : ""}</div>
              {l.extrait && (
                <div className="resultat__extrait">{l.avant}<mark>{l.extrait}</mark>{l.apres}</div>
              )}
            </span>
          </div>
          </li>
        ))}
        {texte.trim() && resultats !== null && lignes.length === 0 && (
          <li className="recherche__vide" role="presentation">Rien ne correspond à « {texte.trim()} ». Essaie un autre mot.</li>
        )}
      </ul>
      {large && (
        <aside className="recherche__apercu" aria-label="Aperçu">
          {apercu && cheminActif === apercu.chemin ? (
            <>
              <div className="apercu__icone"><IconePage icone={apercu.icone} taille={30} /></div>
              <div className="apercu__titre">{apercu.titre}</div>
              <div className="apercu__meta">{lieuDe(apercu.chemin) || "Racine"} · modifiée {ilYA(apercu.mtime)}
                {apercu.sousPages > 0 && ` · ${apercu.sousPages} sous-page${apercu.sousPages > 1 ? "s" : ""}`}</div>
              {apercu.resume && <p className="apercu__resume">{apercu.resume}</p>}
              <p className="apercu__extrait">{propre(apercu.extrait) || "Page vide."}</p>
            </>
          ) : (
            <p className="apercu__vide">{cheminActif === CREER ? "Une page vide sera créée à la racine, avec ce titre." : "Choisis une page pour la voir ici."}</p>
          )}
        </aside>
      )}
      </div>
    </Feuille>
  );
}

export { nomDePage };
