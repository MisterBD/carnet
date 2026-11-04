// Carnet V3 · lot 1 « Aujourd'hui » : fonctions pures (sans disque ni réseau) pour l'écran Aujourd'hui, la boîte de
// réception et les captures. Les écritures passent par la porte commune du socle (routes-aujourdhui.ts).
import { decouper, nomDeFichier, scalaireYaml } from "../../shared/page.ts";
import { analyserTache, marquerCode, type TacheAnalysee } from "../../shared/taches.ts";
import type { FicheDatee } from "./bases.ts";

// ---------------------------------------------------------------------------------------------
// Dates : celles du socle (shared/identifiants.ts : dateDuJour, horodatageIso), plus un utilitaire de calendrier
// ---------------------------------------------------------------------------------------------

export function plusJours(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------------------------------------
// Tâches : relevé et classement
// ---------------------------------------------------------------------------------------------

export interface TacheJour {
  chemin: string;
  titre: string;
  icone: string | null;
  ligne: number;
  texte: string;
  libelle: string;
  coche: string;
  echeance?: string;
  prevue?: string;
  debut?: string;
  priorite?: TacheAnalysee["priorite"];
  recurrence?: string;
  anomalies: string[];
  /** Échéances (11/10/2026) : fiche d'une base (ligne = -1, texte = "") ; se coche par POST /api/aujourdhui/fiche. */
  fiche?: FicheDatee["fiche"];
}

/** Une fiche datée vue comme une tâche : même classement, même affichage ; `fiche` dit d'où elle vient. */
export function tacheDeFiche(f: FicheDatee): TacheJour {
  return {
    chemin: f.chemin, titre: f.titre, icone: f.icone, ligne: -1, texte: "", libelle: f.titre, coche: " ",
    echeance: f.echeance, ...(f.priorite ? { priorite: f.priorite } : {}), anomalies: f.anomalies, fiche: f.fiche,
  };
}

export interface PageSource {
  chemin: string;
  titre: string;
  icone: string | null;
  mtime: number;
  contenu: string;
}

const RE_DEBUT_TACHE = /^[ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+\[/;
/** Statuts considérés comme clos : faite (x, X) et annulée (-). Les autres (« / » en cours, personnalisés) restent ouverts. */
const CLOS = new Set(["x", "X", "-"]);

/**
 * Tâches OUVERTES d'une page, hors frontmatter et hors blocs de code clôturés (l'appelant de `analyserTache` est
 * responsable de cette exclusion). Une tâche annulée par ❌ est close elle aussi.
 */
export function tachesOuvertes(p: PageSource): TacheJour[] {
  const lignes = p.contenu.split("\n");
  const code = marquerCode(lignes);
  const fm = decouper(p.contenu).frontmatter;
  const debut = fm ? fm.split("\n").length - (fm.endsWith("\n") ? 1 : 0) : 0;
  const res: TacheJour[] = [];
  for (let i = debut; i < lignes.length; i++) {
    if (code[i]) continue;
    const l = lignes[i].endsWith("\r") ? lignes[i].slice(0, -1) : lignes[i];
    if (!RE_DEBUT_TACHE.test(l)) continue;
    const a = analyserTache(l);
    if (!a || CLOS.has(a.coche) || a.annulee) continue;
    const t: TacheJour = { chemin: p.chemin, titre: p.titre, icone: p.icone, ligne: i, texte: l, libelle: a.texte, coche: a.coche, anomalies: a.anomalies };
    if (a.echeance) t.echeance = a.echeance;
    if (a.prevue) t.prevue = a.prevue;
    if (a.debut) t.debut = a.debut;
    if (a.priorite) t.priorite = a.priorite;
    if (a.recurrence !== undefined) t.recurrence = a.recurrence;
    res.push(t);
  }
  return res;
}

export function rangPriorite(p: TacheJour["priorite"]): number {
  return p === "plus-haute" ? 0 : p === "haute" ? 1 : p === "moyenne" ? 2 : p === undefined ? 3 : p === "basse" ? 4 : 5;
}

export interface Classement {
  enRetard: TacheJour[];
  aujourdhui: TacheJour[];
  semaine: TacheJour[];
  plusTard: TacheJour[];
  sansDate: TacheJour[];
}

/**
 * Classe les tâches ouvertes par date de référence = échéance (📅), à défaut date prévue (⏳) :
 * en retard (< jour), aujourd'hui (= jour), 7 prochains jours (jour+1 … jour+7), plus tard, sans date.
 * Une date invalide n'est JAMAIS une date : la tâche reste « sans date », avec son anomalie.
 */
export function classer(taches: TacheJour[], jour: string, mtimes: Map<string, number> = new Map()): Classement {
  const limite = plusJours(jour, 7);
  const c: Classement = { enRetard: [], aujourdhui: [], semaine: [], plusTard: [], sansDate: [] };
  for (const t of taches) {
    const ref = t.echeance ?? t.prevue;
    if (!ref) c.sansDate.push(t);
    else if (ref < jour) c.enRetard.push(t);
    else if (ref === jour) c.aujourdhui.push(t);
    else if (ref <= limite) c.semaine.push(t);
    else c.plusTard.push(t);
  }
  const ref = (t: TacheJour) => t.echeance ?? t.prevue ?? "";
  const parDate = (a: TacheJour, b: TacheJour) => ref(a).localeCompare(ref(b)) || rangPriorite(a.priorite) - rangPriorite(b.priorite)
    || a.chemin.localeCompare(b.chemin) || a.ligne - b.ligne;
  const parPriorite = (a: TacheJour, b: TacheJour) => rangPriorite(a.priorite) - rangPriorite(b.priorite)
    || (mtimes.get(b.chemin) ?? 0) - (mtimes.get(a.chemin) ?? 0) || a.chemin.localeCompare(b.chemin) || a.ligne - b.ligne;
  c.enRetard.sort(parDate);
  c.aujourdhui.sort(parPriorite);
  c.semaine.sort(parDate);
  c.plusTard.sort(parDate);
  c.sansDate.sort(parPriorite);
  return c;
}

// ---------------------------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------------------------

export const MAX_TEXTE_CAPTURE = 200_000;
export const MAX_TITRE_CAPTURE = 200;
export const MAX_LIEN_CAPTURE = 2048;

/** Lien enregistré tel quel s'il est une adresse http(s) sans espace ni caractère de contrôle ; sinon null. */
export function lienValide(brut: string): string | null {
  const l = brut.trim();
  if (!l || l.length > MAX_LIEN_CAPTURE || /[\s\u0000-\u001f\u007f]/.test(l)) return null;
  try {
    const u = new URL(l);
    return u.protocol === "http:" || u.protocol === "https:" ? l : null;
  } catch {
    return null;
  }
}

/** Titre d'une ligne, sans caractère de contrôle ni retour à la ligne. */
export function titreUneLigne(brut: string): string {
  return brut.normalize("NFC").replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, MAX_TITRE_CAPTURE);
}

/** Base du nom de fichier : le titre, sinon le début du texte, sinon l'hôte du lien, sinon « Capture ». */
export function baseNomCapture(o: { titre?: string; texte: string; source?: string | null }): string {
  let base = o.titre ? titreUneLigne(o.titre) : "";
  if (!base) {
    const premiere = o.texte.split("\n").map((l) => l.replace(/^[\s#>*+-]+/, "").trim()).find((l) => l) ?? "";
    base = premiere.length > 60 ? premiere.slice(0, 60).replace(/\s+\S*$/, "") || premiere.slice(0, 60) : premiere;
  }
  if (!base && o.source) {
    try { base = new URL(o.source).host.replace(/^www\./, ""); } catch { /* lien déjà validé */ }
  }
  const n = nomDeFichier(base || "Capture");
  return n === "Sans titre" ? "Capture" : n;
}

/**
 * Contenu d'une capture : frontmatter écrit par Carnet (le texte n'y entre jamais), puis le texte LITTÉRAL.
 * Le texte capturé ne peut pas devenir un frontmatter : il commence toujours après le nôtre.
 */
export function contenuCapture(o: { id: string; cree: string; texte: string; source?: string | null; titre?: string | null }): string {
  const lignes = ["---", "type: capture", `id: ${o.id}`, `cree: ${o.cree}`];
  if (o.source) lignes.push(`source: ${scalaireYaml(o.source)}`);
  const titre = o.titre ? titreUneLigne(o.titre) : "";
  if (titre) lignes.push(`title: ${scalaireYaml(titre)}`);
  lignes.push("---", "");
  const corps = o.texte === "" ? "" : o.texte.endsWith("\n") ? o.texte : o.texte + "\n";
  return lignes.join("\n") + "\n" + corps;
}

/** Valeur texte d'un champ de frontmatter (chaîne, nombre, date YAML), sinon null. */
export function champTexte(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number") return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString();
  return null;
}
