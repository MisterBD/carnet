// Carnet · configuration, lue une fois au démarrage dans les variables d'environnement.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { plier } from "../../shared/page.ts";

/** Une ligne de la table « origine appli = base artefacts ». */
export interface Correspondance {
  /** Origine de l'appli, normalisée (minuscules, port par défaut omis), ex. « https://hote.ts.net:8447 ». */
  appli: string;
  /** Base des artefacts associée, ex. « https://hote.ts.net:8446 ». */
  art: string;
  schema: string;
  hote: string;
  /** Port explicite, ou port par défaut du schéma. */
  port: string;
}

export interface Config {
  /** Dossier des .md (chemin réel, sans lien symbolique). */
  espace: string;
  nomEspace: string;
  /** Prénom affiché à l'accueil (« Bonjour, Camille »), le nom fourni par le proxy étant souvent un pseudo. */
  prenom: string;
  port: number;
  hote: string;
  statique: string;
  /** Identités autorisées : logins ou e-mails tels que le proxy les pose dans l'en-tête d'identité (comparés en minuscules). */
  utilisateurs: Set<string>;
  /** Nom de l'en-tête posé par le proxy authentifiant et portant l'identité (login ou e-mail), ex. « Tailscale-User-Login ». */
  enteteIdentite: string;
  /** Nom de l'en-tête portant le nom affichable de l'utilisateur, ex. « Tailscale-User-Name ». */
  enteteNom: string;
  dev: boolean;
  origines: Correspondance[];
  /** Fichier de la clé HMAC des artefacts ("" : signature désactivée). */
  fichierCle: string;
  ttl: number;
  /** Dossier d'état (favoris), hors de l'espace. */
  etat: string;
  /** Dossiers de premier niveau masqués (en plus des règles fixes : segments cachés et « artefacts »). */
  masques: Set<string>;
  /** Mentions qui placent une page dans « À relire », normalisées (minuscules, sans accents, avec « @ »), ex. « @camille ». */
  mentions: string[];
  /** Nom du réseau privé à allumer pour joindre Carnet (« Tailscale »…), cité par les écrans hors ligne ; "" = texte générique. */
  reseau: string;
  /** Qui prévenir quand le serveur répond mal (« l'équipe », un prénom…), cité par les écrans d'erreur ; "" = texte générique. */
  contact: string;
  /** Avertissements de configuration (variables dépréciées…), à journaliser au démarrage. */
  avertissements: string[];
  maxSse: number;
  rebalayageMs: number;
  regroupementMs: number;
  pingMs: number;
  /** Jours avant la purge automatique de la corbeille (0 : jamais). */
  corbeilleJours: number;
  /** Historique git : « auto » (dépôt qui contient l'espace), « non », ou chemin d'un dossier git (GIT_DIR). */
  git: string;
  /** Chemin de l'espace dans le dépôt (seulement quand `git` est un chemin), sans barre finale ("" = racine). */
  gitPrefixe: string;
}

const RE_ORIGINE = /^(https?):\/\/([A-Za-z0-9.-]+)(?::([0-9]{1,5}))?$/;

export function analyserOrigine(brut: string): { origine: string; schema: string; hote: string; port: string } | null {
  const o = brut.trim().replace(/\/+$/, "");
  const m = RE_ORIGINE.exec(o);
  if (!m) return null;
  const schema = m[1].toLowerCase();
  const hote = m[2].toLowerCase();
  const defaut = schema === "https" ? "443" : "80";
  const port = m[3] ?? defaut;
  const n = Number(port);
  if (!Number.isInteger(n) || n < 1 || n > 65535) return null;
  return { origine: `${schema}://${hote}${port === defaut ? "" : ":" + port}`, schema, hote, port: String(n) };
}

/** Lit la table « origine_appli=base_artefacts » (paires séparées par des espaces). */
export function lireOrigines(texte: string): Correspondance[] {
  const out: Correspondance[] = [];
  for (const paire of texte.split(/\s+/).filter(Boolean)) {
    const i = paire.indexOf("=");
    const a = i > 0 ? analyserOrigine(paire.slice(0, i)) : null;
    const b = i > 0 ? analyserOrigine(paire.slice(i + 1)) : null;
    if (!a || !b) throw new Error(`CARNET_ORIGINES_ARTEFACTS : paire invalide ${JSON.stringify(paire)} (attendu origine_appli=base_artefacts)`);
    out.push({ appli: a.origine, art: b.origine, schema: a.schema, hote: a.hote, port: a.port });
  }
  const bases = new Set(out.map((c) => c.art));
  for (const c of out) {
    if (bases.has(c.appli)) throw new Error(`CARNET_ORIGINES_ARTEFACTS : ${c.appli} est à la fois une origine appli et une base d'artefacts`);
  }
  return out;
}

