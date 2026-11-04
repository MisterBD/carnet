// Carnet · sécurité : origine (Host), identité (en-tête du proxy authentifiant), anti-CSRF, chemins et zones interdites, en-têtes, types de fichiers.
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import type { Config, Correspondance } from "./config.ts";
import { ErreurHttp } from "./http.ts";

// ---------------------------------------------------------------------------------------------
// En-têtes de sécurité (toutes les réponses de l'appli)
// ---------------------------------------------------------------------------------------------

export function cspAppli(artBase: string | null): string {
  const a = artBase ? " " + artBase : "";
  return "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
    + `img-src 'self' data: blob:${a}; font-src 'self'; connect-src 'self'; frame-src 'self'${a}; `
    + "worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
}

/** CSP des fichiers de l'espace servis par /api/fichier (images en ligne, téléchargements). */
export const CSP_FICHIER = "sandbox; default-src 'none'";

export function poserEntetesSecurite(res: ServerResponse, artBase: string | null): void {
  res.setHeader("Content-Security-Policy", cspAppli(artBase));
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=(), interest-cohort=()");
}

// ---------------------------------------------------------------------------------------------
// Origine de l'appli d'après le Host (anti DNS-rebinding)
// ---------------------------------------------------------------------------------------------

export interface OrigineTrouvee {
  corr: Correspondance;
  /** Host reçu sans port alors que la table n'a cet hôte qu'avec un port explicite (ou plusieurs candidats). */
  ambigu: boolean;
}

export function trouverOrigine(cfg: Config, hostBrut: string | undefined, xfp: string | undefined): OrigineTrouvee | null {
  if (!hostBrut) return null;
  const m = /^([a-z0-9.-]+)(?::([0-9]{1,5}))?$/.exec(hostBrut.trim().toLowerCase());
  if (!m) return null;
  const h = m[1];
  const p = m[2] !== undefined ? String(Number(m[2])) : undefined;
  const schemaVoulu = xfp ? xfp.split(",")[0].trim().toLowerCase() : null;
  let candidats: Correspondance[];
  let ambigu = false;
  if (p !== undefined) {
    candidats = cfg.origines.filter((c) => c.hote === h && c.port === p);
  } else {
    candidats = cfg.origines.filter((c) => c.hote === h && c.port === (c.schema === "https" ? "443" : "80"));
    if (!candidats.length) {
      // un proxy peut transmettre le Host sans le port : accepté si la table connaît cet hôte (journalisé).
      candidats = cfg.origines.filter((c) => c.hote === h);
      ambigu = candidats.length > 0;
    }
  }
  if (!candidats.length) return null;
  const preferes = schemaVoulu ? candidats.filter((c) => c.schema === schemaVoulu) : [];
  const liste = preferes.length ? preferes : candidats;
  return { corr: liste[0], ambigu: ambigu || liste.length > 1 };
}

// ---------------------------------------------------------------------------------------------
// Identité (en-têtes posés par le proxy authentifiant : Tailscale Serve, oauth2-proxy, Authelia…)
// ---------------------------------------------------------------------------------------------

/** Décode les mots encodés RFC 2047 (=?utf-8?q?…?= / =?utf-8?b?…?=) que certains proxys (dont Tailscale) utilisent pour les noms non ASCII. */
export function decoderMime(v: string): string {
  return v.replace(/\?=\s+=\?/g, "?==?").replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (tout, cs: string, enc: string, txt: string) => {
    if (!/^utf-?8$/i.test(cs)) return tout;
    try {
      const octets = enc.toUpperCase() === "B"
        ? Buffer.from(txt, "base64")
        : Buffer.from(txt.replace(/_/g, " ").replace(/=([0-9A-Fa-f]{2})/g, (_x, hx: string) => String.fromCharCode(parseInt(hx, 16))), "latin1");
      return octets.toString("utf8");
    } catch {
      return tout;
    }
  });
}

function entete(req: IncomingMessage, nom: string): string | undefined {
  const v = req.headers[nom];
  return Array.isArray(v) ? v.join(", ") : v;
}

/**
 * Identité de l'appelant d'après l'en-tête configuré (CARNET_ENTETE_IDENTITE) et son nom affichable (CARNET_ENTETE_NOM).
 * Ces en-têtes ne valent que si le proxy authentifiant les pose lui-même ET écarte ceux envoyés par le client.
 */
