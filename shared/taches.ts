// Carnet · tâches au format Obsidian Tasks (format « emoji », sous-ensemble vérifié) : analyse et modification d'UNE ligne.
// Voir docs/architecture.md (section « Écritures »).
//
// Lecture comme Obsidian Tasks : les marqueurs sont lus DEPUIS LA FIN de la ligne (identifiant de bloc `^id`, puis
// marqueurs et étiquettes `#x` dans n'importe quel ordre) ; dès qu'un morceau n'est pas un marqueur, le reste est le
// texte de la tâche. Un emoji de marqueur resté dans le texte n'est PAS interprété : il est signalé (anomalie).
// Écriture : seuls les marqueurs demandés changent, tout le reste est conservé à l'octet. Jamais de « réparation » :
// marqueur en double ou invalide = refus ciblé (ErreurFormat, 422) pour CE marqueur ; les autres restent modifiables.
// Les blocs de code : à exclure par l'appelant (marquerCode ci-dessous, ou listerTaches qui le fait).
import { sansBlancsFinaux } from "./page.ts";
import { dateValide, ErreurFormat } from "./proprietes.ts";

export type Priorite = "plus-haute" | "haute" | "moyenne" | "basse" | "plus-basse";

export type TypeMarqueur =
  | "echeance" | "prevue" | "debut" | "creee" | "faite" | "annulee" | "priorite" | "recurrence"
  | "identifiant" | "depend" | "achevement" | "etiquette";

export interface MarqueurTache {
  type: TypeMarqueur;
  /** Emoji tel qu'écrit (sélecteur de variante compris), ou "" pour une étiquette. */
  emoji: string;
  /** Valeur brute (date, texte de récurrence, étiquette…), "" pour une priorité. */
  valeur: string;
  /** Décalages dans la ligne (sans le « \r » final) : début de l'espace qui précède, début de l'emoji, fin. */
  debutEspace: number;
  debut: number;
  fin: number;
}

export interface TacheAnalysee {
  /** Puce et espaces jusqu'au « [ » : « - », « * », « 1. »… avec l'indentation. */
  prefixe: string;
  /** Caractère entre crochets : « » (à faire), « x »/« X » (faite) ou statut personnalisé (« / », « - »…), conservé. */
  coche: " " | "x" | "X" | string;
  /** Texte sans les marqueurs reconnus (étiquettes de fin comprises). */
  texte: string;
  echeance?: string;
  prevue?: string;
  debut?: string;
  creee?: string;
  faite?: string;
  annulee?: string;
  priorite?: Priorite;
  /** Texte brut après 🔁, conservé tel quel (non exécuté en vague 1). */
  recurrence?: string;
  /** Identifiant de bloc final (`^t1` → « t1 »). */
  blocId?: string;
  /** Marqueurs reconnus, de gauche à droite. */
  marqueurs: MarqueurTache[];
  /** Anomalies lisibles (« date invalide après 📅 : 2026-13-45 ») : affichées, jamais « réparées ». */
  anomalies: string[];
}

// Emoji (format « Tasks Emoji Format »), variantes acceptées par Tasks comprises.
const DATES: Record<string, "echeance" | "prevue" | "debut" | "creee" | "faite" | "annulee"> = {
  "📅": "echeance", "📆": "echeance", "🗓": "echeance",
  "⏳": "prevue", "⌛": "prevue",
  "🛫": "debut",
  "➕": "creee",
  "✅": "faite",
  "❌": "annulee",
};
const PRIORITES: Record<string, Priorite> = { "🔺": "plus-haute", "⏫": "haute", "🔼": "moyenne", "🔽": "basse", "⏬": "plus-basse" };
const EMOJI_PRIORITE: Record<Priorite, string> = { "plus-haute": "🔺", haute: "⏫", moyenne: "🔼", basse: "🔽", "plus-basse": "⏬" };
/** Emoji écrit par Carnet pour un ajout. */
const EMOJI_DATE = { echeance: "📅", prevue: "⏳", debut: "🛫", creee: "➕", faite: "✅", annulee: "❌" } as const;
/** Tous les emoji de marqueur connus (pour signaler ceux restés dans le texte). */
const TOUS = [...Object.keys(DATES), ...Object.keys(PRIORITES), "🔁", "🆔", "⛔", "🏁"];

