// En-tête d'une page, prêt à brancher dans PageVue (chantier « editeur » ou intégration) : couverture, icône, titre,
// panneau « Propriétés » (V3 lot 2 : frontmatter typé et modifiable ; replié, il montre statut / étiquettes /
// résumé comme avant), rétroliens (« Mentionnée dans N pages »).
//
// Composant CONTRÔLÉ : il n'écrit rien lui-même. PageVue garde la main sur l'enregistrement (fusion bloc par bloc,
// ETag, conflits) et reçoit :
//   - surTitre(v)        à chaque frappe dans le titre (sans retour à la ligne) ;
//   - validerTitre()     à la perte de focus et sur Entrée (renommer le fichier si son nom suivait le titre :
//                        voir `nomSuitLeTitre` de shared/navigation.ts) ;
//   - versCorps()        Entrée, Tab ou ↓ en fin de titre : donner le focus au début du corps ;
//   - poserChamps({…})   icône (`icon`) et couverture (`cover`) : une ligne du frontmatter chacune
//                        (poserChamp de shared/page.ts), valeur null = retirer la clé.
//   - ecrirePropriete    (V3 lot 2) une propriété du panneau, écrite par le serveur (UNE propriété, révision
//                        attendue) ; PageVue enregistre d'abord la saisie en cours puis suit la nouvelle version.
// Le champ titre garde la classe `titre-page` : « Nouvelle page » y place le curseur (actions-pages.tsx).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ImageIcon, CornerDownRight, SmilePlus, ListPlus } from "lucide-react";
import { api, urlFichier, type Retrolien } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe } from "../navigation";
import { IconePage } from "./Icone";
import { SelecteurCouverture } from "./SelecteurCouverture";
import { estEmoji } from "../outils";
import { PanneauProprietes, type EcrirePropriete } from "../bases/PanneauProprietes";
import { lireCouverture } from "../../../shared/navigation.ts";
import { dossierDe, lireChampSimple, resoudre } from "../../../shared/page.ts";
import "../styles/navigation.css";

export interface ProprietesEnTetePage {
  /** Chemin de la page (« Démo/To-do.md »). */
  chemin: string;
  /** Valeur courante du champ titre. */
  titre: string;
  /** YAML brut du frontmatter courant (sans les délimiteurs) : icône, couverture, statut, étiquettes, résumé. */
  yaml: string;
  surTitre(valeur: string): void;
  validerTitre(): void;
  versCorps(): void;
  poserChamps(champs: Record<string, string | null>): void;
  /** V3 lot 2 : écrit UNE propriété du frontmatter (panneau « Propriétés »). Absent : panneau en lecture seule. */
  ecrirePropriete?: EcrirePropriete;
  /** Page en lecture seule (lien symbolique vers une autre page) : rien n'est modifiable. */
  lectureSeule?: boolean;
  /** K10-03 : affiché sous le titre, avant le panneau des propriétés (date et fraîcheur d'une préparation conservée). */
  avantProprietes?: ReactNode;
}

