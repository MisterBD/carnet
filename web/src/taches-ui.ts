// Lot 1 « Aujourd'hui » : mise en mots des marqueurs de tâche (format Obsidian Tasks), pour l'écran Aujourd'hui et
// les pastilles de l'éditeur. Lecture seule : rien ici ne modifie un fichier.
import type { Priorite } from "./api";

let fuseau = "Europe/Paris";

/** Fuseau des échéances (configuration du serveur, Europe/Paris par défaut). */
export function fixerFuseau(f: string | undefined | null): void {
  if (!f) return;
  try { new Intl.DateTimeFormat("fr-FR", { timeZone: f }); fuseau = f; } catch { /* fuseau inconnu : on garde le précédent */ }
}

/** Date du jour AAAA-MM-JJ dans le fuseau du carnet. */
export function dateDuJour(maintenant = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: fuseau, year: "numeric", month: "2-digit", day: "2-digit" }).format(maintenant);
}

/** Ajoute `n` jours à une date AAAA-MM-JJ (calcul en UTC : pas d'effet d'heure d'été). */
export function plusJours(iso: string, n: number): string {
  const d = new Date(iso + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Écart en jours entre deux dates AAAA-MM-JJ (b - a). */
export function ecartJours(a: string, b: string): number {
  return Math.round((Date.parse(b + "T12:00:00Z") - Date.parse(a + "T12:00:00Z")) / 86_400_000);
}

const fmtJourSemaine = new Intl.DateTimeFormat("fr-FR", { weekday: "long", timeZone: "UTC" });
const fmtCourt = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", timeZone: "UTC" });
const fmtCourtAn = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
const fmtLong = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

/** « aujourd'hui », « demain », « hier », « vendredi », « 12 oct. »… */
export function libelleDate(iso: string, jour = dateDuJour()): string {
  const d = new Date(iso + "T12:00:00Z");
  if (Number.isNaN(d.getTime())) return iso;
  const n = ecartJours(jour, iso);
  if (n === 0) return "aujourd'hui";
  if (n === 1) return "demain";
  if (n === -1) return "hier";
  if (n > 1 && n < 7) return fmtJourSemaine.format(d);
  return iso.slice(0, 4) === jour.slice(0, 4) ? fmtCourt.format(d) : fmtCourtAn.format(d);
}

/** Libellé complet pour les lecteurs d'écran et les infobulles : « vendredi 12 octobre 2026 ». */
export function dateEnToutesLettres(iso: string): string {
  const d = new Date(iso + "T12:00:00Z");
  return Number.isNaN(d.getTime()) ? iso : fmtLong.format(d);
}

/** Ton d'une échéance : en retard (rouge), du jour (indigo), proche (ambre, 2 jours), plus tard (gris). */
export function tonEcheance(iso: string, jour = dateDuJour()): "rouge" | "bleu" | "ambre" | "gris" {
  const n = ecartJours(jour, iso);
  if (n < 0) return "rouge";
  if (n === 0) return "bleu";
  if (n <= 2) return "ambre";
  return "gris";
}

export const PRIORITES: { cle: Priorite; libelle: string; emoji: string }[] = [
  { cle: "plus-haute", libelle: "Priorité maximale", emoji: "🔺" },
  { cle: "haute", libelle: "Priorité haute", emoji: "⏫" },
  { cle: "moyenne", libelle: "Priorité moyenne", emoji: "🔼" },
  { cle: "basse", libelle: "Priorité basse", emoji: "🔽" },
  { cle: "plus-basse", libelle: "Priorité minimale", emoji: "⏬" },
];

export function libellePriorite(p: Priorite): string {
  return { "plus-haute": "maximale", haute: "haute", moyenne: "moyenne", basse: "basse", "plus-basse": "minimale" }[p];
}

export function tonPriorite(p: Priorite): "rouge" | "ambre" | "bleu" | "gris" {
  return p === "plus-haute" ? "rouge" : p === "haute" ? "ambre" : p === "moyenne" ? "bleu" : "gris";
}

/** Rang pour trier (0 = la plus haute ; sans priorité = entre moyenne et basse, comme Obsidian Tasks). */
export function rangPriorite(p: Priorite | undefined): number {
  return p === "plus-haute" ? 0 : p === "haute" ? 1 : p === "moyenne" ? 2 : p === undefined ? 3 : p === "basse" ? 4 : 5;
}

const JOURS: Record<string, string> = {
  monday: "lundi", tuesday: "mardi", wednesday: "mercredi", thursday: "jeudi", friday: "vendredi", saturday: "samedi", sunday: "dimanche",
};
const UNITES: Record<string, [string, string, boolean]> = {
  day: ["jour", "jours", false], week: ["semaine", "semaines", true], month: ["mois", "mois", false], year: ["année", "ans", true],
};

/**
 * Récurrence Obsidian Tasks (« every week », « every 2 days », « every week on Monday », « … when done ») en français.
 * Texte non reconnu : renvoyé entre guillemets, tel quel. Rien n'est jamais exécuté (vague 1).
 */
export function libelleRecurrence(brut: string): string {
  const r = brut.trim().toLowerCase().replace(/\s+/g, " ");
  if (!r) return "récurrence vide";
  let reste = r;
  let apres = "";
  if (reste.endsWith(" when done")) { reste = reste.slice(0, -10); apres = " (après réalisation)"; }
  let m = /^every (day|week|month|year)$/.exec(reste);
  if (m) return `${m[1] === "day" ? "chaque jour" : m[1] === "week" ? "chaque semaine" : m[1] === "month" ? "chaque mois" : "chaque année"}${apres}`;
  if (reste === "every weekday") return `chaque jour de semaine${apres}`;
  m = /^every (\d{1,3}) (day|week|month|year)s?$/.exec(reste);
  if (m) {
    const [sing, plur, fem] = UNITES[m[2]];
    const n = Number(m[1]);
    if (n === 1) return `chaque ${sing}${apres}`;
    return `${fem ? "toutes les" : "tous les"} ${n} ${plur}${apres}`;
  }
  m = /^every (?:week )?on ([a-z, ]+)$/.exec(reste);
  if (m) {
    const jours = m[1].split(/,\s*|\s+and\s+/).map((j) => JOURS[j.trim()]).filter(Boolean);
    if (jours.length) return `chaque semaine le ${jours.join(", ")}${apres}`;
  }
  return `« ${brut.trim()} »`;
}

/** Libellé d'un statut entre crochets (« [/] » en cours, « [-] » annulée…). */
export function libelleStatut(c: string): string | null {
  if (c === " " || c === "x" || c === "X") return null;
  if (c === "/") return "en cours";
  if (c === "-") return "annulée";
  return `statut « ${c} »`;
}

/** Message lisible d'une erreur renvoyée par `modifierTache` (refus ciblé d'un marqueur en double ou invalide). */
export function messageRefusTache(e: unknown): string {
  const m = (e as Error)?.message ?? String(e);
  return m.charAt(0).toUpperCase() + m.slice(1);
}

// ---------- Pont vers les dialogues de l'appli (l'éditeur n'est pas un composant React) ----------

/** undefined = annulé ; null = retirer ; sinon la nouvelle valeur. */
export interface ChoixTache {
  date(o: { titre: string; valeur: string | null }): Promise<string | null | undefined>;
  priorite(actuelle: Priorite | null): Promise<Priorite | null | undefined>;
}

let pont: ChoixTache | null = null;

export function brancherChoixTache(p: ChoixTache | null): void {
  pont = p;
}

export function demanderDate(o: { titre: string; valeur: string | null }): Promise<string | null | undefined> {
  return pont ? pont.date(o) : Promise.resolve(undefined);
}

export function demanderPriorite(actuelle: Priorite | null): Promise<Priorite | null | undefined> {
  return pont ? pont.priorite(actuelle) : Promise.resolve(undefined);
}

/** Anomalie raccourcie pour une pastille (le détail entre parenthèses reste dans l'infobulle). */
export function resumerAnomalie(a: string): string {
  const i = a.indexOf(" (");
  return i > 0 ? a.slice(0, i) : a;
}