const VS = "\u{FE0F}";
const ALT_DATES = Object.keys(DATES).join("|");
const ALT_PRIO = Object.keys(PRIORITES).join("|");
const RE_FIN_DATE = new RegExp(`((?<![ \\t])[ \\t]*)(${ALT_DATES})${VS}?[ \\t]*(\\d{4}-\\d{2}-\\d{2})$`, "u");
const RE_FIN_PRIO = new RegExp(`((?<![ \\t])[ \\t]*)(${ALT_PRIO})${VS}?$`, "u");
const RE_FIN_RECURRENCE = new RegExp(`((?<![ \\t])[ \\t]*)(🔁)${VS}?[ \\t]*([a-zA-Z0-9, !]+)$`, "u");
const RE_FIN_ID = new RegExp(`((?<![ \\t])[ \\t]*)(🆔)${VS}?[ \\t]*([a-zA-Z0-9_-]+)$`, "u");
const RE_FIN_DEPEND = new RegExp(`((?<![ \\t])[ \\t]*)(⛔)${VS}?[ \\t]*([a-zA-Z0-9_-]+(?:[ \\t]*,[ \\t]*[a-zA-Z0-9_-]+)*)$`, "u");
const RE_FIN_ACHEVEMENT = new RegExp(`((?<![ \\t])[ \\t]*)(🏁)${VS}?[ \\t]*([a-zA-Z]+)$`, "u");
// (?<![ \t]) : une correspondance ne commence qu'au début d'une suite de blancs, là où la plus à gauche commençait
// déjà ; même résultat que sans, mais en temps linéaire (sinon quadratique sur une longue suite d'espaces).
const RE_FIN_ETIQUETTE = /(^|(?<![ \t])[ \t]+)(#[^\s#]+)$/u;
const RE_BLOC = /((?<![ \t])[ \t]+|^)\^([A-Za-z0-9-]+)$/;

/** Ligne de tâche : puce, crochets avec UN caractère (statut), puis espace ou fin de ligne. */
export const RE_LIGNE_TACHE = /^([ \t]*(?:[-*+]|\d{1,9}[.)])[ \t]+)\[([^\]\r\n])\](?=[ \t]|$)(.*)$/u;

function enlever(ligne: string): { l: string; cr: string } {
  return ligne.endsWith("\r") ? { l: ligne.slice(0, -1), cr: "\r" } : { l: ligne, cr: "" };
}

/** Analyse une ligne de tâche (null si ce n'est pas une tâche). La ligne ne doit pas être dans un bloc de code. */
export function analyserTache(ligne: string): TacheAnalysee | null {
  const { l } = enlever(ligne);
  const m = RE_LIGNE_TACHE.exec(l);
  if (!m) return null;
  const prefixe = m[1];
  const coche = m[2];
  const debutReste = prefixe.length + 3; // « [c] »
  const reste = m[3];
  const marqueurs: MarqueurTache[] = [];
  const anomalies: string[] = [];
  let fin = sansBlancsFinaux(reste).length;
  let blocId: string | undefined;
  const b = RE_BLOC.exec(reste.slice(0, fin));
  if (b) {
    blocId = b[2];
    fin = b.index;
  }
  // marqueurs depuis la fin
  for (let garde = 0; garde < 200; garde++) {
    const s = reste.slice(0, fin);
    let x: RegExpExecArray | null;
    let trouve: Omit<MarqueurTache, "debutEspace" | "debut" | "fin"> | null = null;
    if ((x = RE_FIN_DATE.exec(s))) trouve = { type: DATES[x[2]], emoji: x[2], valeur: x[3] };
    else if ((x = RE_FIN_PRIO.exec(s))) trouve = { type: "priorite", emoji: x[2], valeur: "" };
    else if ((x = RE_FIN_RECURRENCE.exec(s))) trouve = { type: "recurrence", emoji: x[2], valeur: x[3] };
    else if ((x = RE_FIN_ID.exec(s))) trouve = { type: "identifiant", emoji: x[2], valeur: x[3] };
    else if ((x = RE_FIN_DEPEND.exec(s))) trouve = { type: "depend", emoji: x[2], valeur: x[3] };
    else if ((x = RE_FIN_ACHEVEMENT.exec(s))) trouve = { type: "achevement", emoji: x[2], valeur: x[3] };
    else if ((x = RE_FIN_ETIQUETTE.exec(s)) && x.index + x[1].length > 0) trouve = { type: "etiquette", emoji: "", valeur: x[2] };
    if (!x || !trouve) break;
    const debutEspace = x.index;
    const debut = x.index + x[1].length;
    // emoji collé au texte sans espace : accepté par Tasks, gardé tel quel
    marqueurs.unshift({ ...trouve, debutEspace: debutReste + debutEspace, debut: debutReste + debut, fin: debutReste + fin });
    fin = debutEspace;
    if (trouve.type === "etiquette" && fin === 0) break;
  }
  const description = reste.slice(0, fin);
  const t: TacheAnalysee = { prefixe, coche, texte: "", marqueurs, anomalies };
  if (blocId !== undefined) t.blocId = blocId;
  const etiquettes = marqueurs.filter((k) => k.type === "etiquette").map((k) => k.valeur);
  t.texte = [description.trim(), ...etiquettes].filter(Boolean).join(" ");
  // champs : un marqueur en double = ambigu (aucune valeur retenue) ; une date invalide n'est jamais retenue
  const parType = new Map<TypeMarqueur, MarqueurTache[]>();
  for (const k of marqueurs) {
    if (k.type === "etiquette") continue;
    parType.set(k.type, [...(parType.get(k.type) ?? []), k]);
  }
  for (const [type, liste] of parType) {
    const emoji = liste[0].emoji;
    if (liste.length > 1) {
      anomalies.push(`${emoji} en double (${liste.length} fois) : valeur ambiguë, non modifiable par Carnet`);
      if (type in EMOJI_DATE) for (const k of liste) if (!dateValide(k.valeur)) anomalies.push(`date invalide après ${k.emoji} : ${k.valeur}`);
      continue;
    }
    const k = liste[0];
    if (type in EMOJI_DATE) {
      if (!dateValide(k.valeur)) {
        anomalies.push(`date invalide après ${emoji} : ${k.valeur}`);
        continue;
      }
      (t as unknown as Record<string, string>)[type] = k.valeur;
    } else if (type === "priorite") {
      t.priorite = PRIORITES[k.emoji.replace(VS, "")];
    } else if (type === "recurrence") {
      t.recurrence = k.valeur;
    }
  }
  // emoji de marqueur restés dans le texte : non reconnus
  for (const e of TOUS) {
    if (description.includes(e)) anomalies.push(`« ${e} » dans le texte : non reconnu (Obsidian Tasks ne lit les marqueurs qu'en fin de ligne, suivis d'une valeur valide)`);
  }
  return t;
}

