// Carnet · bases : affichage des valeurs (dates en Europe/Paris, nombres à la française) et lecture des saisies.
import { FUSEAU_DEFAUT, lireDate, typeDeValeur } from "../../../shared/bases.ts";
import type { TypePropriete, ValeurBrute, ValeurSaisie } from "../../../shared/bases.ts";

const fmtJour = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", timeZone: FUSEAU_DEFAUT });
const fmtInstant = new Intl.DateTimeFormat("fr-FR", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: FUSEAU_DEFAUT });
const fmtNombre = new Intl.NumberFormat("fr-FR", { maximumFractionDigits: 10 });

export function texteDate(v: string): string {
  const d = lireDate(v);
  if (!d) return v;
  return (d.jour ? fmtJour : fmtInstant).format(new Date(d.ms));
}

export function texteInstant(ms: number): string {
  return fmtInstant.format(new Date(ms));
}

export function texteNombre(n: number): string {
  return fmtNombre.format(n);
}

/** Type à utiliser pour afficher / modifier : le type déclaré, sinon celui de la valeur elle-même. */
export function typeEffectif(declare: TypePropriete | null, v: ValeurBrute | undefined): TypePropriete {
  return declare ?? typeDeValeur(v) ?? "texte";
}

/** Texte brut d'une valeur pour un champ de saisie. */
export function versSaisie(type: TypePropriete, v: ValeurBrute | undefined): string {
  if (v === undefined || v === null) return "";
  if (Array.isArray(v)) return v.map((x) => (x === null ? "" : String(x))).join(", ");
  if (type === "nombre" && typeof v === "number") return String(v).replace(".", ",");
  return String(v);
}

/** Lit une saisie selon le type. `null` = vider. Erreur (message) si la saisie ne correspond pas au type. */
export function lireSaisie(type: TypePropriete, texte: string): { ok: true; valeur: ValeurSaisie } | { ok: false; message: string } {
  const t = texte.trim();
  switch (type) {
    case "nombre": {
      if (!t) return { ok: true, valeur: null };
      const propre = t.replace(/[\s  ]/g, "").replace(",", ".");
      if (!/^[-+]?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(propre)) return { ok: false, message: `« ${t} » n'est pas un nombre (ex. 12 ou 3,5).` };
      const n = Number(propre);
      return Number.isFinite(n) ? { ok: true, valeur: n } : { ok: false, message: "Nombre trop grand." };
    }
    case "date":
      if (!t) return { ok: true, valeur: null };
      return lireDate(t) ? { ok: true, valeur: t } : { ok: false, message: `« ${t} » n'est pas une date valide (AAAA-MM-JJ).` };
    case "liste":
      if (!t) return { ok: true, valeur: [] };
      return { ok: true, valeur: t.split(",").map((x) => x.trim()).filter(Boolean) };
    case "case":
      return { ok: true, valeur: t === "true" };
    default:
      // texte : la saisie est gardée telle quelle (« 00123 » reste une chaîne)
      return { ok: true, valeur: texte };
  }
}
