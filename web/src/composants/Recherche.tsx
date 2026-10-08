// Recherche (⌘K ou bouton) : titres et contenus, sans accents. Sert aussi de sélecteur de page.
// À vide : pages consultées récemment, puis modifiées récemment. Sur ordinateur, aperçu de la page active à droite.
// Rien ne correspond : « Créer la page « … » ».
import { useEffect, useMemo, useRef, useState } from "react";
import { FilePlus, Search, X } from "lucide-react";
import { api, type Apercu, type Noeud, type Resultat } from "../api";
import { useApp } from "../contexte-app";
import { naviguer, pagesRecentes } from "../navigation";
import { Feuille } from "./Feuille";
import { IconePage } from "./Icone";
import { plier, dossierDe, nomDePage } from "../../../shared/page.ts";
import { ilYA, tactile } from "../outils";

const CREER = "__creer__";
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

interface Ligne { chemin: string; titre: string; icone: string | null; sous: string; avant?: string; extrait?: string; apres?: string; mtime?: number; groupe?: string }

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

  // Recherche serveur (titres + contenus), avec un premier filtre instantané sur les titres de l'arbre
  useEffect(() => {
    const t = texte.trim();
    if (!t) { setResultats(null); return; }
    const ctrl = new AbortController();
    const minuterie = window.setTimeout(() => {
      api.recherche(t, ctrl.signal).then((r) => setResultats(r.resultats)).catch(() => { /* interrompu */ });
    }, 90);
    return () => { window.clearTimeout(minuterie); ctrl.abort(); };
  }, [texte]);

  const lignes: Ligne[] = useMemo(() => {
    const t = plier(texte.trim());
    const chemin = (c: string) => {
      const d = dossierDe(c);
      if (!d) return "";
      return d.split("/").map((seg, i, tout) => index.get(tout.slice(0, i + 1).join("/") + ".md")?.titre ?? seg).join(" › ");
    };
    const pasDansExclu = (c: string) => !exclure || (c !== exclure && (!racine || !c.startsWith(exclure.replace(/\.md$/i, "") + "/")));
    if (!t) {
      const recentes = choix ? [] : pagesRecentes().map((c) => index.get(c)).filter((n): n is Noeud => !!n && pasDansExclu(n.chemin)).slice(0, 6);
      const vues = new Set(recentes.map((n) => n.chemin));
      const l: Ligne[] = recentes.map((n) => ({ chemin: n.chemin, titre: n.titre, icone: n.icone, sous: chemin(n.chemin), groupe: "Consultées récemment" }));
      l.push(...[...toutes].filter((n) => pasDansExclu(n.chemin) && n.type === "page" && !vues.has(n.chemin)).sort((a, b) => b.mtime - a.mtime)
        .slice(0, recentes.length ? 8 : 12)
        .map((n) => ({ chemin: n.chemin, titre: n.titre, icone: n.icone, sous: chemin(n.chemin), mtime: n.mtime, groupe: choix ? "Pages récentes" : "Modifiées récemment" })));
      if (racine) l.unshift({ chemin: "__racine__", titre: "Racine de l'espace", icone: "🏠", sous: "Tout en haut de l'arbre" });
      return l;
    }
    const vus = new Set<string>();
    const res: Ligne[] = [];
    for (const r of resultats ?? []) {
      if (!pasDansExclu(r.chemin) || vus.has(r.chemin) || (choix && !r.chemin.endsWith(".md"))) continue;
      vus.add(r.chemin);
      res.push({ chemin: r.chemin, titre: r.titre, icone: r.icone, sous: chemin(r.chemin), avant: propre(r.avant), extrait: r.extrait, apres: propre(r.apres) });
    }
    // Filtre local immédiat sur les titres (avant la réponse du serveur)
    if (resultats === null) {
      for (const n of toutes) {
        if (!pasDansExclu(n.chemin) || vus.has(n.chemin) || (choix && n.type !== "page")) continue;
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
  }, [texte, resultats, toutes, index, exclure, racine, choix]);

  useEffect(() => { setActif(0); }, [texte]);
  useEffect(() => {
    listeRef.current?.querySelector(`[data-i="${actif}"]`)?.scrollIntoView({ block: "nearest" });
  }, [actif]);

  // Aperçu de la ligne active (ordinateur) : demandé 120 ms après l'arrêt sur la ligne, gardé 30 s.
  const cheminActif = lignes[actif]?.chemin;
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
          placeholder={choix ? "Chercher une page à lier…" : "Chercher une page, un mot…"}
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
      <div className="recherche__zone">
      <ul className="recherche__liste" role="listbox" id="recherche-liste" aria-label="Résultats" ref={listeRef}>
        {lignes.map((l, i) => (
          <li key={l.chemin} role="presentation" style={{ display: "contents" }}>
          {l.groupe && l.groupe !== lignes[i - 1]?.groupe && <div className="recherche__groupe" role="presentation">{l.groupe}</div>}
          <div
            data-i={i}
            id={`recherche-option-${i}`}
            role="option"
            aria-selected={i === actif}
            className="resultat"
            data-creer={l.chemin === CREER ? "true" : undefined}
            onMouseMove={() => setActif(i)}
            onClick={() => choisir(l)}
          >
            <span className="resultat__icone">{l.chemin === CREER ? <FilePlus size={18} /> : <IconePage icone={l.icone} />}</span>
            <span className="resultat__texte">
              <div className="resultat__titre">{l.titre}</div>
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
