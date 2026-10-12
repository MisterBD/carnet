// Carnet · demandes de décision : format, proposition délimitée, entrée de l'empreinte (méthode documentée),
// enregistrements « ## Décision » écrits par Carnet. Partagé serveur + interface, sans dépendance (le hachage SHA-256
// est fait par le serveur). Format complet et exemples : docs/format-agents.md.
//
// Une demande = une page dont le frontmatter porte `type: decision`, `id`, `statut`, `demandee_par` (et `echeance`,
// `cree`, `engage` facultatifs), avec UNE section `## Proposition` (titre ATX de niveau 2, exactement ce mot). La
// section va de la ligne qui suit ce titre jusqu'au prochain titre de niveau 1 ou 2 hors bloc de code, ou à la fin.
// Seul ce qui est écrit dans cette section (et les propriétés listées dans `engage`) est approuvé.

import { sansBlancsFinaux } from "./page.ts";

export const TYPE_DECISION = "decision";
export const STATUT_ATTENTE = "en attente";
export type ResultatDecision = "approuvée" | "à corriger" | "refusée";
export const RESULTATS: readonly ResultatDecision[] = ["approuvée", "à corriger", "refusée"];
/** Statut écrit dans le frontmatter après chaque résultat. */
export const STATUT_DE: Record<ResultatDecision, string> = { "approuvée": "approuvée", "à corriger": "à corriger", "refusée": "refusée" };
/** Version de la méthode d'empreinte (préfixe de l'entrée hachée). */
export const METHODE_EMPREINTE = "carnet-proposition-v1";
/** Portée canonique (attestation) et sa traduction lisible (enregistrement Markdown). */
export const PORTEE = "proposition-figee-v1";
/**
 * Portée exacte d'une attestation (signée par Carnet, et par la clé d'accès quand il y en a une) : la portée canonique,
 * l'identifiant de la décision et l'empreinte du commentaire (« aucun » s'il est vide). Elle lie l'attestation à UN
 * enregistrement « ## Décision » précis : une copie modifiée (autre commentaire, autre identifiant) n'est pas attestée.
 */
export function porteeDe(decision: string, empreinteCommentaire: string | null): string {
  return `${PORTEE} decision=${decision} commentaire=${empreinteCommentaire ?? "aucun"}`;
}
/**
 * Chaînage du journal des attestations (lot 3) : la portée enregistrée se termine par « precedente=<maillon> », le
 * maillon étant l'empreinte (`sha256:` du JSON canonique, signature comprise) de l'attestation valide qui la précède
 * dans le journal, ou « aucune ». Une ligne supprimée AU MILIEU du journal casse la chaîne et se voit ; une troncature
 * de la FIN du journal ne se voit pas.
 */
export function porteeChainee(base: string, maillon: string): string {
  return `${base} precedente=${maillon}`;
}
/** Portée sans le maillon de chaînage (ce que l'appareil signe, et ce qui lie l'enregistrement « ## Décision »). */
export function porteeBase(portee: string): string {
  return portee.replace(/ precedente=\S+$/, "");
}
/** Maillon déclaré par une portée chaînée, ou null (attestation non chaînée). */
export function maillonDeclare(portee: string): string | null {
  const m = / precedente=(\S+)$/.exec(portee);
  return m ? m[1] : null;
}
/** Commentaire tel qu'il est écrit, relu et haché : fins de ligne LF, espaces de début et de fin retirés. */
export function normaliserCommentaire(c: string): string {
  return c.replace(/\r\n?/g, "\n").trim();
}
export const PORTEE_TEXTE = "la proposition figée ci-dessous et les propriétés engageantes qu'elle liste, rien d'autre (ni liens externes, ni pages liées, ni annexes non recopiées)";

export interface Titre { ligne: number; niveau: number; texte: string }

const RE_OUVERTURE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const RE_FERMETURE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const RE_ATX = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/;

/** Lignes du contenu (séparateur « \n », un « \r » final éventuel retiré pour l'analyse). */
function lignesDe(contenu: string): string[] {
  return contenu.split("\n").map((l) => (l.endsWith("\r") ? l.slice(0, -1) : l));
}

