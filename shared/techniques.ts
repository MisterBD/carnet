// Carnet · « fichiers des agents » (fichiers techniques) : règles par chemins explicites, avec exceptions.
// Partagé serveur + interface, sans dépendance. Les fichiers techniques restent accessibles et trouvables par une
// recherche explicite ; ils sont seulement regroupés à part dans l'arbre et exclus des parcours quotidiens
// (accueil, récents, nouveautés) par défaut.
//
// Grammaire FERMÉE d'une règle (CARNET_TECHNIQUES, entrées séparées par « ; » ou des retours à la ligne) :
//   NOM.md         un fichier de ce nom, à n'importe quelle profondeur (ex. « CLAUDE.md »)
//   dossier/       un dossier de ce nom, à n'importe quelle profondeur, avec tout son contenu et sa page « dossier.md »
//   /a/b.md, a/b/  chemin ancré à la racine de l'espace (une barre au début ou au milieu = ancré)
//   !règle         exception : jamais technique (ex. « !raw/LISEZ-MOI.md »)
//   défaut         insère les règles par défaut (TECHNIQUES_DEFAUT) à cet endroit
// Aucun joker (*, ?, [ ]) ni « .. ». La casse compte (« Raw/ » n'est pas « raw/ »).
// Protection absolue : aucun chemin dont un segment vaut « inbox » (toutes casses : Inbox, inbox, INBOX…) n'est
// jamais technique, quelles que soient les règles : la boîte de capture ne disparaît jamais par erreur.

export interface RegleTechnique {
  /** Texte de la règle tel qu'écrit (sans le « ! »). */
  brut: string;
  exception: boolean;
  ancree: boolean;
  dossier: boolean;
  segments: string[];
}

export interface Techniques {
  regles: RegleTechnique[];
  /** Règles écartées (visaient la boîte de capture), à signaler au démarrage. */
  ignorees: string[];
}

/** Défaut raisonnable pour un espace d'agents. */
export const TECHNIQUES_DEFAUT = ["AGENTS.md", "AGENTS-lite.md", "CLAUDE.md", "CONFIG.md", "log.md", "raw/"];

const RE_INTERDIT = /[*?[\]\\\u0000-\u001f\u007f]/;

export class ErreurRegle extends Error {}

function protege(segments: string[]): boolean {
  return segments.some((s) => s.toLowerCase() === "inbox" || s.toLowerCase() === "inbox.md");
}

/** Analyse une règle ; lève ErreurRegle si elle sort de la grammaire. */
export function analyserRegle(texte: string): RegleTechnique {
  let t = texte.normalize("NFC").trim();
  const exception = t.startsWith("!");
  if (exception) t = t.slice(1).trim();
  if (!t) throw new ErreurRegle("règle vide");
  if (RE_INTERDIT.test(t)) throw new ErreurRegle(`caractère interdit dans « ${t} » (pas de joker ni d'antislash)`);
  const ancreeTete = t.startsWith("/");
  const dossier = t.endsWith("/");
  const corps = t.replace(/^\/+/, "").replace(/\/+$/, "");
  if (!corps) throw new ErreurRegle(`règle « ${t} » sans nom`);
  const segments = corps.split("/");
  for (const s of segments) {
    if (s === "" || s === "." || s === "..") throw new ErreurRegle(`segment invalide dans « ${t} »`);
    if (s.startsWith(".")) throw new ErreurRegle(`« ${t} » : les fichiers cachés le sont déjà`);
  }
  return { brut: t, exception, ancree: ancreeTete || segments.length > 1, dossier, segments };
}

/**
 * Lit la configuration : `undefined` = défaut ; chaîne vide = aucune règle ; sinon entrées séparées par « ; » ou
 * des retours à la ligne, le mot « défaut » insérant les règles par défaut.
 */
export function lireTechniques(brut: string | undefined): Techniques {
  const entrees = brut === undefined ? ["défaut"] : brut.split(/[;\n]+/).map((x) => x.trim()).filter(Boolean);
  const regles: RegleTechnique[] = [];
  const ignorees: string[] = [];
  const ajouter = (txt: string) => {
    const r = analyserRegle(txt);
    if (!r.exception && protege(r.segments)) { ignorees.push(txt); return; }
    regles.push(r);
  };
  for (const e of entrees) {
    if (e === "défaut" || e === "defaut") TECHNIQUES_DEFAUT.forEach(ajouter);
    else ajouter(e);
  }
  return { regles, ignorees };
}

/** Règles sous forme de texte (pour l'API et l'interface) : l'interface les relit avec `lireTechniques`. */
export function texteTechniques(t: Techniques): string {
  return t.regles.map((r) => (r.exception ? "!" : "") + (r.ancree && r.segments.length === 1 ? "/" : "") + r.segments.join("/") + (r.dossier ? "/" : "")).join(";");
}

function correspond(r: RegleTechnique, segs: string[]): boolean {
  const n = r.segments.length;
  if (r.dossier) {
    // le dossier lui-même (sa page « dossier.md ») ou tout ce qui est dessous
    const nom = r.segments[n - 1];
    const memesDebut = (depart: number) => r.segments.slice(0, n - 1).every((s, k) => segs[depart + k] === s);
    if (r.ancree) {
      if (!memesDebut(0)) return false;
      if (segs.length > n && segs[n - 1] === nom) return true;
      return segs.length === n && segs[n - 1] === nom + ".md";
    }
    for (let i = 0; i < segs.length; i++) {
      if (i < segs.length - 1 && segs[i] === nom) return true;
      if (i === segs.length - 1 && segs[i] === nom + ".md") return true;
    }
    return false;
  }
  if (r.ancree) return segs.length === n && r.segments.every((s, k) => segs[k] === s);
  return segs[segs.length - 1] === r.segments[0];
}

/** Le chemin logique (page « x.md », dossier représenté par sa page « x.md », ou fichier) est-il technique ? */
export function estTechnique(t: Techniques, chemin: string): boolean {
  if (!t.regles.length || !chemin) return false;
  const segs = chemin.normalize("NFC").split("/");
  if (protege(segs)) return false;
  let technique = false;
  for (const r of t.regles) {
    if (!r.exception && !technique && correspond(r, segs)) technique = true;
  }
  if (!technique) return false;
  return !t.regles.some((r) => r.exception && correspond(r, segs));
}