/** Nom d'en-tête HTTP simple (lettres, chiffres, tirets), tel que posé par un proxy authentifiant. */
const RE_ENTETE = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
/** Mention : « @ » facultatif à la saisie, puis lettres, chiffres, « _ » ou « - » (après pliage). */
const RE_MENTION = /^@?([\p{L}\p{N}_][\p{L}\p{N}_-]{0,39})$/u;
const MAX_MENTIONS = 50;
/** Seuls hôtes d'origine acceptés avec CARNET_DEV=1. */
const HOTES_LOCAUX = new Set(["127.0.0.1", "localhost", "[::1]"]);

function lireEntete(v: string | undefined, defaut: string, nom: string): string {
  const t = (v ?? "").trim();
  if (t === "") return defaut;
  if (!RE_ENTETE.test(t)) throw new Error(`${nom} : nom d'en-tête HTTP invalide ${JSON.stringify(t.slice(0, 80))} (lettres, chiffres et tirets seulement, ex. X-Forwarded-Email)`);
  return t;
}

/**
 * Valeur d'une variable renommée : la neuve l'emporte (même vide : on ne retombe pas sur l'ancienne, pour ne jamais
 * élargir un accès par surprise) ; sinon l'ancien nom reste accepté comme alias déprécié, avec un avertissement.
 */
function avecAlias(env: Record<string, string | undefined>, nouveau: string, ancien: string, avertissements: string[]): string | undefined {
  if (env[nouveau] !== undefined) {
    if (env[ancien] !== undefined) avertissements.push(`${ancien} ignorée : ${nouveau} est définie et l'emporte (supprime ${ancien}).`);
    return env[nouveau];
  }
  if (env[ancien] !== undefined) {
    avertissements.push(`${ancien} est dépréciée : renomme-la en ${nouveau}.`);
    return env[ancien];
  }
  return undefined;
}

/**
 * Mentions qui placent une page dans « À relire ». CARNET_MENTIONS (liste séparée par des espaces, même vide) l'emporte ;
 * à défaut : « @ » + premier mot du prénom (minuscules, sans accents) s'il est renseigné, sinon aucune mention.
 */
export function lireMentions(brut: string | undefined, prenom: string): string[] {
  let candidats: string[];
  if (brut !== undefined) {
    candidats = brut.split(/\s+/).filter(Boolean);
  } else {
    const mot = plier(prenom).split(/\s+/).filter(Boolean)[0];
    candidats = mot && RE_MENTION.test(mot) ? ["@" + mot] : [];
  }
  if (candidats.length > MAX_MENTIONS) throw new Error(`CARNET_MENTIONS : ${MAX_MENTIONS} mentions au plus`);
  const out = new Set<string>();
  for (const c of candidats) {
    const m = RE_MENTION.exec(plier(c));
    if (!m) throw new Error(`CARNET_MENTIONS : mention invalide ${JSON.stringify(c.slice(0, 80))} (attendu @nom : lettres, chiffres, « _ » ou « - »)`);
    out.add("@" + m[1]);
  }
  return [...out];
}