export interface ChangementsTache {
  coche: boolean;
  echeance: string | null;
  priorite: Priorite | null;
  faite: string | null;
}

/**
 * Modifie une ligne de tâche : seuls les marqueurs demandés changent, le reste est conservé à l'octet.
 * - `coche: true` met « x » (si la tâche n'est pas déjà faite) ; `coche: false` met « » (même depuis un statut perso) ;
 * - `faite: "AAAA-MM-JJ"` pose la date ✅ (date FOURNIE par l'appelant : le serveur calcule « aujourd'hui » en
 *   Europe/Paris), `faite: null` retire ✅ ; rien n'est retiré implicitement (décocher = `{coche: false, faite: null}`) ;
 * - idempotent : `coche: true` sur une tâche déjà faite ne change ni le statut ni la date ✅ existante ;
 * - ajout d'un marqueur absent : en fin de ligne, AVANT l'identifiant de bloc final `^id`, ordre Tasks entre ajouts ;
 * - marqueur ciblé en double, invalide, ou présent non reconnu dans le texte : ErreurFormat 422 (rien n'est modifié).
 */
export function modifierTache(ligne: string, changements: Partial<ChangementsTache>): string {
  const { l, cr } = enlever(ligne);
  const t = analyserTache(l);
  if (!t) throw new ErreurFormat("Cette ligne n'est pas une tâche.", "pas_une_tache");
  const edits: { debut: number; fin: number; texte: string }[] = [];
  const ajouts: string[] = [];
  const dejaFaite = t.coche === "x" || t.coche === "X";

  if (changements.coche !== undefined) {
    const pos = t.prefixe.length + 1;
    if (changements.coche && !dejaFaite) edits.push({ debut: pos, fin: pos + t.coche.length, texte: "x" });
    if (!changements.coche && t.coche !== " ") edits.push({ debut: pos, fin: pos + t.coche.length, texte: " " });
  }

  const cible = (type: TypeMarqueur, nom: string): MarqueurTache | null => {
    const liste = t.marqueurs.filter((k) => k.type === type);
    if (liste.length > 1) throw new ErreurFormat(`Modification refusée : ${liste[0].emoji} est en double sur cette ligne (${nom} ambiguë).`, "marqueur_en_double");
    const emojis = type === "priorite" ? Object.keys(PRIORITES) : Object.entries(DATES).filter(([, v]) => v === type).map(([e]) => e);
    const description = l.slice(t.prefixe.length + 3, liste[0]?.debutEspace ?? t.marqueurs[0]?.debutEspace ?? l.length);
    if (emojis.some((e) => description.includes(e))) {
      throw new ErreurFormat(`Modification refusée : un marqueur de ${nom} non reconnu est déjà dans le texte de la tâche.`, "marqueur_ambigu");
    }
    if (liste[0] && type !== "priorite" && !dateValide(liste[0].valeur)) {
      throw new ErreurFormat(`Modification refusée : la date après ${liste[0].emoji} est invalide (${liste[0].valeur}) ; corrige-la dans le texte.`, "marqueur_invalide");
    }
    return liste[0] ?? null;
  };
  const retirer = (k: MarqueurTache) => edits.push({ debut: k.debutEspace, fin: k.fin, texte: "" });

  if (changements.priorite !== undefined) {
    const k = cible("priorite", "priorité");
    if (changements.priorite === null) { if (k) retirer(k); } else {
      const e = EMOJI_PRIORITE[changements.priorite];
      if (!e) throw new ErreurFormat("Priorité inconnue.", "valeur_invalide");
      if (k) { if (k.emoji.replace(VS, "") !== e) edits.push({ debut: k.debut, fin: k.fin, texte: e }); } else ajouts.push(e);
    }
  }
  const poserDate = (type: "echeance" | "faite", valeur: string | null | undefined, nom: string) => {
    if (valeur === undefined) return;
    if (valeur !== null && !dateValide(valeur)) throw new ErreurFormat(`Date invalide pour ${nom} : ${String(valeur).slice(0, 40)} (AAAA-MM-JJ attendu).`, "valeur_invalide");
    const k = cible(type, nom);
    if (valeur === null) { if (k) retirer(k); return; }
    if (k) { if (k.valeur !== valeur) edits.push({ debut: k.fin - k.valeur.length, fin: k.fin, texte: valeur }); } else ajouts.push(`${EMOJI_DATE[type]} ${valeur}`);
  };
  poserDate("echeance", changements.echeance, "l'échéance");
  // idempotence : cocher une tâche déjà faite ne touche pas à sa date ✅
  if (!(changements.coche === true && dejaFaite)) poserDate("faite", changements.faite, "la date de clôture");

  // insertion des ajouts : avant « ^id » final, sinon après le dernier caractère non blanc
  if (ajouts.length) {
    let pos = sansBlancsFinaux(l).length;
    if (t.blocId !== undefined) {
      const b = RE_BLOC.exec(l.slice(0, pos));
      if (b) pos = b.index;
    }
    edits.push({ debut: pos, fin: pos, texte: ajouts.map((x) => " " + x).join("") });
  }
  edits.sort((a, b) => b.debut - a.debut || b.fin - a.fin);
  let r = l;
  for (const e of edits) r = r.slice(0, e.debut) + e.texte + r.slice(e.fin);
  return r + cr;
}

