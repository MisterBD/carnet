// Carnet V3 · lot 6 « Pages » : application d'un modèle de page (dossier « Modèles/ »).
//
// Variables : {{date}} (AAAA-MM-JJ), {{heure}} (HHhMM), {{titre}} — fuseau du serveur (CARNET_FUSEAU, Europe/Paris).
// Règles :
//   - remplacement LITTÉRAL en une seule passe : une valeur qui contient elle-même « {{date}} » (un titre, par exemple)
//     n'est jamais réinterprétée ; aucun motif « $& » ni expression n'est évalué ;
//   - variable inconnue (« {{auteur}} », « {{ titre }} » avec espaces, « {{title}} ») conservée telle quelle ;
//   - corps : remplacement textuel ; en-tête YAML : seules les VALEURS de premier niveau (texte, ou liste de textes)
//     sont remplacées, et réécrites par `poserPropriete` du socle (guillemets si nécessaire, reste de l'en-tête à
//     l'octet, résultat réanalysé) : un titre avec guillemets, deux-points ou accents garde un YAML valide.
//     Ailleurs dans l'en-tête (clé, commentaire, objet imbriqué), une variable reste telle quelle ;
//   - le modèle lui-même n'est jamais modifié (fonction pure).
// Côté serveur seulement (l'analyseur YAML doit être installé : server/src/analyseur-yaml.ts).
import { decouper, sansBlancsFinaux } from "./page.ts";
import { ErreurFormat, lireProprietes, poserPropriete } from "./proprietes.ts";

export interface VariablesModele {
  date: string;
  heure: string;
  titre: string;
}

const RE_VAR = /\{\{(date|heure|titre)\}\}/g;
const RE_VAR_TEST = /\{\{(?:date|heure|titre)\}\}/;
/**
 * Valeur YAML « nue » qui commence par une variable connue : `cle: {{titre}} — suite` ou `- {{date}}`. Sans guillemets,
 * YAML y lirait un objet (`{…}`) : on la met d'abord entre apostrophes (texte), puis la valeur est remplacée proprement.
 */
// (?<![ \t]) devant le commentaire final : même résultat, temps linéaire sur une longue suite d'espaces.
const RE_NUE = /^([ \t]*(?:-[ \t]+|[^\s#'"[{-][^:\n]*?:[ \t]+))(\{\{(?:date|heure|titre)\}\}[^\n]*?)((?<![ \t])[ \t]+#[^\n]*)?$/;

/** Remplacement littéral, une seule passe. */
export function remplacerVariables(texte: string, v: VariablesModele): string {
  return texte.replace(RE_VAR, (_m, nom: string) => v[nom as keyof VariablesModele]);
}

export function contientVariable(texte: string): boolean {
  return RE_VAR_TEST.test(texte);
}

/** « 08h12 » à partir d'un horodatage ISO local (« 2026-10-11T08:12:03+02:00 »). */
export function heureDe(iso: string): string {
  return `${iso.slice(11, 13)}h${iso.slice(14, 16)}`;
}

/** Contenu de la nouvelle page. ErreurFormat (422) si l'en-tête du modèle n'est pas un YAML modifiable. */
export function appliquerModele(modele: string, v: VariablesModele): string {
  const d = decouper(modele);
  const corps = remplacerVariables(modele.slice(d.frontmatter.length), v);
  if (!d.frontmatter || !contientVariable(d.yaml)) return d.frontmatter + corps;
  // 1. valeurs nues → texte entre apostrophes (une apostrophe intérieure est doublée, règle YAML)
  const fm = d.frontmatter.split("\n").map((ligne) => {
    const m = RE_NUE.exec(ligne.replace(/\r$/, ""));
    if (!m) return ligne;
    const cr = ligne.endsWith("\r") ? "\r" : "";
    return `${m[1]}'${sansBlancsFinaux(m[2]).replace(/'/g, "''")}'${m[3] ?? ""}${cr}`;
  }).join("\n");
  let res = fm + corps;
  const lp = lireProprietes(res);
  if (!lp.yamlValide) {
    throw new ErreurFormat(`L'en-tête YAML du modèle est invalide : ${lp.problemes[0] ?? "erreur de syntaxe"}.`, "modele_invalide");
  }
  // 2. valeurs de premier niveau : remplacées, réécrites par le socle (guillemets si nécessaire)
  for (const [cle, val] of Object.entries(lp.valeurs)) {
    if (typeof val === "string" && contientVariable(val)) {
      res = poserPropriete(res, cle, remplacerVariables(val, v));
    } else if (Array.isArray(val) && val.length && val.every((x) => typeof x === "string") && val.some((x) => contientVariable(x as string))) {
      res = poserPropriete(res, cle, (val as string[]).map((x) => remplacerVariables(x, v)));
    }
  }
  const fin = lireProprietes(res);
  if (!fin.yamlValide) throw new ErreurFormat("Le modèle produirait un en-tête YAML invalide.", "modele_invalide");
  return res;
}