/** Lignes situées dans un bloc de code clôturé (``` ou ~~~). */
export function lignesDeCode(lignes: string[]): boolean[] {
  const code = new Array<boolean>(lignes.length).fill(false);
  let ouvert: { c: string; n: number } | null = null;
  for (let i = 0; i < lignes.length; i++) {
    const l = lignes[i];
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

/** Titres ATX (« ## Titre ») hors blocs de code. Les titres soulignés (setext) ne comptent pas. */
export function titres(contenu: string): Titre[] {
  const lignes = lignesDe(contenu);
  const code = lignesDeCode(lignes);
  const res: Titre[] = [];
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const m = RE_ATX.exec(lignes[i]);
    if (m) res.push({ ligne: i, niveau: m[1].length, texte: (m[2] ?? "").trim() });
  }
  return res;
}

export interface Section { ligneTitre: number; debut: number; fin: number; brut: string }

/** Sections de niveau 2 portant exactement ce titre (corps brut, lignes séparées par « \n »). */
export function sections(contenu: string, nom: string): Section[] {
  const lignesBrutes = contenu.split("\n");
  const ts = titres(contenu);
  const res: Section[] = [];
  for (let k = 0; k < ts.length; k++) {
    const t = ts[k];
    if (t.niveau !== 2 || t.texte.normalize("NFC") !== nom) continue;
    let fin = lignesBrutes.length;
    for (let j = k + 1; j < ts.length; j++) if (ts[j].niveau <= 2) { fin = ts[j].ligne; break; }
    res.push({ ligneTitre: t.ligne, debut: t.ligne + 1, fin, brut: lignesBrutes.slice(t.ligne + 1, fin).join("\n") });
  }
  return res;
}

/**
 * Normalisation de la proposition avant hachage : forme Unicode NFC ; fins de ligne CRLF ou CR -> LF ; espaces et
 * tabulations de fin de ligne retirés ; lignes vides de début et de fin retirées. Rien d'autre (la casse, les espaces
 * intérieurs, la ponctuation et la syntaxe Markdown comptent).
 */
export function normaliserProposition(brut: string): string {
  const lignes = brut.normalize("NFC").replace(/\r\n?/g, "\n").split("\n").map(sansBlancsFinaux);
  let a = 0;
  let b = lignes.length;
  while (a < b && lignes[a] === "") a++;
  while (b > a && lignes[b - 1] === "") b--;
  return lignes.slice(a, b).join("\n");
}

/** JSON canonique (clés d'objet triées), pour les valeurs des propriétés engageantes. */
export function jsonCanonique(v: unknown): string {
  if (v === undefined) return "null";
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) return "null";
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return "[" + v.map(jsonCanonique).join(",") + "]";
  if (v instanceof Date) return JSON.stringify(Number.isNaN(v.getTime()) ? null : v.toISOString());
  const o = v as Record<string, unknown>;
  return "{" + Object.keys(o).sort().map((k) => JSON.stringify(k) + ":" + jsonCanonique(o[k])).join(",") + "}";
}

export interface ProprieteEngageante { cle: string; presente: boolean; valeur: unknown }

/** Ligne « cle: valeur » d'une propriété engageante, telle qu'elle entre dans l'empreinte et dans la copie figée. */
export function ligneEngageante(p: ProprieteEngageante): string {
  return `${p.cle}: ${p.presente ? jsonCanonique(p.valeur) : "(absente)"}`;
}

/**
 * Texte exact haché (SHA-256, UTF-8) pour l'empreinte « sha256:<hex> » :
 *   "carnet-proposition-v1\n" + proposition normalisée
 *   + (s'il y a des propriétés engageantes) "\n\n" + une ligne « cle: <JSON canonique> » par propriété, dans l'ordre
 *     de la liste `engage`, « cle: (absente) » si la propriété manque.
 */
export function entreeEmpreinte(texteNormalise: string, engage: ProprieteEngageante[]): string {
  return METHODE_EMPREINTE + "\n" + texteNormalise + (engage.length ? "\n\n" + engage.map(ligneEngageante).join("\n") : "");
}

// ---------------------------------------------------------------------------------------------
// Analyse d'une demande (frontmatter déjà lu par l'appelant)
// ---------------------------------------------------------------------------------------------

