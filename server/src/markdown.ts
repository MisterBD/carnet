// Carnet · analyse légère du Markdown : blocs de code clôturés, tâches, mentions, réécriture des liens.
import path from "node:path";
import { plier, resoudre } from "../../shared/page.ts";
import { marquerCode } from "../../shared/taches.ts";

// marquerCode vit dans shared/taches.ts (partagé avec l'interface et les lots V3) ; réexporté ici pour l'existant.
export { marquerCode };

export const RE_TACHE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[( |x|X)\](?:[ \t]+(.*))?$/;

export interface Tache {
  ligne: number;
  texte: string;
  libelle: string;
}

export interface Analyse {
  taches: Tache[];
  mention: boolean;
}

const echapper = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const cacheMentions = new WeakMap<readonly string[], RegExp | null>();

/**
 * Expression qui reconnaît l'une des mentions dans du texte déjà plié (minuscules, sans accents) : pas collée à un mot,
 * à un « @ » ou à un « . » devant (« a@camille.fr » n'est pas une mention), pas suivie d'une lettre ou d'un chiffre.
 * `mentions` : valeurs de Config.mentions (déjà pliées, avec « @ »). Null s'il n'y en a aucune.
 */
export function expressionMentions(mentions: readonly string[]): RegExp | null {
  let re = cacheMentions.get(mentions);
  if (re === undefined) {
    re = mentions.length
      ? new RegExp(`(?<![\\p{L}\\p{N}_@.])(?:${mentions.map(echapper).join("|")})(?![\\p{L}\\p{N}_])`, "u")
      : null;
    cacheMentions.set(mentions, re);
  }
  return re;
}

/**
 * Tâches non cochées et mentions (Config.mentions, ex. « @camille »), hors frontmatter et hors blocs de code.
 * Les mentions sont insensibles à la casse et aux accents ; sans mention configurée, `mention` reste faux.
 */
export function analyser(contenu: string, lignesFrontmatter: number, mentions: readonly string[] = []): Analyse {
  const reMention = expressionMentions(mentions);
  const lignes = contenu.split("\n");
  const code = marquerCode(lignes);
  const taches: Tache[] = [];
  let mention = false;
  for (let i = lignesFrontmatter; i < lignes.length; i++) {
    if (code[i]) continue;
    const l = lignes[i].endsWith("\r") ? lignes[i].slice(0, -1) : lignes[i];
    const m = RE_TACHE.exec(l);
    if (m && m[2] === " ") taches.push({ ligne: i, texte: l, libelle: (m[3] ?? "").trim() });
    if (reMention && !mention && l.includes("@")) {
      let horsCode = "";
      horsCodeEnLigne(l, (x) => { horsCode += x + " "; return x; });
      if (reMention.test(plier(horsCode))) mention = true;
    }
  }
  return { taches, mention };
}

// ---------------------------------------------------------------------------------------------
// Extraits lisibles (rétroliens, aperçus, résumés) : texte brut, jamais interprété comme HTML par l'interface.
// ---------------------------------------------------------------------------------------------

const ENTITES_NOMMEES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", hellip: "…", laquo: "«", raquo: "»",
  lsquo: "‘", rsquo: "’", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", euro: "€", copy: "©", reg: "®",
  deg: "°", middot: "·", shy: "",
};

/**
 * Décode les références de caractères HTML d'un texte DÉJÀ débarrassé de son balisage (« &#x20; », « &#233; »,
 * « &amp; »…) ; un seul passage (« &amp;#x20; » donne « &#x20; »). Nom inconnu : laissé tel quel ; code invalide : « � ».
 */
