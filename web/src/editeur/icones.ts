// Icônes Lucide (ISC) en chaînes SVG pour les vues de l'éditeur écrites sans React.
// Importées module par module : seules celles-ci finissent dans le bundle.
import { __iconData as image } from "lucide-react/dist/esm/icons/image.mjs";
import { __iconData as artefact } from "lucide-react/dist/esm/icons/app-window.mjs";
import { __iconData as plus } from "lucide-react/dist/esm/icons/plus.mjs";
import { __iconData as poignee } from "lucide-react/dist/esm/icons/grip-vertical.mjs";
import { __iconData as copier } from "lucide-react/dist/esm/icons/copy.mjs";
import { __iconData as valider } from "lucide-react/dist/esm/icons/check.mjs";
import { __iconData as chevron } from "lucide-react/dist/esm/icons/chevron-down.mjs";
import { __iconData as chevronDroite } from "lucide-react/dist/esm/icons/chevron-right.mjs";
import { __iconData as oeil } from "lucide-react/dist/esm/icons/eye.mjs";
import { __iconData as accolades } from "lucide-react/dist/esm/icons/braces.mjs";
import { __iconData as corbeille } from "lucide-react/dist/esm/icons/trash.mjs";
import { __iconData as remplacer } from "lucide-react/dist/esm/icons/replace.mjs";
import { __iconData as envoyer } from "lucide-react/dist/esm/icons/image-up.mjs";
import { __iconData as calendrier } from "lucide-react/dist/esm/icons/calendar.mjs";
import { __iconData as sommaire } from "lucide-react/dist/esm/icons/list-tree.mjs";
import { __iconData as chargement } from "lucide-react/dist/esm/icons/loader-circle.mjs";
import { __iconData as aNote } from "lucide-react/dist/esm/icons/info.mjs";
import { __iconData as aAstuce } from "lucide-react/dist/esm/icons/lightbulb.mjs";
import { __iconData as aImportant } from "lucide-react/dist/esm/icons/message-square-warning.mjs";
import { __iconData as aAttention } from "lucide-react/dist/esm/icons/triangle-alert.mjs";
import { __iconData as aPrudence } from "lucide-react/dist/esm/icons/octagon-alert.mjs";
import { __iconData as page } from "lucide-react/dist/esm/icons/file-text.mjs";
import { __iconData as pleinEcran } from "lucide-react/dist/esm/icons/maximize-2.mjs";
import { __iconData as ouvrir } from "lucide-react/dist/esm/icons/external-link.mjs";
import { __iconData as fermer } from "lucide-react/dist/esm/icons/x.mjs";

type Donnees = { node?: Array<[string, Record<string, string>]> } | Array<[string, Record<string, string>]>;

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
  image: svg(image), artefact: svg(artefact, 18, 2), plus: svg(plus, 18, 2), poignee: svg(poignee, 18, 2),
  copier: svg(copier, 16, 2), valider: svg(valider, 16, 2), chevron: svg(chevron, 14, 2), chevronDroite: svg(chevronDroite, 18, 2.25),
  oeil: svg(oeil, 16, 2), accolades: svg(accolades, 16, 2), corbeille: svg(corbeille, 16, 2), remplacer: svg(remplacer, 16, 2),
  envoyer: svg(envoyer, 22, 1.75), calendrier: svg(calendrier, 15, 2), sommaire: svg(sommaire, 16, 2), chargement: svg(chargement, 18, 2),
};

export const icEncadre: Record<string, string> = {
  NOTE: svg(aNote, 18, 2), TIP: svg(aAstuce, 18, 2), IMPORTANT: svg(aImportant, 18, 2),
  WARNING: svg(aAttention, 18, 2), CAUTION: svg(aPrudence, 18, 2),
};
export const icDivers = {
  page: svg(page, 16, 2), pleinEcran: svg(pleinEcran, 16, 2), ouvrir: svg(ouvrir, 16, 2), fermer: svg(fermer, 20, 2),
};

export const CASE_VIDE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2.5" y="2.5" width="15" height="15" rx="4.5" fill="none" stroke="currentColor" stroke-width="1.6"/></svg>`;
export const CASE_COCHEE = `<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 20 20" aria-hidden="true"><rect x="2" y="2" width="16" height="16" rx="5" fill="currentColor"/><path d="M6 10.2l2.6 2.6L14.2 7" fill="none" stroke="var(--sur-accent, #fff)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
