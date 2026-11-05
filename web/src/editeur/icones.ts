// Icônes Lucide (ISC) en chaînes SVG pour les vues de l'éditeur écrites sans React.
// Importées module par module : seules celles-ci finissent dans le bundle. Chaque module exporte, en plus du composant
// React, ses données de dessin (`__iconData`). Depuis lucide-react 1.66, ses déclarations de types ne décrivent plus que
// le composant : on importe donc le module entier et on lit les données avec `donnees()`, qui marche dans les deux cas.
import * as image from "lucide-react/dist/esm/icons/image.mjs";
import * as artefact from "lucide-react/dist/esm/icons/app-window.mjs";
import * as plus from "lucide-react/dist/esm/icons/plus.mjs";
import * as poignee from "lucide-react/dist/esm/icons/grip-vertical.mjs";
import * as copier from "lucide-react/dist/esm/icons/copy.mjs";
import * as valider from "lucide-react/dist/esm/icons/check.mjs";
import * as chevron from "lucide-react/dist/esm/icons/chevron-down.mjs";
import * as chevronDroite from "lucide-react/dist/esm/icons/chevron-right.mjs";
import * as oeil from "lucide-react/dist/esm/icons/eye.mjs";
import * as accolades from "lucide-react/dist/esm/icons/braces.mjs";
import * as corbeille from "lucide-react/dist/esm/icons/trash.mjs";
import * as remplacer from "lucide-react/dist/esm/icons/replace.mjs";
import * as envoyer from "lucide-react/dist/esm/icons/image-up.mjs";
import * as calendrier from "lucide-react/dist/esm/icons/calendar.mjs";
import * as sommaire from "lucide-react/dist/esm/icons/list-tree.mjs";
import * as chargement from "lucide-react/dist/esm/icons/loader-circle.mjs";
import * as aNote from "lucide-react/dist/esm/icons/info.mjs";
import * as aAstuce from "lucide-react/dist/esm/icons/lightbulb.mjs";
import * as aImportant from "lucide-react/dist/esm/icons/message-square-warning.mjs";
import * as aAttention from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import * as aPrudence from "lucide-react/dist/esm/icons/octagon-alert.mjs";
import * as page from "lucide-react/dist/esm/icons/file-text.mjs";
import * as pleinEcran from "lucide-react/dist/esm/icons/maximize-2.mjs";
import * as ouvrir from "lucide-react/dist/esm/icons/external-link.mjs";
import * as fermer from "lucide-react/dist/esm/icons/x.mjs";
import * as retourLigne from "lucide-react/dist/esm/icons/text-wrap.mjs";

type Donnees = { node?: Array<[string, Record<string, string>]> } | Array<[string, Record<string, string>]>;

/** Données de dessin d'un module d'icône Lucide (export `__iconData`, absent des types publiés depuis la 1.66). */
function donnees(module: unknown): Donnees {
  const d = (module as { __iconData?: Donnees }).__iconData;
  if (!d) throw new Error("icône Lucide sans données de dessin (__iconData)");
  return d;
}

function echapperAttr(v: string): string {
  return v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

export function svg(d: Donnees, taille = 20, epaisseur = 1.75): string {
  const noeuds = Array.isArray(d) ? d : d.node ?? [];
  const corps = noeuds
    .map(([tag, attrs]) => {
      const a = Object.entries(attrs)
        .filter(([k]) => k !== "key")
        .map(([k, v]) => `${k}="${echapperAttr(String(v))}"`)
        .join(" ");
      return `<${tag} ${a}/>`;
    })
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${taille}" height="${taille}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${epaisseur}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${corps}</svg>`;
}

export const ic = {
  image: svg(donnees(image)), artefact: svg(donnees(artefact), 18, 2), plus: svg(donnees(plus), 18, 2), poignee: svg(donnees(poignee), 18, 2),
  copier: svg(donnees(copier), 16, 2), valider: svg(donnees(valider), 16, 2), chevron: svg(donnees(chevron), 14, 2), chevronDroite: svg(donnees(chevronDroite), 18, 2.25),
  oeil: svg(donnees(oeil), 16, 2), accolades: svg(donnees(accolades), 16, 2), corbeille: svg(donnees(corbeille), 16, 2), remplacer: svg(donnees(remplacer), 16, 2),
  envoyer: svg(donnees(envoyer), 22, 1.75), calendrier: svg(donnees(calendrier), 15, 2), sommaire: svg(donnees(sommaire), 16, 2), chargement: svg(donnees(chargement), 18, 2),
};

export const icEncadre: Record<string, string> = {
  NOTE: svg(donnees(aNote), 18, 2), TIP: svg(donnees(aAstuce), 18, 2), IMPORTANT: svg(donnees(aImportant), 18, 2),
  WARNING: svg(donnees(aAttention), 18, 2), CAUTION: svg(donnees(aPrudence), 18, 2),
};
export const icDivers = {
  page: svg(donnees(page), 16, 2), pleinEcran: svg(donnees(pleinEcran), 16, 2), ouvrir: svg(donnees(ouvrir), 16, 2), fermer: svg(donnees(fermer), 20, 2),
  retourLigne: svg(donnees(retourLigne), 16, 2),
};

export const CASE_VIDE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
export const CASE_COCHEE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="5" fill="currentColor"/><path d="M6 10.2l2.6 2.6L14.2 7" fill="none" stroke="var(--sur-accent, #fff)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
