// Petits utilitaires d'affichage.
import { plier } from "../../shared/page.ts";

const fmtDate = new Intl.DateTimeFormat("fr-FR", { weekday: "long", day: "numeric", month: "long" });
const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short" });

export function dateLongue(d = new Date()): string {
  // En français, le jour et le mois ne prennent pas de majuscule : « jeudi 8 octobre ».
  return fmtDate.format(d);
}

export function ilYA(mtime: number): string {
  if (!mtime) return "";
  const ms = mtime > 1e12 ? mtime : mtime * 1000;
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "à l'instant";
  if (s < 3600) return `il y a ${Math.floor(s / 60)} min`;
  if (s < 86400) return `il y a ${Math.floor(s / 3600)} h`;
  if (s < 86400 * 2) return "hier";
  if (s < 86400 * 7) return `il y a ${Math.floor(s / 86400)} j`;
  return fmtJour.format(new Date(ms));
}

export function salut(d = new Date()): string {
  const h = d.getHours();
  if (h >= 18 || h < 4) return "Bonsoir";
  return "Bonjour";
}

/** Couleur d'une pastille de statut. */
export function tonStatut(statut: string | undefined | null): string {
  const s = plier(statut ?? "");
  if (!s) return "gris";
  if (/(termine|fait|livre|valide|publie|ok)/.test(s)) return "vert";
  if (/(relire|attente|propose|revoir)/.test(s)) return "ambre";
  if (/(cours|actif|demarre)/.test(s)) return "bleu";
  if (/(bloque|urgent|alerte|retard|abandon)/.test(s)) return "rouge";
  if (/(pause|idee|plus tard)/.test(s)) return "violet";
  return "gris";
}

export function estEmoji(s: string | null | undefined): boolean {
  return !!s && /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(s) && s.length <= 16;
}

export function classes(...c: Array<string | false | null | undefined>): string {
  return c.filter(Boolean).join(" ");
}

export const tactile = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

/** Journal de diagnostic, actif seulement si localStorage « carnet:debug » vaut 1 (recette, dépannage). */
let debug = false;
try { debug = localStorage.getItem("carnet:debug") === "1"; } catch { /* navigation privée */ }
export function trace(...a: unknown[]): void {
  if (debug) console.debug("[carnet]", ...a);
}