export function decoderEntites(s: string): string {
  if (!s.includes("&")) return s;
  return s.replace(/&(?:#[xX]([0-9a-fA-F]{1,6})|#([0-9]{1,7})|([A-Za-z]{2,8}));/g, (t, hex?: string, dec?: string, nom?: string) => {
    if (nom !== undefined) return Object.hasOwn(ENTITES_NOMMEES, nom) ? ENTITES_NOMMEES[nom] : t;
    const cp = hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
    if (!Number.isFinite(cp) || cp === 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return "�";
    if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return " ";
    return String.fromCodePoint(cp);
  });
}

/** Borne d'un lien remplacé par son libellé : deux liens accolés (« [[A]][[B]] ») seront séparés par une espace. */
export const BORNE_LIEN = "\u0000";

/** Fin du nettoyage d'un extrait : liens accolés séparés, entités décodées (après le balisage), espaces repliées. */
export function finirExtrait(t: string): string {
  return decoderEntites(t.replace(/\u0000\s*\u0000/g, " ").replace(/\u0000/g, "")).replace(/\s+/g, " ").trim();
}

/** Premier paragraphe lisible du corps (pour un résumé), sans balisage évident. */
export function extraitCorps(corps: string, max = 160): string {
  const lignes = corps.split("\n");
  const code = marquerCode(lignes);
  const B = BORNE_LIEN;
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    let l = lignes[i].replace(/\u0000/g, "").trim();
    if (!l || /^(#{1,6}\s|>\s*\[!|---|\*\*\*|\||<)/.test(l)) continue;
    l = l.replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "").replace(/^>\s?/, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "").replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_t, c: string, a?: string) => B + (a || c) + B)
      .replace(/\[([^\]]*)\]\([^)]*\)/g, (_t, x: string) => B + x + B).replace(/[*_`~]+/g, "");
    l = finirExtrait(l);
    if (!l) continue;
    return l.length > max ? l.slice(0, max - 1).trimEnd() + "…" : l;
  }
  return "";
}

// ---------------------------------------------------------------------------------------------
// Réécriture des liens (renommer / déplacer)
// ---------------------------------------------------------------------------------------------

/** Applique `f` aux portions d'une ligne situées hors des segments de code en ligne (`…`). */
export function horsCodeEnLigne(ligne: string, f: (s: string) => string): string {
  let out = "";
  let dernier = 0;
  let i = 0;
  while (i < ligne.length) {
    if (ligne[i] !== "`") { i++; continue; }
    let j = i;
    while (j < ligne.length && ligne[j] === "`") j++;
    const n = j - i;
    let k = j;
    let fin = -1;
    while (k < ligne.length) {
      if (ligne[k] === "`") {
        let m = k;
        while (m < ligne.length && ligne[m] === "`") m++;
        if (m - k === n) { fin = m; break; }
        k = m;
      } else k++;
    }
    if (fin === -1) { i = j; continue; }
    out += f(ligne.slice(dernier, i)) + ligne.slice(i, fin);
    dernier = i = fin;
  }
  return out + f(ligne.slice(dernier));
}

