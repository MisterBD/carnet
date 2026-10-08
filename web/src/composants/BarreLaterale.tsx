// Barre latérale : marque, recherche, accueil / projets, favoris, arbre des pages, corbeille, « Nouvelle page ».
// Sur iPhone c'est un tiroir (bouton en haut à gauche), ouvert défilé sur la page courante.
// Arbre : glisser-déposer avec repère d'insertion (haut de ligne = avant, bas = après, milieu = dedans), dépliage
// automatique après 500 ms de survol, ligne déposée qui clignote ; flèches du clavier (modèle ARIA « arbre ») ;
// appui long (iPhone) ou « … » = menu de la page.
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { ChevronRight, Plus, MoreHorizontal, House, KanbanSquare, Search, Star, Trash2 } from "lucide-react";
import { api, type Noeud, type Position } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { naviguer, surLienInterne, urlDe, type Route } from "../navigation";
import { IconePage, Sceau } from "./Icone";
import { EtatVide } from "./EtatVide";
import { SqueletteArbre } from "./Squelettes";
import { classes, tactile } from "../outils";
import "../styles/navigation.css";

const MIME_GLISSER = "application/x-carnet-page";
// Page en cours de glissement, connue tout de suite (l'état React n'est à jour qu'au rendu suivant, et Safari
// n'expose pas toujours les types maison de dataTransfer pendant le survol).
let glisseEnCours: string | null = null;

interface Depot { chemin: string; zone: Position }

const base = (c: string) => c.replace(/\.md$/i, "");

/** Le dépôt de `source` près de `cible` est-il permis (pas sur soi, pas dans un descendant) ? */
function depotPermis(source: string, cible: string): boolean {
  if (!source || source === cible) return false;
  return !(base(cible) + "/").startsWith(base(source) + "/");
}

