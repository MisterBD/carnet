// En-tête d'une page, prêt à brancher dans PageVue (chantier « editeur » ou intégration) : couverture, icône, titre,
// statut / étiquettes / résumé du frontmatter, rétroliens (« Mentionnée dans N pages »).
//
// Composant CONTRÔLÉ : il n'écrit rien lui-même. PageVue garde la main sur l'enregistrement (fusion bloc par bloc,
// ETag, conflits) et reçoit :
//   - surTitre(v)        à chaque frappe dans le titre (sans retour à la ligne) ;
//   - validerTitre()     à la perte de focus et sur Entrée (renommer le fichier si son nom suivait le titre :
//                        voir `nomSuitLeTitre` de shared/navigation.ts et NOTES-NAVIGATION.md) ;
//   - versCorps()        Entrée, Tab ou ↓ en fin de titre : donner le focus au début du corps ;
//   - poserChamps({…})   icône (`icon`) et couverture (`cover`) : une ligne du frontmatter chacune
//                        (poserChamp de shared/page.ts), valeur null = retirer la clé.
// Le champ titre garde la classe `titre-page` : « Nouvelle page » y place le curseur (actions-pages.tsx).
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ImageIcon, CornerDownRight, SmilePlus } from "lucide-react";
import { api, urlFichier, type Retrolien } from "../api";
import { useApp } from "../contexte-app";
import { ecouter } from "../evenements";
import { surLienInterne, urlDe } from "../navigation";
import { IconePage } from "./Icone";
import { SelecteurCouverture } from "./SelecteurCouverture";
import { estEmoji, tonStatut } from "../outils";
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
  /** Page en lecture seule (lien symbolique vers une autre page) : rien n'est modifiable. */
  lectureSeule?: boolean;
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

export function EnTetePage({ chemin, titre, yaml, surTitre, validerTitre, versCorps, poserChamps, lectureSeule }: ProprietesEnTetePage) {
  const app = useApp();
  const champ = useRef<HTMLTextAreaElement>(null);
  const [choixCouverture, setChoixCouverture] = useState(false);
  const icone = lireChampSimple(yaml, "icon") ?? app.index.get(chemin)?.icone ?? null;
  const valeurCouverture = lireChampSimple(yaml, "cover") ?? null;
  const couverture = lireCouverture(valeurCouverture);
  const statut = lireChampSimple(yaml, "statut") ?? lireChampSimple(yaml, "status");
  const etiquettes = lireEtiquettes(yaml);
  const resume = lireChampSimple(yaml, "resume");

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
        {!lectureSeule && (!icone || !couverture) && (
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
        {(statut || etiquettes.length > 0) && (
          <div className="meta-page">
            {statut && <span className="pastille" data-ton={tonStatut(statut)}>{statut}</span>}
            {etiquettes.map((t) => <span key={t} className="pastille pastille--etiquette">#{t}</span>)}
          </div>
        )}
        {resume && <p className="resume-page">{resume}</p>}
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