export interface Demande {
  estDecision: boolean;
  id: string | null;
  statut: string | null;
  demandeePar: string | null;
  echeance: string | null;
  cree: string | null;
  engage: ProprieteEngageante[];
  /** Proposition normalisée (ce qui est haché), ou null si absente / ambiguë / vide. */
  proposition: string | null;
  /** Entrée exacte de l'empreinte (à hacher par le serveur), ou null. */
  entree: string | null;
  /** Ce qui empêche toute décision (pas de proposition, plusieurs, vide, identifiant manquant…). */
  bloquants: string[];
  /** Rubriques attendues dans la proposition mais introuvables (simple avertissement). */
  manques: string[];
  /**
   * K10-04 (finale V3) : rubriques INDISPENSABLES à une approbation (« objet », « action demandée ») présentes mais
   * SANS contenu (« - Objet : » laissé vide par le modèle). Tant qu'il en reste, on ne peut pas APPROUVER (422) ; « à
   * corriger » et « refusée » restent possibles. Une rubrique absente reste un simple avertissement (`manques`, lot 3 :
   * une proposition en texte libre s'approuve). L'empreinte et le contrat d'attestation ne changent pas.
   */
  vides: string[];
}

function chaineOuNull(v: unknown): string | null {
  if (typeof v === "string") return v.trim() || null;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  return null;
}

