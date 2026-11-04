// Carnet · identifiants et horodatages. Sans dépendance : utilisable par le serveur et l'interface.
//
// Fuseau : les dates « locales » (identifiants, date du jour d'une tâche cochée, `cree` d'une capture) sont calculées dans
// un fuseau EXPLICITE (Europe/Paris par défaut, CARNET_FUSEAU côté serveur), jamais dans celui du processus (UTC en
// conteneur).

export const FUSEAU_DEFAUT = "Europe/Paris";

/** Alphabet base32 de Crockford en minuscules (sans i, l, o, u : pas de confusion à la lecture). */
const B32 = "0123456789abcdefghjkmnpqrstvwxyz";

interface Parties { a: string; mo: string; j: string; h: string; mi: string; s: string; decalageMin: number }

const formats = new Map<string, Intl.DateTimeFormat>();

/** Fuseau IANA reconnu par le moteur (« Europe/Paris ») ? */
export function fuseauValide(fuseau: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: fuseau });
    return true;
  } catch {
    return false;
  }
}

function parties(d: Date, fuseau: string): Parties {
  let f = formats.get(fuseau);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: fuseau, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
    });
    formats.set(fuseau, f);
  }
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const local = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  const decalageMin = Math.round((local - Math.floor(d.getTime() / 1000) * 1000) / 60000);
  return { a: p.year.padStart(4, "0"), mo: p.month, j: p.day, h: p.hour, mi: p.minute, s: p.second, decalageMin };
}

/** « 2026-10-11 » : date du jour dans le fuseau donné. */
export function dateDuJour(fuseau = FUSEAU_DEFAUT, d = new Date()): string {
  const p = parties(d, fuseau);
  return `${p.a}-${p.mo}-${p.j}`;
}

/** « 2026-10-11T08:12:03+02:00 » : horodatage ISO avec le décalage du fuseau donné. */
export function horodatageIso(d = new Date(), fuseau = FUSEAU_DEFAUT): string {
  const p = parties(d, fuseau);
  const signe = p.decalageMin < 0 ? "-" : "+";
  const abs = Math.abs(p.decalageMin);
  const dec = `${signe}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
  return `${p.a}-${p.mo}-${p.j}T${p.h}:${p.mi}:${p.s}${dec}`;
}

function alea(n: number): string {
  const octets = new Uint8Array(n);
  globalThis.crypto.getRandomValues(octets);
  let s = "";
  for (const o of octets) s += B32[o & 31];
  return s;
}

const RE_PREFIXE = /^[a-z][a-z0-9]{0,15}$/;
/** Forme d'un identifiant produit par nouvelIdentifiant (préfixe libre en minuscules). */
export const RE_IDENTIFIANT = /^[a-z][a-z0-9]{0,15}-\d{8}-\d{4}-[0-9a-hjkmnp-tv-z]{4}$/;

/**
 * `cap-20261011-0812-k3f9` : préfixe (minuscules, ex. « cap », « dec », « att »), date et heure locales (fuseau donné),
 * 4 caractères aléatoires base32 (20 bits). Unicité NON garantie à elle seule : l'appelant crée ses fichiers en mode
 * exclusif (Ecrivain.creerUnique) et, pour un identifiant de demande, vérifie qu'il n'existe pas déjà.
 */
export function nouvelIdentifiant(prefixe: string, fuseau = FUSEAU_DEFAUT, d = new Date()): string {
  if (!RE_PREFIXE.test(prefixe)) throw new Error(`nouvelIdentifiant : préfixe invalide ${JSON.stringify(prefixe)}`);
  const p = parties(d, fuseau);
  return `${prefixe}-${p.a}${p.mo}${p.j}-${p.h}${p.mi}-${alea(4)}`;
}