export function verifierIdentite(cfg: Config, req: IncomingMessage): { login: string; nom: string } {
  const login = entete(req, cfg.enteteIdentite.toLowerCase());
  if (login === undefined) {
    if (cfg.dev) return { login: "dev", nom: "Développement" };
    throw new ErreurHttp(403, `Accès réservé : identité absente (en-tête ${cfg.enteteIdentite}).`, "identite_absente");
  }
  if (!cfg.utilisateurs.has(login.trim().toLowerCase())) {
    throw new ErreurHttp(403, "Accès refusé pour ce compte.", "identite_refusee");
  }
  const nomBrut = entete(req, cfg.enteteNom.toLowerCase()) ?? "";
  const nom = decoderMime(nomBrut).replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 200) || login.trim();
  return { login: login.trim(), nom };
}

// ---------------------------------------------------------------------------------------------
// Anti-CSRF
// ---------------------------------------------------------------------------------------------

/** Mutations : X-Carnet: 1 obligatoire, Origin (si présent) = origine de l'appli, Sec-Fetch-Site (si présent) = same-origin. */
export function verifierMutation(req: IncomingMessage, corr: Correspondance): void {
  if (entete(req, "x-carnet") !== "1") throw new ErreurHttp(403, "Requête refusée (en-tête X-Carnet manquant).", "csrf_entete");
  const origine = entete(req, "origin");
  if (origine !== undefined && origine.trim().toLowerCase() !== corr.appli) {
    throw new ErreurHttp(403, "Requête refusée (origine étrangère).", "csrf_origine");
  }
  const site = entete(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin") throw new ErreurHttp(403, "Requête refusée (requête intersite).", "csrf_site");
}

/** Lectures de l'API et de /_art : pas de requête intersite (défense en profondeur contre les fuites par <img>, <script>…). */
export function verifierLectureApi(req: IncomingMessage): void {
  const site = entete(req, "sec-fetch-site");
  if (site !== undefined && site !== "same-origin" && site !== "none") {
    throw new ErreurHttp(403, "Requête refusée (requête intersite).", "lecture_intersite");
  }
}

// ---------------------------------------------------------------------------------------------
// Chemins et zones interdites
// ---------------------------------------------------------------------------------------------

const RE_CONTROLE = /[\u0000-\u001f\u007f-\u009f]/;

/**
 * Analyse un chemin relatif à l'espace (déjà décodé une fois) et renvoie ses segments (NFC).
 * Refuse : vide (sauf `vide`), > 1024 caractères, > 32 niveaux, NUL / contrôles, antislash, absolu,
 * segment vide, « . », « .. », segment caché (commençant par « . »), segment > 255 octets.
 */
export function analyserChemin(brut: unknown, opts: { vide?: boolean } = {}): string[] {
  if (typeof brut !== "string") throw new ErreurHttp(400, "Chemin manquant.", "chemin_absent");
  const c = brut.normalize("NFC");
  if (c === "") {
    if (opts.vide) return [];
    throw new ErreurHttp(400, "Chemin vide.", "chemin_vide");
  }
  if (c.length > 1024) throw new ErreurHttp(400, "Chemin trop long.", "chemin_trop_long");
  if (RE_CONTROLE.test(c) || c.includes("\\")) throw new ErreurHttp(400, "Caractère interdit dans le chemin.", "caractere_interdit");
  if (c.startsWith("/")) throw new ErreurHttp(400, "Chemin absolu refusé.", "chemin_absolu");
  const segs = c.split("/");
  if (segs.length > 32) throw new ErreurHttp(400, "Chemin trop profond.", "chemin_trop_profond");
  for (const s of segs) {
    if (s === "") throw new ErreurHttp(400, "Segment de chemin vide.", "segment_vide");
    if (s === "." || s === "..") throw new ErreurHttp(403, "Chemin interdit.", "traversee");
    if (s.startsWith(".")) throw new ErreurHttp(403, "Chemin interdit (fichier caché).", "cache");
    if (Buffer.byteLength(s) > 255) throw new ErreurHttp(400, "Nom trop long.", "segment_trop_long");
  }
  return segs;
}

/**
 * Raison de l'interdiction d'un chemin logique (segments), ou null s'il est autorisé.
 * Zones fixes : segments cachés (« . » en tête) et « artefacts » à la racine ; le reste vient de CARNET_MASQUES (premier niveau).
 */
export function zoneInterdite(cfg: Config, segs: string[]): string | null {
  if (segs.some((s) => s.startsWith("."))) return "cache";
  if (segs.length && segs[0] === "artefacts") return "artefacts";
  if (segs.length && cfg.masques.has(segs[0])) return "masque";
  return null;
}

export function exigerZoneAutorisee(cfg: Config, segs: string[]): void {
  const r = zoneInterdite(cfg, segs);
  if (r) throw new ErreurHttp(403, "Chemin interdit.", r);
}

/** Chemin analysé + zone autorisée. */
export function cheminAutorise(cfg: Config, brut: unknown, opts: { vide?: boolean } = {}): string[] {
  const segs = analyserChemin(brut, opts);
  exigerZoneAutorisee(cfg, segs);
  return segs;
}

/** Chemin d'une page : se termine par « .md ». */
export function cheminPage(cfg: Config, brut: unknown): string[] {
  const segs = cheminAutorise(cfg, brut);
  const f = segs[segs.length - 1];
  if (!f.endsWith(".md") || f.length <= 3) throw new ErreurHttp(400, "Chemin de page attendu (fichier .md).", "pas_une_page");
  return segs;
}

/** Segments logiques (NFC) d'un chemin réel, ou null s'il est hors de l'espace. */
export function relatifReel(cfg: Config, reel: string): string[] | null {
  if (reel === cfg.espace) return [];
  if (!reel.startsWith(cfg.espace + path.sep)) return null;
  return reel.slice(cfg.espace.length + 1).split(path.sep).map((s) => s.normalize("NFC"));
}

/** Un chemin réel (après résolution des liens) est-il dans l'espace et hors des zones interdites ? */
export function reelAutorise(cfg: Config, reel: string): boolean {
  const segs = relatifReel(cfg, reel);
  return segs !== null && zoneInterdite(cfg, segs) === null;
}

// ---------------------------------------------------------------------------------------------
// Types de fichiers
// ---------------------------------------------------------------------------------------------

/** Servis EN LIGNE par /api/fichier (après vérification des octets magiques). */
export const EXT_IMAGES = new Set(["png", "jpg", "jpeg", "webp", "gif", "avif"]);
/** Servis en téléchargement (attachment + application/octet-stream). */
export const EXT_TELECHARGEMENT = new Set([
  "pdf", "txt", "csv", "json", "md",
  "mp3", "m4a", "wav", "ogg", "oga", "opus", "flac", "aac",
  "mp4", "m4v", "webm", "mov", "ogv",
]);

export function extension(nom: string): string {
  const i = nom.lastIndexOf(".");
  return i <= 0 ? "" : nom.slice(i + 1).toLowerCase();
}

/** Fichier non-Markdown visible dans l'arbre. */
export function fichierVisible(nom: string): boolean {
  const e = extension(nom);
  return EXT_IMAGES.has(e) || EXT_TELECHARGEMENT.has(e);
}

/** Type d'image d'après les octets magiques ("png", "jpeg", "gif", "webp", "avif") ou null. */
export function typeImage(o: Buffer): string | null {
  if (o.length >= 8 && o.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "png";
  if (o.length >= 3 && o[0] === 0xff && o[1] === 0xd8 && o[2] === 0xff) return "jpeg";
  if (o.length >= 6 && (o.subarray(0, 6).toString("latin1") === "GIF87a" || o.subarray(0, 6).toString("latin1") === "GIF89a")) return "gif";
  if (o.length >= 12 && o.subarray(0, 4).toString("latin1") === "RIFF" && o.subarray(8, 12).toString("latin1") === "WEBP") return "webp";
  if (o.length >= 12 && o.subarray(4, 8).toString("latin1") === "ftyp") {
    const marques = o.subarray(8, Math.min(o.length, 64)).toString("latin1");
    if (/avi[fs]/.test(marques)) return "avif";
  }
  return null;
}

export const MIME_IMAGE: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", avif: "image/avif",
};
