// Carnet · aides partagées (serveur + interface) pour la navigation : titre d'une page, nom de fichier qui suit le
// titre, couverture, liens [[…]] d'un corps. Aucune dépendance (importable par Node 22 et par Vite).
import { decouper, feuille, lireChampSimple, nomDeFichier } from "./page.ts";

export type SourceTitre = "fm" | "h1" | "nom";

/** Titre affiché d'une page et sa source : `title:` du frontmatter, sinon `# Titre` en tête, sinon le nom du fichier. */
export function titreDe(chemin: string, contenu: string): { titre: string; source: SourceTitre } {
  const d = decouper(contenu);
  const fm = lireChampSimple(d.yaml, "title");
  if (fm && fm.trim()) return { titre: fm.trim(), source: "fm" };
  if (d.titreH1 !== null && d.titreH1.trim()) return { titre: d.titreH1.trim(), source: "h1" };
  return { titre: feuille(chemin), source: "nom" };
}

/**
 * Le nom du fichier « suit » le titre : la page n'a pas de titre écrit (le titre EST le nom du fichier), ou son nom
 * de fichier est exactement celui qu'on fabriquerait à partir de son titre (« Courses.md » et « # Courses »).
 * Dans ce cas, changer le titre renomme aussi le fichier (et les liens qui y mènent) ; sinon (« 2026-10-08-note.md »
 * titré « Notes du jour », nom choisi par un agent) seul le titre change.
 */
export function nomSuitLeTitre(chemin: string, contenu: string): boolean {
  const { titre, source } = titreDe(chemin, contenu);
  if (source === "nom") return true;
  return nomDeFichier(titre) === feuille(chemin);
}

// ---------------------------------------------------------------------------------------------
// Couverture : frontmatter `cover:`, soit un dégradé maison (`degrade-ocean`), soit une image de l'espace
// (chemin relatif au dossier de la page, comme un lien Markdown : `_assets/mer.webp`).
// ---------------------------------------------------------------------------------------------

export const DEGRADES = ["ocean", "aurore", "lagon", "sable", "foret", "crepuscule", "ardoise", "corail"] as const;
export type NomDegrade = (typeof DEGRADES)[number];

export type Couverture = { type: "degrade"; nom: NomDegrade } | { type: "image"; relatif: string };

const RE_IMAGE = /\.(png|jpe?g|webp|gif|avif)$/i;

/** Analyse la valeur de `cover:`. Valeur inconnue = pas de couverture (jamais d'URL externe ni de style libre). */
export function lireCouverture(valeur: string | null | undefined): Couverture | null {
  const v = (valeur ?? "").trim();
  if (!v) return null;
  const m = /^degrade-([a-z]+)$/.exec(v);
  if (m) return (DEGRADES as readonly string[]).includes(m[1]) ? { type: "degrade", nom: m[1] as NomDegrade } : null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v) || v.startsWith("//") || v.startsWith("/") || v.includes("\\")) return null;
  if (!RE_IMAGE.test(v.split(/[?#]/)[0])) return null;
  return { type: "image", relatif: v };
}

export function valeurCouverture(c: Couverture): string {
  return c.type === "degrade" ? `degrade-${c.nom}` : c.relatif;
}

// ---------------------------------------------------------------------------------------------
// Liens [[…]] d'un corps (hors blocs de code clôturés et hors code en ligne).
// ---------------------------------------------------------------------------------------------

const RE_CLOTURE = /^ {0,3}(`{3,}|~{3,})/;
const RE_WIKI = /\[\[([^\[\]\n|#]+)(?:#[^\[\]\n|]*)?(?:\|[^\[\]\n]*)?\]\]/g;

/** Cibles (texte brut entre [[ et | ou #) des liens de page d'un corps Markdown, dans l'ordre, sans doublon. */
export function liensWiki(corps: string): string[] {
  const vus = new Set<string>();
  const res: string[] = [];
  let cloture: string | null = null;
  for (const brute of corps.split("\n")) {
    const l = brute.replace(/\r$/, "");
    const m = RE_CLOTURE.exec(l);
    if (cloture) {
      if (m && m[1][0] === cloture[0] && m[1].length >= cloture.length && l.trim() === m[1]) cloture = null;
      continue;
    }
    if (m) { cloture = m[1]; continue; }
    if (!l.includes("[[")) continue;
    const sansCode = l.replace(/(`+)[^`]*?\1/g, "");
    for (const x of sansCode.matchAll(RE_WIKI)) {
      const t = x[1].trim().normalize("NFC").replace(/\.md$/i, "");
      if (t && !vus.has(t)) { vus.add(t); res.push(t); }
    }
  }
  return res;
}

/**
 * Page désignée par un lien [[nom]] écrit dans la page `depuis` : chemin exact (« Démo/To-do »), puis relatif au
 * dossier de la page qui lie, puis nom de fichier unique dans l'espace (style Obsidian). null si rien ne correspond.
 * `existe` dit si un chemin de page (« X.md ») existe ; `chemins` sert à la recherche par nom de fichier.
 */
export function resoudreCible(nom: string, depuis: string, existe: (chemin: string) => boolean, chemins: Iterable<string>): string | null {
  const n = nom.replace(/^\/+/, "").normalize("NFC").replace(/\.md$/i, "");
  if (!n) return null;
  if (existe(n + ".md")) return n + ".md";
  const i = depuis.lastIndexOf("/");
  const dossier = i === -1 ? "" : depuis.slice(0, i);
  if (dossier) {
    const pile = dossier.split("/");
    for (const seg of n.split("/")) {
      if (seg === "..") pile.pop();
      else if (seg !== "." && seg !== "") pile.push(seg);
    }
    const rel = pile.join("/");
    if (rel && existe(rel + ".md")) return rel + ".md";
  }
  const suffixe = "/" + n + ".md";
  let trouve: string | null = null;
  for (const c of chemins) {
    if (c.endsWith(suffixe)) {
      if (trouve !== null) return null; // ambigu
      trouve = c;
    }
  }
  return trouve;
}