export const RE_WIKI = /\[\[([^\[\]\n|#]+)(#[^\[\]\n|]*)?(\|[^\[\]\n]*)?\]\]/g;
export const RE_LIEN_MD = /(!?\[(?:[^\[\]\n]|\[[^\[\]\n]*\])*\]\()(<[^<>\n]*>|[^\s()<>]+(?:\([^\s()]*\)[^\s()<>]*)*)((?:[ \t]+(?:"[^"\n]*"|'[^'\n]*'|\([^()\n]*\)))?[ \t]*\))/g;

export interface Deplacement {
  /** Nom de page (sans .md) -> nouveau nom, ou null si non concerné. */
  nom: (nom: string) => string | null;
  /** Chemin logique d'un élément -> nouveau chemin, ou null si non concerné. */
  chemin: (chemin: string) => string | null;
}

/** Encode un chemin relatif pour une cible de lien Markdown (espaces, parenthèses…). */
export function encoderCible(rel: string): string {
  return rel.replace(/[%\s()<>#?]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
}

function relatifDepuis(dossier: string, cible: string): string {
  const r = path.posix.relative("/" + dossier, "/" + cible);
  return r === "" ? "." : r;
}

/**
 * Réécrit les liens d'une page après un renommage / déplacement :
 * - wikiliens `[[Ancien]]`, `[[Ancien|alias]]`, `[[Ancien#titre]]`, `[[Ancien/sous-page]]` (et `[[Ancien.md]]`) ;
 * - liens Markdown relatifs `[t](chemin)` / `![i](chemin)` dont la cible ou la page elle-même a bougé.
 * Rien n'est touché dans les blocs de code clôturés ni dans le code en ligne.
 */
export function reecrireLiens(contenu: string, dossierAvant: string, dossierApres: string, dep: Deplacement): { contenu: string; n: number } {
  let n = 0;
  const remplacerWiki = (s: string): string => s.replace(RE_WIKI, (tout, cible: string, ancre?: string, alias?: string) => {
    const t = cible.trim();
    if (!t) return tout;
    let nom = t.normalize("NFC");
    let ext = "";
    if (/\.md$/i.test(nom)) { ext = nom.slice(-3); nom = nom.slice(0, -3); }
    const nouveau = dep.nom(nom);
    if (nouveau == null || nouveau === nom) return tout;
    n++;
    const debut = cible.slice(0, cible.indexOf(t[0]));
    const fin = cible.slice(cible.lastIndexOf(t[t.length - 1]) + 1);
    return `[[${debut}${nouveau}${ext}${fin}${ancre ?? ""}${alias ?? ""}]]`;
  });
  const remplacerMd = (s: string): string => s.replace(RE_LIEN_MD, (tout, avant: string, cibleBrute: string, apres: string) => {
    const chevrons = cibleBrute.startsWith("<");
    const cible = chevrons ? cibleBrute.slice(1, -1) : cibleBrute;
    if (!cible || /^[a-z][a-z0-9+.-]*:/i.test(cible) || cible.startsWith("#") || cible.startsWith("/")) return tout;
    const iSuffixe = cible.search(/[?#]/);
    const partie = iSuffixe === -1 ? cible : cible.slice(0, iSuffixe);
    const suffixe = iSuffixe === -1 ? "" : cible.slice(iSuffixe);
    if (!partie) return tout;
    const resolu = resoudre(dossierAvant, partie);
    if (resolu === null || resolu === "") return tout;
    const logique = resolu.normalize("NFC");
    const nouvelleCible = dep.chemin(logique) ?? logique;
    if (nouvelleCible === logique && dossierApres === dossierAvant) return tout;
    // le lien relatif existant désigne-t-il encore la bonne cible depuis le nouvel emplacement ?
    if (resoudre(dossierApres, partie)?.normalize("NFC") === nouvelleCible) return tout;
    const rel = relatifDepuis(dossierApres, nouvelleCible);
    n++;
    const encode = chevrons ? rel : encoderCible(rel);
    return `${avant}${chevrons ? "<" + encode + suffixe + ">" : encode + suffixe}${apres}`;
  });
  const lignes = contenu.split("\n");
  const code = marquerCode(lignes);
  let change = false;
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const l = lignes[i];
    if (!l.includes("[")) continue;
    const nl = horsCodeEnLigne(l, (s) => remplacerMd(remplacerWiki(s)));
    if (nl !== l) { lignes[i] = nl; change = true; }
  }
  return { contenu: change ? lignes.join("\n") : contenu, n };
}

/** Correspondances d'un déplacement « ancienNom(.md) + ancienNom/ -> nouveauNom(.md) + nouveauNom/ ». */
export function deplacement(ancienNom: string, nouveauNom: string): Deplacement {
  return {
    nom: (nom) => {
      if (nom === ancienNom) return nouveauNom;
      if (nom.startsWith(ancienNom + "/")) return nouveauNom + nom.slice(ancienNom.length);
      return null;
    },
    chemin: (c) => {
      if (c === ancienNom + ".md") return nouveauNom + ".md";
      if (c === ancienNom) return nouveauNom;
      if (c.startsWith(ancienNom + "/")) return nouveauNom + c.slice(ancienNom.length);
      return null;
    },
  };
}