export function BarreLaterale({ route, ouverte, deplies, basculer }: {
  route: Route; ouverte: boolean; deplies: Set<string>; basculer: (chemin: string, ouvrir?: boolean) => void;
}) {
  const app = useApp();
  const courant = route.vue === "page" || route.vue === "fichier" || route.vue === "historique" ? route.chemin : null;
  const [cibleRacine, setCibleRacine] = useState(false);
  const [glisse, setGlisse] = useState<string | null>(null);
  const [depot, setDepot] = useState<Depot | null>(null);
  const [clignote, setClignote] = useState<string | null>(null);
  const [nbCorbeille, setNbCorbeille] = useState(0);
  const defilement = useRef<HTMLDivElement>(null);

  const deposer = useCallback(async (source: string, cible: string, zone: Position) => {
    if (!(cible === "" && zone === "dans") && !depotPermis(source, cible)) return;
    await app.placerPage(source, cible, zone);
  }, [app]);

  // Corbeille : nombre d'éléments, rafraîchi quand l'arbre change.
  useEffect(() => {
    let m: number | null = null;
    const charger = () => api.corbeille().then((r) => setNbCorbeille(r.elements.length)).catch(() => {});
    charger();
    const fin = ecouter((e) => {
      if (e.type === "arbre" || (e.type === "connexion" && e.etat === "ouverte")) {
        if (m) window.clearTimeout(m);
        m = window.setTimeout(charger, 600);
      }
    });
    // Suppression définitive (l'arbre ne change pas : pas d'événement « arbre ») : la Corbeille prévient.
    window.addEventListener("carnet:corbeille", charger);
    return () => { fin(); if (m) window.clearTimeout(m); window.removeEventListener("carnet:corbeille", charger); };
  }, []);

  // Ligne à faire clignoter (déplacement, restauration, copie) : ancêtres dépliés, ligne amenée dans la vue.
  useEffect(() => {
    const f = (e: Event) => {
      const c = (e as CustomEvent<string>).detail;
      if (!c) return;
      const segs = base(c).split("/");
      for (let i = 1; i < segs.length; i++) basculer(segs.slice(0, i).join("/") + ".md", true);
      setClignote(c);
      window.setTimeout(() => setClignote((x) => (x === c ? null : x)), 1100);
      amenerDansLaVue(defilement.current, c, false);
    };
    window.addEventListener("carnet:clignoter", f);
    return () => window.removeEventListener("carnet:clignoter", f);
  }, [basculer]);

  // Page courante visible : à l'ouverture du tiroir (iPhone, ligne centrée) et à chaque changement de page.
  useEffect(() => {
    if (!courant) return;
    const mobile = window.matchMedia("(max-width: 899.98px)").matches;
    if (mobile && !ouverte) return;
    amenerDansLaVue(defilement.current, courant, mobile);
  }, [courant, ouverte]);

  const surToucheArbre = (e: React.KeyboardEvent<HTMLUListElement>) => {
    const liens = [...e.currentTarget.querySelectorAll<HTMLAnchorElement>("a.rangee__lien")];
    const i = liens.indexOf(document.activeElement as HTMLAnchorElement);
    if (i === -1) return;
    const li = liens[i].closest<HTMLElement>("li[data-chemin]");
    const chemin = li?.dataset.chemin ?? "";
    const aEnfants = li?.dataset.enfants === "true";
    const ouvert = li?.getAttribute("aria-expanded") === "true";
    const aller = (k: number) => { const l = liens[Math.max(0, Math.min(liens.length - 1, k))]; l?.focus(); };
    switch (e.key) {
      case "ArrowDown": e.preventDefault(); aller(i + 1); break;
      case "ArrowUp": e.preventDefault(); aller(i - 1); break;
      case "Home": e.preventDefault(); aller(0); break;
      case "End": e.preventDefault(); aller(liens.length - 1); break;
      case "ArrowRight":
        e.preventDefault();
        if (aEnfants && !ouvert) basculer(chemin, true);
        else if (aEnfants) aller(i + 1);
        break;
      case "ArrowLeft": {
        e.preventDefault();
        if (aEnfants && ouvert) { basculer(chemin, false); break; }
        const parent = li?.parentElement?.closest<HTMLElement>("li[data-chemin]");
        parent?.querySelector<HTMLAnchorElement>("a.rangee__lien")?.focus();
        break;
      }
      default: break;
    }
  };

  const menuRangee = useCallback((chemin: string, ancre: HTMLElement | null) => { void app.menuPage(chemin, ancre); }, [app]);

  return (
    <>
      <div className="voile-barre" data-visible={ouverte} onClick={app.fermerTiroir} aria-hidden="true" />
      <nav className="barre" data-ouverte={ouverte} aria-label="Pages">
        <div className="barre__tete">
          <a className="marque" href="/" onClick={(e) => surLienInterne(e, { vue: "accueil" }, app.fermerTiroir)}>
            <span className="marque__sceau"><Sceau /></span>
            <span className="marque__nom">Carnet</span>
          </a>
        </div>
        <button type="button" className="champ-recherche" onClick={app.ouvrirRecherche}>
          <Search size={17} />
          <span>Rechercher</span>
          <kbd className="raccourci">{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
        </button>
        <div className="barre__defilement" ref={defilement}>
          <div className="nav-barre">
            <LienNav route={{ vue: "accueil" }} actif={route.vue === "accueil"} icone={<House size={18} />} libelle="Accueil" />
            <LienNav route={{ vue: "projets" }} actif={route.vue === "projets"} icone={<KanbanSquare size={18} />} libelle="Projets" />
          </div>

          {app.favoris.length > 0 && (
            <div className="section-barre">
              <div className="section-barre__titre"><span>Favoris</span></div>
              <ul className="arbre">
                {app.favoris.map((c) => {
                  const n = app.index.get(c);
                  if (!n) return null;
                  return (
                    <li key={c}>
                      <div className="rangee" data-courante={c === courant}>
                        <span className="rangee__chevron" aria-hidden="true"><Star size={13} /></span>
                        <a className="rangee__lien" href={urlDe({ vue: "page", chemin: c })} title={n.titre}
                          onClick={(e) => surLienInterne(e, { vue: "page", chemin: c }, app.fermerTiroir)}>
                          <span className="rangee__icone"><IconePage icone={n.icone} /></span>
                          <span className="rangee__titre">{n.titre}</span>
                        </a>
                      </div>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}

          <div className="section-barre">
            <div className="section-barre__titre">
              <span>Pages</span>
            </div>
            {!app.arbreCharge ? (
              <SqueletteArbre />
            ) : app.arbre.length === 0 ? (
              <EtatVide compact icone={<Plus size={20} />} titre="Aucune page" texte="Crée ta première page."
                actions={<button type="button" className="bouton bouton--petit" onClick={() => void app.nouvellePage("")}><Plus size={16} /> Créer ma première page</button>} />
            ) : (
              <ul className="arbre" role="tree" aria-label="Arbre des pages" onKeyDown={surToucheArbre}>
                {app.arbre.map((n) => (
                  <Branche key={n.chemin} n={n} niveau={0} courant={courant} deplies={deplies} basculer={basculer}
                    glisse={glisse} setGlisse={setGlisse} depot={depot} setDepot={setDepot} deposer={deposer}
                    clignote={clignote} menu={menuRangee} />
                ))}
              </ul>
            )}
            {glisse && !tactile && (
              <div
                className="depot-racine"
                data-cible={cibleRacine}
                onDragOver={(e) => { if (glisseEnCours || glisse) { e.preventDefault(); setCibleRacine(true); setDepot(null); } }}
                onDragLeave={() => setCibleRacine(false)}
                onDrop={(e) => {
                  e.preventDefault();
                  setCibleRacine(false);
                  const s = glisseEnCours || glisse || e.dataTransfer.getData(MIME_GLISSER);
                  glisseEnCours = null;
                  setGlisse(null);
                  void deposer(s, "", "dans");
                }}
              >
                Déposer ici pour mettre à la racine
              </div>
            )}
          </div>
        </div>
        <div className="barre__pied">
          <a className="lien-nav lien-nav--corbeille" href={urlDe({ vue: "corbeille" })} aria-current={route.vue === "corbeille" ? "page" : undefined}
            onClick={(e) => surLienInterne(e, { vue: "corbeille" }, app.fermerTiroir)}>
            <Trash2 size={18} />
            <span>Corbeille</span>
            {nbCorbeille > 0 && <span className="compteur" aria-label={`${nbCorbeille} élément${nbCorbeille > 1 ? "s" : ""}`}>{nbCorbeille}</span>}
          </a>
          <button type="button" className="bouton-nouvelle" onClick={() => void app.nouvellePage("")}>
            <Plus size={18} />
            Nouvelle page
          </button>
        </div>
      </nav>
    </>
  );
}

/** Fait défiler le conteneur de l'arbre pour montrer la ligne `chemin` (centrée si `centrer`, sinon si cachée). */
function amenerDansLaVue(conteneur: HTMLElement | null, chemin: string, centrer: boolean): void {
  let essais = 0;
  const f = () => {
    if (!conteneur) return;
    const el = conteneur.querySelector<HTMLElement>(`li[data-chemin="${CSS.escape(chemin)}"] > .rangee`);
    if (!el) { if (essais++ < 12) requestAnimationFrame(f); return; }
    const rc = conteneur.getBoundingClientRect();
    const re = el.getBoundingClientRect();
    const cachee = re.top < rc.top + 8 || re.bottom > rc.bottom - 8;
    if (centrer || cachee) conteneur.scrollTop += re.top - rc.top - (rc.height - re.height) / 2;
  };
  requestAnimationFrame(f);
}

function LienNav({ route, actif, icone, libelle }: { route: Route; actif: boolean; icone: React.ReactNode; libelle: string }) {
  const app = useApp();
  return (
    <a className="lien-nav" href={urlDe(route)} aria-current={actif ? "page" : undefined} onClick={(e) => surLienInterne(e, route, app.fermerTiroir)}>
      {icone}
      <span>{libelle}</span>
    </a>
  );
}

const Branche = memo(function Branche({ n, niveau, courant, deplies, basculer, glisse, setGlisse, depot, setDepot, deposer, clignote, menu }: {
  n: Noeud; niveau: number; courant: string | null; deplies: Set<string>; basculer: (c: string, o?: boolean) => void;
  glisse: string | null; setGlisse: (c: string | null) => void;
  depot: Depot | null; setDepot: React.Dispatch<React.SetStateAction<Depot | null>>;
  deposer: (s: string, c: string, z: Position) => Promise<void>;
  clignote: string | null; menu: (chemin: string, ancre: HTMLElement | null) => void;
}) {
  const app = useApp();
  const ouvert = deplies.has(n.chemin);
  const aEnfants = n.enfants.length > 0;
  const appuiLong = useRef<number | null>(null);
  const depliage = useRef<number | null>(null);
  const route: Route = n.type === "fichier" ? { vue: "fichier", chemin: n.chemin } : { vue: "page", chemin: n.chemin };
  const estPage = n.type === "page";
  const zone = depot && depot.chemin === n.chemin ? depot.zone : null;
  const retrait = 4 + niveau * 14;

  const annulerDepliage = () => { if (depliage.current) { window.clearTimeout(depliage.current); depliage.current = null; } };

  /** Quart haut de la ligne = avant, quart bas = après, milieu = dedans. */
  const zoneDe = (e: React.DragEvent<HTMLDivElement>): Position => {
    const r = e.currentTarget.getBoundingClientRect();
    const y = e.clientY - r.top;
    return y < r.height * 0.28 ? "avant" : y > r.height * 0.72 ? "apres" : "dans";
  };

  const survol = (e: React.DragEvent<HTMLDivElement>) => {
    const g = glisseEnCours ?? (e.dataTransfer.types.includes(MIME_GLISSER) ? "?" : null);
    if (!estPage || !g) return;
    const z = zoneDe(e);
    if (g !== "?" && !depotPermis(g, n.chemin)) { setDepot(null); return; }
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    // Mise à jour fonctionnelle : l'état du rendu précédent peut être en retard sur les événements de glisser.
    setDepot((d) => (d && d.chemin === n.chemin && d.zone === z ? d : { chemin: n.chemin, zone: z }));
    if (z === "dans" && aEnfants && !ouvert) {
      if (!depliage.current) depliage.current = window.setTimeout(() => { depliage.current = null; basculer(n.chemin, true); }, 500);
    } else annulerDepliage();
  };

  return (
    <li role="treeitem" aria-expanded={aEnfants ? ouvert : undefined} aria-selected={n.chemin === courant} aria-level={niveau + 1}
      data-chemin={n.chemin} data-enfants={aEnfants ? "true" : undefined}>
      <div
        className={classes("rangee")}
        data-courante={n.chemin === courant}
        data-depot={zone ?? undefined}
        data-glissee={glisse === n.chemin ? "true" : undefined}
        data-clignote={clignote === n.chemin ? "true" : undefined}
        style={{ paddingLeft: retrait, ["--retrait" as string]: `${retrait + 24}px` }}
        draggable={!tactile && estPage && n.existe}
        onDragStart={(e) => {
          e.dataTransfer.setData(MIME_GLISSER, n.chemin);
          e.dataTransfer.setData("text/plain", n.chemin);
          e.dataTransfer.effectAllowed = "move";
          glisseEnCours = n.chemin;
          setGlisse(n.chemin);
        }}
        onDragEnd={() => { glisseEnCours = null; setGlisse(null); setDepot(null); annulerDepliage(); }}
        onDragEnter={survol}
        onDragOver={survol}
        onDragLeave={(e) => {
          // relatedTarget est souvent vide pendant un glisser : on regarde si le pointeur a vraiment quitté la ligne.
          const r = e.currentTarget.getBoundingClientRect();
          if (e.clientX > r.left && e.clientX < r.right && e.clientY > r.top && e.clientY < r.bottom) return;
          annulerDepliage();
          setDepot((d) => (d && d.chemin === n.chemin ? null : d));
        }}
        onDrop={(e) => {
          e.preventDefault();
          annulerDepliage();
          const s = glisseEnCours || e.dataTransfer.getData(MIME_GLISSER);
          // Zone recalculée sur l'événement de dépôt lui-même (l'état affiché peut avoir un survol de retard).
          const z = zoneDe(e);
          glisseEnCours = null;
          setGlisse(null);
          setDepot(null);
          if (!s) return;
          // « Après » une ligne dépliée qui a des enfants = en tête de ses enfants (c'est là que le repère s'affiche).
          if (z === "apres" && aEnfants && ouvert) {
            const premier = n.enfants.find((x) => x.type === "page" && x.chemin !== s);
            if (premier) { void deposer(s, premier.chemin, "avant"); return; }
            void deposer(s, n.chemin, "dans");
            return;
          }
          void deposer(s, n.chemin, z);
        }}
        onContextMenu={(e) => { if (estPage) { e.preventDefault(); menu(n.chemin, e.currentTarget.querySelector<HTMLElement>(".rangee__actions .bouton-icone") ?? e.currentTarget); } }}
        onTouchStart={(e) => {
          if (!estPage) return;
          const el = e.currentTarget;
          appuiLong.current = window.setTimeout(() => { appuiLong.current = null; navigator.vibrate?.(10); menu(n.chemin, el); }, 520);
        }}
        onTouchEnd={() => { if (appuiLong.current) { window.clearTimeout(appuiLong.current); appuiLong.current = null; } }}
        onTouchMove={() => { if (appuiLong.current) { window.clearTimeout(appuiLong.current); appuiLong.current = null; } }}
      >
        {aEnfants ? (
          <button type="button" className="rangee__chevron" aria-expanded={ouvert} aria-label={ouvert ? `Replier ${n.titre}` : `Déplier ${n.titre}`}
            tabIndex={-1} onClick={() => basculer(n.chemin)}>
            <ChevronRight size={15} />
          </button>
        ) : (
          <span className="rangee__chevron" aria-hidden="true" />
        )}
        <a className="rangee__lien" href={urlDe(route)} title={n.titre} onClick={(e) => {
          surLienInterne(e, route, () => { if (aEnfants && !ouvert) basculer(n.chemin, true); app.fermerTiroir(); });
        }}>
          <span className="rangee__icone"><IconePage icone={n.icone} dossier={!n.existe} fichier={n.type === "fichier"} ext={n.ext} /></span>
          <span className="rangee__titre">{n.titre}</span>
        </a>
        {estPage && (
          <span className="rangee__actions">
            <button type="button" className="bouton-icone" aria-label={`Actions pour ${n.titre}`} title="Renommer, dupliquer, déplacer…"
              aria-haspopup="menu" onClick={(e) => menu(n.chemin, e.currentTarget)}>
              <MoreHorizontal size={16} />
            </button>
            <button type="button" className="bouton-icone" aria-label={`Ajouter une sous-page à ${n.titre}`} title="Ajouter une sous-page"
              onClick={() => { basculer(n.chemin, true); void app.nouvellePage(n.chemin); }}>
              <Plus size={16} />
            </button>
          </span>
        )}
      </div>
      {aEnfants && ouvert && (
        <ul role="group">
          {n.enfants.map((e) => (
            <Branche key={e.chemin} n={e} niveau={niveau + 1} courant={courant} deplies={deplies} basculer={basculer}
              glisse={glisse} setGlisse={setGlisse} depot={depot} setDepot={setDepot} deposer={deposer} clignote={clignote} menu={menu} />
          ))}
        </ul>
      )}
    </li>
  );
});

export { naviguer };