/** Court libellé affiché tel quel dans l'interface (lettres, chiffres, espaces, apostrophe, tiret, point) ; "" si absent. */
const RE_LIBELLE = /^[\p{L}\p{N}][\p{L}\p{N} '’.-]{0,39}$/u;
export function lireLibelle(v: string | undefined, nom: string): string {
  const t = (v ?? "").trim();
  if (t === "") return "";
  if (!RE_LIBELLE.test(t)) throw new Error(`${nom} : libellé court attendu (40 caractères au plus : lettres, chiffres, espaces, apostrophe, tiret)`);
  return t;
}

function entier(v: string | undefined, defaut: number, min: number, max: number, nom: string): number {
  if (v === undefined || v === "") return defaut;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nom} : entier entre ${min} et ${max} attendu`);
  return n;
}

export function lireConfig(env: Record<string, string | undefined> = process.env): Config {
  if (!env.CARNET_ESPACE) throw new Error("CARNET_ESPACE manquant (dossier des fichiers .md)");
  const espace = fs.realpathSync(env.CARNET_ESPACE);
  if (!fs.statSync(espace).isDirectory()) throw new Error("CARNET_ESPACE n'est pas un dossier");
  const avertissements: string[] = [];
  const port = entier(env.CARNET_PORT, 3020, 0, 65535, "CARNET_PORT");
  const origines = lireOrigines(
    avecAlias(env, "CARNET_ORIGINES_ARTEFACTS", "CARNET_ORIGINES", avertissements)
      ?? `http://127.0.0.1:${port}=http://127.0.0.1:3006 http://localhost:${port}=http://127.0.0.1:3006`,
  );
  if (!origines.length) throw new Error("CARNET_ORIGINES_ARTEFACTS vide");
  const etat = path.resolve(env.CARNET_ETAT || path.join(os.homedir(), ".local/state/carnet"));
  if (etat === espace || etat.startsWith(espace + path.sep)) throw new Error("CARNET_ETAT doit être HORS de l'espace");
  const dev = env.CARNET_DEV === "1";
  if (dev) {
    // Le mode développement n'exige aucune identité : seulement en local, jamais par un nom de domaine ni derrière un proxy.
    const etranger = origines.find((c) => !HOTES_LOCAUX.has(c.hote));
    if (etranger) {
      throw new Error(
        `CARNET_DEV=1 refusé : le mode développement n'accepte aucune identité, il ne doit jamais être joint par un nom de domaine ni derrière un proxy, `
        + `or CARNET_ORIGINES_ARTEFACTS contient l'origine ${etranger.appli} ; supprime CARNET_DEV ou retire cette origine`,
      );
    }
  }
  const enteteIdentite = lireEntete(env.CARNET_ENTETE_IDENTITE, "Tailscale-User-Login", "CARNET_ENTETE_IDENTITE");
  const enteteNom = lireEntete(env.CARNET_ENTETE_NOM, "Tailscale-User-Name", "CARNET_ENTETE_NOM");
  const utilisateurs = new Set(
    (avecAlias(env, "CARNET_UTILISATEURS_AUTORISES", "CARNET_UTILISATEURS", avertissements) ?? "")
      .split(/\s+/).filter(Boolean).map((s) => s.toLowerCase()),
  );
  // Un serveur qui accepte n'importe quel en-tête d'identité est ouvert à quiconque peut l'atteindre : on refuse de démarrer.
  if (!utilisateurs.size && !dev) {
    throw new Error(
      "aucun utilisateur autorisé : renseigne CARNET_UTILISATEURS_AUTORISES (identités séparées par des espaces, "
      + `telles que ton proxy les pose dans l'en-tête ${enteteIdentite}), ou CARNET_DEV=1 pour un essai local sans authentification`,
    );
  }
  const prenom = (env.CARNET_PRENOM || "").trim().slice(0, 40);
  return {
    espace,
    nomEspace: env.CARNET_NOM_ESPACE || path.basename(espace),
    prenom,
    port,
    hote: env.CARNET_HOTE || "127.0.0.1",
    statique: path.resolve(env.CARNET_STATIQUE || path.join(import.meta.dirname, "../../web/dist")),
    utilisateurs,
    enteteIdentite,
    enteteNom,
    dev,
    origines,
    fichierCle: env.CARNET_CLE || "",
    ttl: entier(env.CARNET_ART_TTL, 900, 30, 86400, "CARNET_ART_TTL"),
    etat,
    masques: new Set((env.CARNET_MASQUES ?? "").split(/\s+/).filter(Boolean).map((s) => s.normalize("NFC"))),
    mentions: lireMentions(env.CARNET_MENTIONS, prenom),
    reseau: lireLibelle(env.CARNET_RESEAU, "CARNET_RESEAU"),
    contact: lireLibelle(env.CARNET_CONTACT, "CARNET_CONTACT"),
    avertissements,
    maxSse: entier(env.CARNET_MAX_SSE, 20, 1, 1000, "CARNET_MAX_SSE"),
    rebalayageMs: entier(env.CARNET_REBALAYAGE_MS, 60_000, 1000, 3_600_000, "CARNET_REBALAYAGE_MS"),
    regroupementMs: entier(env.CARNET_REGROUPEMENT_MS, 120, 0, 10_000, "CARNET_REGROUPEMENT_MS"),
    pingMs: entier(env.CARNET_PING_MS, 20_000, 100, 600_000, "CARNET_PING_MS"),
    corbeilleJours: entier(env.CARNET_CORBEILLE_JOURS, 30, 0, 36_500, "CARNET_CORBEILLE_JOURS"),
    git: lireGit(env.CARNET_GIT),
    gitPrefixe: lirePrefixe(env.CARNET_GIT_PREFIXE),
  };
}

function lireGit(v: string | undefined): string {
  const x = (v ?? "").trim();
  if (x === "" || x === "auto") return "auto";
  if (x === "non" || x === "0" || x === "off") return "non";
  if (!path.isAbsolute(x)) throw new Error("CARNET_GIT : « auto », « non » ou chemin absolu d'un dossier git attendu");
  return path.resolve(x);
}

function lirePrefixe(v: string | undefined): string {
  const x = (v ?? "").trim().replace(/^\/+|\/+$/g, "");
  if (x === "") return "";
  for (const s of x.split("/")) {
    if (s === "" || s === "." || s === ".." || s.startsWith(".") || /[\u0000-\u001f\u007f\\]/.test(s)) {
      throw new Error("CARNET_GIT_PREFIXE : chemin relatif simple attendu (ex. notes)");
    }
  }
  return x;
}