function plierSimple(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Rubriques qu'une proposition doit préciser (recherchées en début de ligne, sans accents ni casse). */
export const RUBRIQUES: Array<[string, RegExp]> = [
  ["objet", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?objet\b/],
  ["action demandée", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?action\b/],
  ["périmètre", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?perimetre\b/],
  ["exclusions", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?exclusions?\b/],
  ["conditions", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?conditions?\b/],
  ["annexes", /^(?:[-*+]\s+|#{3,6}\s+)?(?:\*\*|__)?annexes?\b/],
];

/** Rubriques qu'une approbation exige remplies, avec ce qui suit leur nom (texte plié : sans accents, minuscules). */
export const RUBRIQUES_REQUISES: Array<[string, RegExp]> = [
  ["objet", /^(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*|__)?objet\b/],
  ["action demandée", /^(?:[-*+]\s+|#{1,6}\s+)?(?:\*\*|__)?action(?:\s+demandee)?\b/],
];

/** Ligne qui n'est qu'un intitulé de rubrique (« - Périmètre : », « ### Exclusions ») ou un titre : fin d'une valeur. */
// Blancs « atomiques » ((?=(\s*))\N : pris en entier, jamais rendus) : chacun est suivi d'un élément qui ne commence
// pas par un blanc, donc même résultat que \s*, mais sans l'explosion combinatoire sur une longue suite d'espaces.
const RE_INTITULE = /^(?:#{1,6}\s|(?:[-*+](?=(\s+))\1)?(?:\*\*|__)?[\p{L}][\p{L}' -]{1,40}(?:\*\*|__)?(?=(\s*))\2(?:\*\*|__)?(?=(\s*))\3[:：](?=(\s*))\4(?:\*\*|__)?(?=(\s*))\5$)/u;

/**
 * Rubriques requises (objet, action) présentes mais VIDES. Valeur = texte après l'intitulé sur la même ligne (« - Objet :
 * refonte du site »), sinon les lignes suivantes jusqu'à la prochaine rubrique (« ### Objet » puis un paragraphe).
 * Absente : pas « vide » (avertissement `manques` seulement).
 */
export function rubriquesVides(proposition: string | null): string[] {
  if (!proposition) return [];
  const lignes = proposition.split("\n").map((l) => plierSimple(l.trim()));
  const vides: string[] = [];
  for (const [nom, re] of RUBRIQUES_REQUISES) {
    const i = lignes.findIndex((l) => re.test(l));
    if (i < 0) continue;
    const reste = lignes[i].replace(re, "").replace(/^(?:\*\*|__)?\s*(?:\*\*|__)?\s*[:：—–-]?\s*(?:\*\*|__)?/, "").replace(/[*_\s]/g, "");
    if (/[\p{L}\p{N}]/u.test(reste)) continue;
    let rempli = false;
    for (let k = i + 1; k < lignes.length; k++) {
      const l = lignes[k];
      if (!l) continue;
      if (RE_INTITULE.test(l) || RUBRIQUES.some(([, r]) => r.test(l))) break;
      if (/[\p{L}\p{N}]/u.test(l)) { rempli = true; break; }
    }
    if (!rempli) vides.push(nom);
  }
  return vides;
}

export function analyserDemande(contenu: string, fm: Record<string, unknown> | null): Demande {
  const f = fm ?? {};
  const estDecision = chaineOuNull(f.type) === TYPE_DECISION;
  const bloquants: string[] = [];
  const id = chaineOuNull(f.id);
  if (estDecision && !id) bloquants.push("La demande n'a pas d'identifiant (propriété « id »).");
  if (id && !/^[\p{L}\p{N}][\p{L}\p{N}._:-]{0,99}$/u.test(id)) bloquants.push("Identifiant de demande invalide (lettres, chiffres, « . _ : - », 100 caractères au plus).");
  const engage: ProprieteEngageante[] = [];
  if (f.engage !== undefined && f.engage !== null) {
    const l = Array.isArray(f.engage) ? f.engage : typeof f.engage === "string" ? [f.engage] : null;
    if (!l || !l.every((x) => typeof x === "string" && /^[A-Za-z_][\w-]{0,63}$/.test(x))) {
      bloquants.push("« engage » doit être une liste de noms de propriétés du frontmatter.");
    } else {
      for (const cle of l as string[]) engage.push({ cle, presente: Object.prototype.hasOwnProperty.call(f, cle), valeur: f[cle] });
    }
  }
  const secs = sections(contenu, "Proposition");
  let proposition: string | null = null;
  if (secs.length === 0) bloquants.push("Section « ## Proposition » introuvable : rien à décider.");
  else if (secs.length > 1) bloquants.push(`${secs.length} sections « ## Proposition » : la demande est ambiguë.`);
  else {
    proposition = normaliserProposition(secs[0].brut);
    if (!proposition.trim()) { bloquants.push("La proposition est vide."); proposition = null; }
  }
  const manques: string[] = [];
  if (proposition) {
    const lignes = proposition.split("\n").map((l) => plierSimple(l.trim()));
    for (const [nom, re] of RUBRIQUES) if (!lignes.some((l) => re.test(l))) manques.push(nom);
  }
  return {
    estDecision, id, statut: chaineOuNull(f.statut), demandeePar: chaineOuNull(f.demandee_par), echeance: chaineOuNull(f.echeance),
    cree: chaineOuNull(f.cree), engage, proposition, entree: proposition !== null && !bloquants.length ? entreeEmpreinte(proposition, engage) : null,
    bloquants, manques, vides: rubriquesVides(proposition),
  };
}

// ---------------------------------------------------------------------------------------------
// Enregistrement « ## Décision » (écrit par Carnet, relu par tous)
// ---------------------------------------------------------------------------------------------

export type Geste = "cle-d-acces" | "identite-seule";

export interface Enregistrement {
  demande: string;
  decision: string;
  resultat: ResultatDecision;
  par: string;
  le: string;
  geste: Geste;
  empreinte: string;
  commentaire: string;
  /** Proposition normalisée telle qu'approuvée / refusée / renvoyée. */
  copie: string;
  engage: ProprieteEngageante[];
}

const LIBELLES: Array<[keyof Enregistrement, string]> = [
  ["demande", "Identifiant de demande"],
  ["decision", "Identifiant de décision"],
  ["resultat", "Résultat"],
  ["par", "Décidé par"],
  ["le", "Décidé le"],
  ["geste", "Geste"],
  ["empreinte", "Empreinte"],
];

const TEXTE_GESTE: Record<Geste, string> = {
  "cle-d-acces": "clé d'accès vérifiée par l'appareil (Face ID, Touch ID…)",
  "identite-seule": "identité du réseau seulement, geste non prouvé",
};

function citer(texte: string): string {
  return texte.split("\n").map((l) => (l === "" ? ">" : "> " + l)).join("\n");
}

function decliner(bloc: string): string {
  return bloc.split("\n").map((l) => l.replace(/^ {0,3}> ?/, "")).join("\n");
}

const TITRE_COPIE: Record<ResultatDecision, string> = {
  "approuvée": "Proposition approuvée : copie figée",
  "à corriger": "Proposition renvoyée pour correction : copie figée",
  "refusée": "Proposition refusée : copie figée",
};

/** Texte Markdown d'un enregistrement (commence par « ## Décision », finit par un saut de ligne). */
export function formaterEnregistrement(e: Enregistrement): string {
  const execution = e.resultat === "approuvée"
    ? "non autorisée par ce seul enregistrement (l'outil qui agit vérifie lui-même l'attestation au moment d'agir)"
    : "interdite : cette proposition n'est pas approuvée";
  const lignes = [
    "## Décision",
    "",
    `- Identifiant de demande : ${e.demande}`,
    `- Identifiant de décision : ${e.decision}`,
    `- Résultat : ${e.resultat}${e.resultat === "à corriger" ? " (ce n'est pas une approbation)" : ""}`,
    `- Décidé par : ${e.par}`,
    `- Décidé le : ${e.le}`,
    `- Geste : ${TEXTE_GESTE[e.geste]}`,
    `- Empreinte : ${e.empreinte}`,
    `- Portée : ${PORTEE_TEXTE}`,
    `- Exécution : ${execution}`,
    `- Attestation : signée par Carnet hors de l'espace, à vérifier au moment d'agir (GET /api/attestations?chemin=…)`,
    "",
    "### Commentaire",
    "",
    normaliserCommentaire(e.commentaire) ? citer(normaliserCommentaire(e.commentaire)) : "Aucun.",
    "",
    `### ${TITRE_COPIE[e.resultat]}`,
    "",
    citer(e.copie),
  ];
  if (e.engage.length) {
    lignes.push("", "Propriétés engageantes :", "", ...e.engage.map((p) => "    " + ligneEngageante(p)));
  }
  return lignes.join("\n") + "\n";
}

/** Ajoute un enregistrement à la fin d'une page (une ligne vide de séparation ; l'existant n'est jamais modifié). */
export function ajouterEnregistrement(contenu: string, enregistrement: string): string {
  const nl = contenu.includes("\r\n") ? "\r\n" : "\n";
  let base = contenu;
  if (base.length && !base.endsWith("\n")) base += nl;
  if (base.length && !/(\r?\n){2}$/.test(base)) base += nl;
  return base + (nl === "\r\n" ? enregistrement.replace(/\n/g, "\r\n") : enregistrement);
}

export interface EnregistrementLu {
  ligne: number;
  demande: string | null;
  decision: string | null;
  resultat: string | null;
  par: string | null;
  le: string | null;
  empreinte: string | null;
  geste: string | null;
  commentaire: string;
  copie: string;
}

/** Relit les sections « ## Décision » d'une page (écrites par Carnet ou… par n'importe qui : à vérifier). */
export function lireEnregistrements(contenu: string): EnregistrementLu[] {
  const res: EnregistrementLu[] = [];
  for (const s of sections(contenu, "Décision")) {
    const lignes = s.brut.replace(/\r/g, "").split("\n");
    const champs: Record<string, string> = {};
    let sous: string | null = null;
    const sousTextes: Record<string, string[]> = {};
    for (const l of lignes) {
      const t = lireSousTitre(l);
      if (t) { sous = t[1].trim(); sousTextes[sous] = []; continue; }
      if (sous !== null) { sousTextes[sous].push(l); continue; }
      const m = lireChampListe(l);
      if (m) champs[m[1].trim()] = m[2].trim();
    }
    const champ = (libelle: string) => champs[libelle] ?? null;
    const resultat = champ("Résultat");
    const commentaire = Object.entries(sousTextes).find(([k]) => k === "Commentaire")?.[1] ?? [];
    const copie = Object.entries(sousTextes).find(([k]) => /copie figée$/.test(k))?.[1] ?? [];
    const texteCopie = copie.join("\n");
    const finCitation = texteCopie.search(/\n\s*\nPropriétés engageantes :/);
    res.push({
      ligne: s.ligneTitre,
      demande: champ("Identifiant de demande"),
      decision: champ("Identifiant de décision"),
      resultat: resultat ? resultat.replace(/\s*\(.*\)$/, "") : null,
      par: champ("Décidé par"),
      le: champ("Décidé le"),
      empreinte: champ("Empreinte"),
      geste: champ("Geste"),
      commentaire: commentaire.some((l) => /^ {0,3}>/.test(l)) ? normaliserCommentaire(decliner(commentaire.filter((l) => /^ {0,3}>/.test(l)).join("\n"))) : "",
      copie: normaliserProposition(decliner(finCitation === -1 ? texteCopie : texteCopie.slice(0, finCitation))),
    });
  }
  return res;
}

// ---------------------------------------------------------------------------------------------
// Modèle d'une nouvelle demande (« /decision », « Nouvelle demande »)
// ---------------------------------------------------------------------------------------------

export function modeleDemande(o: { id: string; titre: string; demandeePar: string; cree: string }): string {
  const yaml = (v: string) => (/^[\p{L}\p{N}][\p{L}\p{N} @._'’-]*$/u.test(v) && !/^(true|false|null|yes|no|on|off|~)$/i.test(v) ? v : JSON.stringify(v));
  return [
    "---",
    `type: ${TYPE_DECISION}`,
    `id: ${o.id}`,
    `statut: ${STATUT_ATTENTE}`,
    `demandee_par: ${yaml(o.demandeePar)}`,
    `cree: ${JSON.stringify(o.cree)}`,
    "---",
    "",
    `# ${o.titre.replace(/\s*\n\s*/g, " ").trim()}`,
    "",
    "Contexte : pourquoi cette décision est demandée (ce paragraphe n'est pas approuvé).",
    "",
    "## Proposition",
    "",
    "- Objet : ",
    "- Action demandée : ",
    "- Périmètre : ",
    "- Exclusions : ",
    "- Conditions : ",
    "- Montants et dates engageants : ",
    "- Annexes : aucune",
    "",
  ].join("\n");
}

const FIN_DE_LIGNE = /[\n\r\u2028\u2029]/;
const BLANC_CHAMP = new Set([" ", "\t", "\u00a0", "\u202f"]);

/**
 * Équivalent linéaire de `/^###[ \t]+(.*?)[ \t#]*$/.exec(l)` (groupe 1 seulement) : l'expression paresseuse est
 * quadratique sur une longue suite d'espaces. `null` si la ligne ne correspond pas.
 */
export function lireSousTitre(l: string): [string, string] | null {
  if (!l.startsWith("###")) return null;
  let i = 3;
  while (i < l.length && (l[i] === " " || l[i] === "\t")) i++;
  if (i === 3) return null;
  if (FIN_DE_LIGNE.test(l)) return null; // « . » et « $ » (sans drapeau m) ne passent pas une fin de ligne
  let j = l.length;
  while (j > i && (l[j - 1] === " " || l[j - 1] === "\t" || l[j - 1] === "#")) j--;
  return [l, l.slice(i, j)];
}

/**
 * Équivalent linéaire de `/^[-*+][ \t]+([^:]+?)[ \t\u00a0\u202f]*:[ \t\u00a0\u202f]*(.*)$/.exec(l)` (groupes 1 et 2) :
 * l'expression est cubique sur une longue suite d'espaces sans deux-points. `null` si la ligne ne correspond pas.
 */
export function lireChampListe(l: string): [string, string, string] | null {
  if (l.length < 2 || !"-*+".includes(l[0]) || (l[1] !== " " && l[1] !== "\t")) return null;
  let w = 1;
  while (w < l.length && (l[w] === " " || l[w] === "\t")) w++;
  // début du libellé : juste après les blancs ; si un « : » (ou la fin) suit, le libellé emprunte le dernier blanc
  let debut = w;
  if (w >= l.length || l[w] === ":") {
    if (w - 1 < 2) return null;
    debut = w - 1;
  }
  const c = l.indexOf(":", debut);
  if (c === -1 || c === debut) return null;
  let finLibelle = c;
  while (finLibelle > debut + 1 && BLANC_CHAMP.has(l[finLibelle - 1])) finLibelle--;
  const libelle = l.slice(debut, finLibelle); // [^:] de l'expression accepte aussi les fins de ligne
  let v = c + 1;
  while (v < l.length && BLANC_CHAMP.has(l[v])) v++;
  const valeur = l.slice(v);
  if (FIN_DE_LIGNE.test(valeur)) return null;
  return [l, libelle, valeur];
}