export function lireEtiquettes(yaml: string): string[] {
  const brut = lireChampSimple(yaml, "tags");
  if (brut) {
    const s = brut.replace(/^\[|\]$/g, "");
    return s.split(",").map((x) => x.trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 8);
  }
  const m = /^tags:\s*\n((?:[ \t]*-[^\n]*\n?)+)/m.exec(yaml);
  if (m) return m[1].split("\n").map((l) => l.replace(/^[ \t]*-\s*/, "").trim().replace(/^["']|["']$/g, "")).filter(Boolean).slice(0, 8);
  return [];
}

export function EnTetePage({ chemin, titre, yaml, surTitre, validerTitre, versCorps, poserChamps, ecrirePropriete, lectureSeule, avantProprietes }: ProprietesEnTetePage) {
  const app = useApp();
  const champ = useRef<HTMLTextAreaElement>(null);
  const [choixCouverture, setChoixCouverture] = useState(false);
  const icone = lireChampSimple(yaml, "icon") ?? app.index.get(chemin)?.icone ?? null;
  const valeurCouverture = lireChampSimple(yaml, "cover") ?? null;
  const couverture = lireCouverture(valeurCouverture);
  const [ajoutPropriete, setAjoutPropriete] = useState(false);
  const [nbProprietes, setNbProprietes] = useState<number | null>(null);
  const finAjout = useCallback(() => setAjoutPropriete(false), []);
  const proposerPropriete = !lectureSeule && !!ecrirePropriete && nbProprietes === 0;

  useLayoutEffect(() => {
    const el = champ.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }, [titre]);

  const changerIcone = async () => {
    const e = await app.choisirEmoji(Boolean(lireChampSimple(yaml, "icon")));
    if (e === null) return;
    poserChamps({ icon: e || null });
  };

  const imageCouverture = couverture?.type === "image" ? resoudre(dossierDe(chemin), couverture.relatif) : null;

  return (
    <div className="en-tete-page tete-page" data-couverture={couverture ? "true" : undefined} data-icone={icone ? "true" : undefined}>
      {couverture && (
        <div className="couverture">
          {couverture.type === "degrade" ? (
            <span className={`couverture__fond couverture--${couverture.nom}`} aria-hidden="true" />
          ) : imageCouverture ? (
            <img className="couverture__fond" src={urlFichier(imageCouverture)} alt="" />
          ) : null}
          {!lectureSeule && (
            <span className="couverture__actions">
              <button type="button" className="bouton-voile" onClick={() => setChoixCouverture(true)}>Changer la couverture</button>
            </span>
          )}
        </div>
      )}
      <div className="en-tete-page__corps">
        {icone && (
          <button type="button" className="tete-page__icone en-tete-page__icone" onClick={() => void changerIcone()} disabled={lectureSeule}
            aria-label="Changer l'icône" title="Changer l'icône">
            <IconePage icone={icone} taille={estEmoji(icone) ? 48 : 40} />
          </button>
        )}
        {!lectureSeule && (!icone || !couverture || proposerPropriete) && (
          <div className="en-tete-page__ajouts">
            {!icone && (
              <button type="button" className="tete-page__ajout-icone" onClick={() => void changerIcone()}>
                <SmilePlus size={17} /> Ajouter une icône
              </button>
            )}
            {!couverture && (
              <button type="button" className="tete-page__ajout-icone" onClick={() => setChoixCouverture(true)}>
                <ImageIcon size={17} /> Ajouter une couverture
              </button>
            )}
            {proposerPropriete && (
              <button type="button" className="tete-page__ajout-icone" onClick={() => setAjoutPropriete(true)}>
                <ListPlus size={17} /> Ajouter une propriété
              </button>
            )}
          </div>
        )}
        <textarea
          ref={champ}
          className="titre-page"
          rows={1}
          value={titre}
          placeholder="Sans titre"
          aria-label="Titre de la page"
          spellCheck
          readOnly={lectureSeule}
          enterKeyHint="next"
          onChange={(e) => surTitre(e.target.value.replace(/\s*[\r\n]+\s*/g, " "))}
          onBlur={() => validerTitre()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            const el = e.currentTarget;
            const enFin = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
            if (e.key === "Enter" || (e.key === "Tab" && !e.shiftKey) || (e.key === "ArrowDown" && enFin)) {
              e.preventDefault();
              validerTitre();
              versCorps();
            }
          }}
        />
        {/* K10-03 : préparation conservée : date et état de fraîcheur AVANT « Sources et traçabilité » (replié) */}
        {avantProprietes}
        <PanneauProprietes chemin={chemin} yaml={yaml} lectureSeule={lectureSeule} ecrire={ecrirePropriete}
          ajout={ajoutPropriete} finAjout={finAjout} surNombre={setNbProprietes} />
        <Retroliens chemin={chemin} />
      </div>
      {choixCouverture && (
        <SelecteurCouverture chemin={chemin} actuelle={valeurCouverture}
          onFermer={() => setChoixCouverture(false)}
          onChoisir={(v) => { setChoixCouverture(false); poserChamps({ cover: v }); }} />
      )}
    </div>
  );
}

/** « Mentionnée dans N pages » : pages qui pointent vers celle-ci ([[…]] ou lien relatif), repliable. */
export function Retroliens({ chemin }: { chemin: string }) {
  const [pages, setPages] = useState<Retrolien[] | null>(null);
  const [ouvert, setOuvert] = useState(false);
  useEffect(() => {
    let annule = false;
    let m: number | null = null;
    const charger = () => api.retroliens(chemin).then((r) => { if (!annule) setPages(r.pages); }).catch(() => {});
    charger();
    const fin = ecouter((e) => {
      if (e.type === "arbre" || (e.type === "modif" && e.chemin !== chemin)) {
        if (m) window.clearTimeout(m);
        m = window.setTimeout(charger, 1200);
      }
    });
    return () => { annule = true; fin(); if (m) window.clearTimeout(m); };
  }, [chemin]);
  if (!pages || pages.length === 0) return null;
  return (
    <div className="retroliens" data-ouvert={ouvert ? "true" : undefined}>
      <button type="button" className="retroliens__bouton" aria-expanded={ouvert} onClick={() => setOuvert((o) => !o)}>
        <CornerDownRight size={15} />
        Mentionnée dans {pages.length} page{pages.length > 1 ? "s" : ""}
      </button>
      {ouvert && (
        <ul className="retroliens__liste">
          {pages.map((p) => (
            <li key={p.chemin}>
              <a className="retrolien" href={urlDe({ vue: "page", chemin: p.chemin })} onClick={(e) => surLienInterne(e, { vue: "page", chemin: p.chemin })}>
                <span className="retrolien__icone"><IconePage icone={p.icone} /></span>
                <span className="retrolien__texte">
                  <span className="retrolien__titre">{p.titre}</span>
                  {p.extrait && <span className="retrolien__extrait">{p.extrait}</span>}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
