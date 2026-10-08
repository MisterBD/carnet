// Carnet · rétroliens (« pages qui pointent ici ») et aperçu d'une page, calculés à la demande sur l'index mémoire.
import { dossierDe, resoudre } from "../../shared/page.ts";
import type { Espace, Page } from "./espace.ts";
import { horsCodeEnLigne, marquerCode, RE_LIEN_MD, RE_WIKI } from "./markdown.ts";

export interface Retrolien {
  chemin: string;
  titre: string;
  icone: string | null;
  extrait: string;
}

/** Ensemble des chemins de page connus de l'arbre (pages réelles hors alias + pages « dossier »). */
function cheminsConnus(espace: Espace): Set<string> {
  const s = new Set<string>();
  for (const p of espace.pagesVisibles()) s.add(p.chemin);
  for (const d of espace.dossiers.keys()) s.add(d + ".md");
  return s;
}

/** Résout la cible d'un lien [[nom]] comme l'interface : chemin exact, relatif au dossier de la page, nom unique. */
export function resoudreWiki(connus: Set<string>, parNom: Map<string, string[]>, nom: string, depuis: string): string {
  const n = nom.replace(/^\/+/, "").normalize("NFC").replace(/\.md$/i, "");
  if (connus.has(n + ".md")) return n + ".md";
  const rel = resoudre(dossierDe(depuis), n);
  if (rel && connus.has(rel + ".md")) return rel + ".md";
  const candidats = parNom.get(n);
  if (candidats && candidats.length === 1) return candidats[0];
  return n + ".md";
}

/** Index « suffixe /nom.md » -> chemins, pour la résolution par nom unique (comme l'interface). */
function indexParNom(connus: Set<string>): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const c of connus) {
    const segs = c.slice(0, -3).split("/");
    // « a/b/c.md » répond à « c », « b/c » (suffixes stricts, comme le test endsWith("/" + n + ".md") du client)
    for (let i = 1; i < segs.length; i++) {
      const suffixe = segs.slice(i).join("/");
      const l = m.get(suffixe);
      if (l) l.push(c);
      else m.set(suffixe, [c]);
    }
  }
  return m;
}

/** Ligne d'un lien, nettoyée pour l'affichage (≤ 160 caractères). */
export function nettoyerLigne(l: string, max = 160): string {
  let t = l.trim()
    .replace(/^>\s*\[!\w+\][+-]?\s*/, "")
    .replace(/^(?:>\s*)+/, "")
    .replace(/^#{1,6}\s+/, "")
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, "")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/g, (_t, c: string, a?: string) => a || String(c).split("/").pop() || c)
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (t.length > max) t = t.slice(0, max - 1).trimEnd() + "…";
  return t;
}

export function retroliens(espace: Espace, cible: string, limite = 100): Retrolien[] {
  const connus = cheminsConnus(espace);
  const parNom = indexParNom(connus);
  const res: Retrolien[] = [];
  for (const p of espace.pagesVisibles()) {
    if (p.chemin === cible) continue;
    const ligne = premiereLigneVers(p, cible, connus, parNom);
    if (ligne === null) continue;
    res.push({ chemin: p.chemin, titre: p.titre, icone: p.icone, extrait: nettoyerLigne(ligne) });
  }
  res.sort((a, b) => (espace.pages.get(b.chemin)?.mtime ?? 0) - (espace.pages.get(a.chemin)?.mtime ?? 0));
  return res.slice(0, limite);
}

function premiereLigneVers(p: Page, cible: string, connus: Set<string>, parNom: Map<string, string[]>): string | null {
  if (!p.contenu.includes("[")) return null;
  const lignes = p.contenu.split("\n");
  const code = marquerCode(lignes);
  const dossier = dossierDe(p.chemin);
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const l = lignes[i].endsWith("\r") ? lignes[i].slice(0, -1) : lignes[i];
    if (!l.includes("[")) continue;
    let trouve = false;
    horsCodeEnLigne(l, (s) => {
      if (trouve) return s;
      for (const m of s.matchAll(RE_WIKI)) {
        const t = m[1].trim();
        if (t && resoudreWiki(connus, parNom, t, p.chemin) === cible) { trouve = true; return s; }
      }
      for (const m of s.matchAll(RE_LIEN_MD)) {
        let c = m[2];
        if (c.startsWith("<")) c = c.slice(1, -1);
        if (!c || /^[a-z][a-z0-9+.-]*:/i.test(c) || c.startsWith("#") || c.startsWith("/")) continue;
        const partie = c.split(/[?#]/)[0];
        if (!partie) continue;
        const r = resoudre(dossier, partie);
        if (r && r.normalize("NFC") === cible) { trouve = true; return s; }
      }
      return s;
    });
    if (trouve) return l;
  }
  return null;
}

/** Corps en texte simple pour un aperçu (≈ `max` caractères, lignes gardées). */
export function texteApercu(corps: string, max = 600): string {
  const lignes = corps.split("\n");
  const code = marquerCode(lignes);
  const out: string[] = [];
  let total = 0;
  let videAvant = false;
  for (let i = 0; i < lignes.length && total < max; i++) {
    if (code[i]) continue;
    const brute = lignes[i].replace(/\r$/, "");
    if (/^\s*\|?\s*:?-{3,}/.test(brute) || /^\s*(---|\*\*\*|___)\s*$/.test(brute) || /^\s*<\/?[a-z]/i.test(brute)) continue;
    const tableau = /^\s*\|/.test(brute);
    const t = nettoyerLigne(tableau ? brute.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim()).join(" · ") : brute, 300);
    if (!t) {
      if (out.length && !videAvant) { out.push(""); videAvant = true; }
      continue;
    }
    videAvant = false;
    out.push(t);
    total += t.length + 1;
  }
  let s = out.join("\n").trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + "…";
  return s;
}