// ---------------------------------------------------------------------------------------------
// Blocs de code et parcours d'une page
// ---------------------------------------------------------------------------------------------

const RE_OUVERTURE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_FERMETURE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** Pour chaque ligne : true si elle appartient à un bloc de code clôturé (``` ou ~~~), délimiteurs compris. */
export function marquerCode(lignes: string[]): boolean[] {
  const code = new Array<boolean>(lignes.length).fill(false);
  let ouvert: { c: string; n: number } | null = null;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i].endsWith("\r") ? lignes[i].slice(0, -1) : lignes[i];
    if (ouvert) {
      code[i] = true;
      const m = RE_FERMETURE.exec(l);
      if (m && m[1][0] === ouvert.c && m[1].length >= ouvert.n) ouvert = null;
      continue;
    }
    const m = RE_OUVERTURE.exec(l);
    if (m && !(m[1][0] === "`" && m[2].includes("`"))) {
      ouvert = { c: m[1][0], n: m[1].length };
      code[i] = true;
    }
  }
  return code;
}

/** Tâches d'une page, hors blocs de code : numéro de ligne (0 = première ligne du fichier), texte brut, analyse. */
export function listerTaches(contenu: string): { ligne: number; brute: string; tache: TacheAnalysee }[] {
  const lignes = contenu.split("\n");
  const code = marquerCode(lignes);
  const res: { ligne: number; brute: string; tache: TacheAnalysee }[] = [];
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const t = analyserTache(lignes[i]);
    if (t) res.push({ ligne: i, brute: lignes[i].replace(/\r$/, ""), tache: t });
  }
  return res;
}
