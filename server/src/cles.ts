// Carnet · clés d'accès (WebAuthn : Face ID sur iPhone, Touch ID sur Mac) pour PROUVER le geste humain d'une décision.
//
// Pourquoi : l'identité posée par Tailscale ne distingue pas la personne des agents qui passent par le même compte
// (fait vérifié le 10/10/2026). Une décision signée par une clé d'accès enregistrée sur l'appareil de la personne prouve
// qu'un humain a fait le geste, sur cette proposition précise : le défi signé est le SHA-256 d'un JSON canonique
// {v, espace, demande, empreinte, resultat, portee, nonce}.
//
// Enregistrement protégé : uniquement avec un code d'enrôlement à usage unique créé HORS de l'appli par une commande
// d'administration (`node server/src/admin-cles.ts code`), jamais par une route ouverte. Sans clé enregistrée, une
// décision reste possible mais elle est marquée « geste non prouvé » ; dès qu'une clé existe, toute décision exige une
// assertion valide (un agent ne peut plus fabriquer de décision, même « non prouvée »).
//
// Vérification avec node:crypto seul : CBOR minimal (attestationObject, clé COSE), ES256 / EdDSA / RS256, origine,
// RP ID (nom d'hôte de l'appli, sans port), présence ET vérification de l'utilisateur (UP + UV), compteur de signature.
// L'attestation de l'authentificateur n'est pas vérifiée (« none ») : la confiance vient du code d'enrôlement.
// Limite assumée : un processus qui peut écrire dans CARNET_ETAT (ou lancer la commande d'administration) peut
// enrôler une clé logicielle. Protection contre l'agent naïf et l'erreur, pas contre un agent malveillant sur la machine.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { jsonCanonique } from "../../shared/decision.ts";
import { nomDeFichier } from "../../shared/page.ts";
import type { Config } from "./config.ts";
import { ecrireAtomique } from "./disque.ts";
import { ErreurHttp } from "./http.ts";

export const ALGOS = [-7, -8, -257] as const;
const DUREE_DEFI_MS = 5 * 60_000;
const DUREE_CONSOMME_MS = 10 * 60_000;
const MAX_DEFIS = 200;
const MAX_ESSAIS_CODE = 5;

export interface CleStockee {
  id: string;
  alg: number;
  jwk: crypto.JsonWebKey;
  signCount: number;
  nom: string;
  rpId: string;
  principal: string;
  cree: string;
  utilisee: string | null;
  transports?: string[];
}

interface FichierCles { version: 1; cles: CleStockee[] }
interface Enrolement { empreinte: string; expire: number; cree: string }

export interface DonneesDecision {
  chemin: string;
  demande: string;
  empreinte: string;
  resultat: string;
  /** Portée exacte de l'attestation (shared/decision.ts : porteeDe) : décision et commentaire compris. */
  portee: string;
  /** Identifiant de la décision fixé au moment du défi. */
  decision: string;
}

interface Defi {
  type: "enregistrement" | "decision";
  expire: number;
  principal: string;
  rpId: string;
  donnees?: DonneesDecision;
  code?: string;
  consomme?: { requete: string; t: number; cle: string; decision: string };
}

// ---------------------------------------------------------------------------------------------
// Encodages
// ---------------------------------------------------------------------------------------------

export function b64u(b: Buffer | Uint8Array): string {
  return Buffer.from(b).toString("base64url");
}

function deB64u(s: unknown, nom: string, max = 64 * 1024): Buffer {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > max) throw new ErreurHttp(400, `Champ « ${nom} » invalide (base64url attendu).`, "webauthn_format");
  return Buffer.from(s, "base64url");
}

/** CBOR minimal (RFC 8949) : entiers, chaînes d'octets et de texte, tableaux, tables, simples. Longueurs définies seulement. */
export function lireCbor(b: Buffer, pos = 0, prof = 0): { valeur: unknown; fin: number } {
  if (prof > 16) throw new Error("CBOR trop profond");
  if (pos >= b.length) throw new Error("CBOR tronqué");
  const ib = b[pos];
  const maj = ib >> 5;
  const add = ib & 31;
  let p = pos + 1;
  const besoin = (n: number) => { if (p + n > b.length) throw new Error("CBOR tronqué"); };
  const longueur = (): number => {
    if (add < 24) return add;
    if (add === 24) { besoin(1); const v = b[p]; p += 1; return v; }
    if (add === 25) { besoin(2); const v = b.readUInt16BE(p); p += 2; return v; }
    if (add === 26) { besoin(4); const v = b.readUInt32BE(p); p += 4; return v; }
    if (add === 27) {
      besoin(8);
      const v = b.readBigUInt64BE(p);
      p += 8;
      if (v > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("CBOR : entier trop grand");
      return Number(v);
    }
    throw new Error("CBOR : longueur indéfinie non prise en charge");
  };
  switch (maj) {
    case 0: return { valeur: longueur(), fin: p };
    case 1: { const n = longueur(); return { valeur: -1 - n, fin: p }; }
    case 2: { const n = longueur(); besoin(n); return { valeur: b.subarray(p, p + n), fin: p + n }; }
    case 3: { const n = longueur(); besoin(n); return { valeur: b.subarray(p, p + n).toString("utf8"), fin: p + n }; }
    case 4: {
      const n = longueur();
      if (n > 1024) throw new Error("CBOR : tableau trop long");
      const t: unknown[] = [];
      for (let i = 0; i < n; i++) { const x = lireCbor(b, p, prof + 1); t.push(x.valeur); p = x.fin; }
      return { valeur: t, fin: p };
    }
    case 5: {
      const n = longueur();
      if (n > 256) throw new Error("CBOR : table trop longue");
      const m = new Map<unknown, unknown>();
      for (let i = 0; i < n; i++) {
        const k = lireCbor(b, p, prof + 1);
        const v = lireCbor(b, k.fin, prof + 1);
        m.set(k.valeur, v.valeur);
        p = v.fin;
      }
      return { valeur: m, fin: p };
    }
    case 7:
      if (add === 20) return { valeur: false, fin: p };
      if (add === 21) return { valeur: true, fin: p };
      if (add === 22) return { valeur: null, fin: p };
      if (add === 23) return { valeur: undefined, fin: p };
      throw new Error("CBOR : valeur simple non prise en charge");
    default:
      throw new Error("CBOR : type non pris en charge");
  }
}

/** Clé publique COSE -> JWK + algorithme (ES256 / P-256, EdDSA / Ed25519, RS256). */
export function coseVersJwk(m: unknown): { alg: number; jwk: crypto.JsonWebKey } {
  if (!(m instanceof Map)) throw new Error("clé COSE invalide");
  const kty = m.get(1);
  const alg = m.get(3);
  const octets = (k: number, n?: number): string => {
    const v = m.get(k);
    if (!(v instanceof Uint8Array) || (n !== undefined && v.length !== n)) throw new Error("clé COSE invalide");
    return b64u(v);
  };
  if (kty === 2 && alg === -7) {
    if (m.get(-1) !== 1) throw new Error("courbe non prise en charge");
    return { alg, jwk: { kty: "EC", crv: "P-256", x: octets(-2, 32), y: octets(-3, 32) } };
  }
  if (kty === 1 && alg === -8) {
    if (m.get(-1) !== 6) throw new Error("courbe non prise en charge");
    return { alg, jwk: { kty: "OKP", crv: "Ed25519", x: octets(-2, 32) } };
  }
  if (kty === 3 && alg === -257) return { alg, jwk: { kty: "RSA", n: octets(-1), e: octets(-2) } };
  throw new Error("algorithme de clé non pris en charge (ES256, EdDSA ou RS256 attendus)");
}

export function verifierSignature(alg: number, jwk: crypto.JsonWebKey, donnees: Buffer, sig: Buffer): boolean {
  try {
    const cle = crypto.createPublicKey({ key: jwk, format: "jwk" });
    if (alg === -7) return crypto.verify("sha256", donnees, { key: cle, dsaEncoding: "der" }, sig);
    if (alg === -8) return crypto.verify(null, donnees, cle, sig);
    if (alg === -257) return crypto.verify("sha256", donnees, cle, sig);
  } catch { /* clé ou signature mal formée */ }
  return false;
}

interface DonneesAuth { rpIdHash: Buffer; flags: number; signCount: number; credId?: Buffer; cose?: unknown }

export function lireDonneesAuth(a: Buffer, avecCle: boolean): DonneesAuth {
  if (a.length < 37) throw new ErreurHttp(400, "Données d'authentification trop courtes.", "webauthn_format");
  const flags = a[32];
  const r: DonneesAuth = { rpIdHash: a.subarray(0, 32), flags, signCount: a.readUInt32BE(33) };
  if (avecCle) {
    if (!(flags & 0x40)) throw new ErreurHttp(400, "Clé publique absente de la réponse de l'appareil.", "webauthn_format");
    if (a.length < 55) throw new ErreurHttp(400, "Données d'authentification tronquées.", "webauthn_format");
    const n = a.readUInt16BE(53);
    if (n < 16 || n > 1023 || a.length < 55 + n + 1) throw new ErreurHttp(400, "Identifiant de clé invalide.", "webauthn_format");
    r.credId = a.subarray(55, 55 + n);
    try {
      r.cose = lireCbor(a, 55 + n).valeur;
    } catch {
      throw new ErreurHttp(400, "Clé publique illisible.", "webauthn_format");
    }
  }
  return r;
}

function sha256(b: Buffer | string): Buffer {
  return crypto.createHash("sha256").update(b).digest();
}

/** Nom d'hôte (RP ID WebAuthn) d'une origine « https://hote:port ». */
export function rpIdDe(origine: string): string {
  return new URL(origine).hostname.replace(/^\[|\]$/g, "");
}

/** Code d'enrôlement normalisé : majuscules, sans espaces ni tirets. */
function normaliserCode(c: string): string {
  return c.toUpperCase().replace(/[\s-]/g, "");
}

export function nouveauCode(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const o = crypto.randomBytes(10);
  const c = [...o].map((x) => alphabet[x % alphabet.length]).join("");
  return `${c.slice(0, 5)}-${c.slice(5)}`;
}

// ---------------------------------------------------------------------------------------------

export class Cles {
  #dossier: string;
  #espace: string;
  /** Nom de l'espace tel qu'il figure dans les attestations (canonique du défi). */
  #nomEspace: string;
  #defis = new Map<string, Defi>();
  /** Essais faux pour le code d'enrôlement en cours (remis à zéro quand un nouveau code apparaît). */
  #essais = { code: "", n: 0 };
  #file: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config) {
    this.#espace = nomDeFichier(cfg.nomEspace);
    this.#nomEspace = cfg.nomEspace;
    this.#dossier = path.join(cfg.etat, "cles", this.#espace);
  }

  get dossier(): string { return this.#dossier; }

  #serie<T>(f: () => Promise<T>): Promise<T> {
    const r = this.#file.then(f);
    this.#file = r.then(() => undefined, () => undefined);
    return r;
  }

  async #lire(): Promise<FichierCles> {
    try {
      const v = JSON.parse(await fsp.readFile(path.join(this.#dossier, "cles.json"), "utf8")) as FichierCles;
      if (v && v.version === 1 && Array.isArray(v.cles)) return v;
    } catch { /* absent */ }
    return { version: 1, cles: [] };
  }

  async #ecrire(f: FichierCles): Promise<void> {
    await fsp.mkdir(this.#dossier, { recursive: true, mode: 0o700 });
    await ecrireAtomique(path.join(this.#dossier, "cles.json"), JSON.stringify(f, null, 1) + "\n", { mode: 0o600 });
  }

  async lister(): Promise<CleStockee[]> {
    return (await this.#lire()).cles;
  }

  async #enrolement(): Promise<Enrolement | null> {
    try {
      const v = JSON.parse(await fsp.readFile(path.join(this.#dossier, "enrolement.json"), "utf8")) as Enrolement;
      if (v && typeof v.empreinte === "string" && typeof v.expire === "number") return v;
    } catch { /* absent */ }
    return null;
  }

  async enrolementEnAttente(): Promise<boolean> {
    const e = await this.#enrolement();
    return !!e && e.expire > Date.now();
  }

  /** Commande d'administration : nouveau code (remplace le précédent). Renvoie le code en clair, jamais stocké. */
  async creerCode(minutes = 30): Promise<{ code: string; expire: number }> {
    const code = nouveauCode();
    const expire = Date.now() + minutes * 60_000;
    await fsp.mkdir(this.#dossier, { recursive: true, mode: 0o700 });
    const e: Enrolement = { empreinte: sha256(normaliserCode(code)).toString("hex"), expire, cree: new Date().toISOString() };
    await ecrireAtomique(path.join(this.#dossier, "enrolement.json"), JSON.stringify(e) + "\n", { mode: 0o600 });
    return { code, expire };
  }

  async retirer(id: string): Promise<boolean> {
    return this.#serie(async () => {
      const f = await this.#lire();
      const n = f.cles.length;
      f.cles = f.cles.filter((c) => c.id !== id && !c.id.startsWith(id));
      if (f.cles.length === n) return false;
      await this.#ecrire(f);
      return true;
    });
  }

  async #verifierCode(code: unknown): Promise<string> {
    if (typeof code !== "string" || code.length > 40) throw new ErreurHttp(400, "Code d'enrôlement manquant.", "code_absent");
    const e = await this.#enrolement();
    if (!e || e.expire <= Date.now()) throw new ErreurHttp(403, "Aucun code d'enrôlement valide : crée-en un avec la commande d'administration.", "code_absent");
    const a = Buffer.from(sha256(normaliserCode(code)).toString("hex"));
    const b = Buffer.from(e.empreinte);
    if (this.#essais.code !== e.empreinte) this.#essais = { code: e.empreinte, n: 0 };
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
      this.#essais.n++;
      if (this.#essais.n >= MAX_ESSAIS_CODE) {
        this.#essais = { code: "", n: 0 };
        await fsp.rm(path.join(this.#dossier, "enrolement.json"), { force: true });
        throw new ErreurHttp(403, "Trop d'essais : le code est annulé, crée-en un nouveau.", "code_annule");
      }
      throw new ErreurHttp(403, "Code d'enrôlement incorrect.", "code_faux");
    }
    this.#essais = { code: e.empreinte, n: 0 };
    return e.empreinte;
  }

  #nettoyer(): void {
    const t = Date.now();
    for (const [k, d] of this.#defis) {
      const limite = d.consomme ? d.consomme.t + DUREE_CONSOMME_MS : d.expire;
      if (limite < t) this.#defis.delete(k);
    }
    while (this.#defis.size > MAX_DEFIS) this.#defis.delete(this.#defis.keys().next().value!);
  }

  /** Options de navigator.credentials.create (après vérification du code). */
  async defiEnregistrement(code: unknown, origine: string, principal: string, nomUtilisateur: string): Promise<Record<string, unknown>> {
    return this.#serie(async () => {
      const empreinteCode = await this.#verifierCode(code);
      this.#nettoyer();
      const rpId = rpIdDe(origine);
      const challenge = b64u(crypto.randomBytes(32));
      this.#defis.set(challenge, { type: "enregistrement", expire: Date.now() + DUREE_DEFI_MS, principal, rpId, code: empreinteCode });
      const existantes = (await this.#lire()).cles.filter((c) => c.rpId === rpId);
      return {
        challenge,
        rp: { id: rpId, name: "Carnet" },
        user: { id: b64u(sha256(`carnet:${this.#espace}:${principal.toLowerCase()}`).subarray(0, 16)), name: principal, displayName: nomUtilisateur || principal },
        pubKeyCredParams: ALGOS.map((alg) => ({ type: "public-key", alg })),
        authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
        attestation: "none",
        timeout: DUREE_DEFI_MS,
        excludeCredentials: existantes.map((c) => ({ type: "public-key", id: c.id, transports: c.transports })),
      };
    });
  }

  #clientData(brut: Buffer, type: string, origine: string): { challenge: string } {
    let cd: Record<string, unknown>;
    try { cd = JSON.parse(brut.toString("utf8")); } catch { throw new ErreurHttp(400, "Réponse de l'appareil illisible.", "webauthn_format"); }
    if (cd.type !== type) throw new ErreurHttp(400, "Réponse de l'appareil d'un autre type.", "webauthn_type");
    if (typeof cd.challenge !== "string") throw new ErreurHttp(400, "Défi absent.", "webauthn_format");
    if (cd.origin !== origine) throw new ErreurHttp(403, "Origine de la clé d'accès inattendue.", "webauthn_origine");
    if (cd.crossOrigin === true) throw new ErreurHttp(403, "Clé d'accès utilisée depuis un cadre étranger.", "webauthn_origine");
    return { challenge: cd.challenge };
  }

  /** Termine l'enregistrement : vérifie la réponse de navigator.credentials.create et stocke la clé publique. */
  async enregistrer(corps: Record<string, unknown>, origine: string, principal: string): Promise<CleStockee> {
    return this.#serie(async () => {
      const r = (corps.reponse ?? {}) as Record<string, unknown>;
      const cdBrut = deB64u(r.clientDataJSON, "clientDataJSON");
      const { challenge } = this.#clientData(cdBrut, "webauthn.create", origine);
      this.#nettoyer();
      const defi = this.#defis.get(challenge);
      if (!defi || defi.type !== "enregistrement" || defi.expire < Date.now() || defi.principal !== principal) {
        throw new ErreurHttp(403, "Défi d'enregistrement inconnu ou expiré : recommence.", "webauthn_defi");
      }
      const e = await this.#enrolement();
      if (!e || e.expire <= Date.now() || e.empreinte !== defi.code) throw new ErreurHttp(403, "Le code d'enrôlement n'est plus valide.", "code_absent");
      let ao: unknown;
      try { ao = lireCbor(deB64u(r.attestationObject, "attestationObject", 256 * 1024)).valeur; } catch (x) {
        if (x instanceof ErreurHttp) throw x;
        throw new ErreurHttp(400, "Réponse de l'appareil illisible.", "webauthn_format");
      }
      if (!(ao instanceof Map) || !(ao.get("authData") instanceof Uint8Array)) throw new ErreurHttp(400, "Réponse de l'appareil incomplète.", "webauthn_format");
      const ad = lireDonneesAuth(Buffer.from(ao.get("authData") as Uint8Array), true);
      if (!ad.rpIdHash.equals(sha256(defi.rpId))) throw new ErreurHttp(403, "Clé créée pour un autre site.", "webauthn_rp");
      if (!(ad.flags & 0x01) || !(ad.flags & 0x04)) throw new ErreurHttp(403, "L'appareil n'a pas vérifié ton identité (Face ID, Touch ID ou code).", "webauthn_uv");
      let cle: { alg: number; jwk: crypto.JsonWebKey };
      try { cle = coseVersJwk(ad.cose); } catch (x) { throw new ErreurHttp(400, `Clé refusée : ${(x as Error).message}.`, "webauthn_algo"); }
      const id = b64u(ad.credId!);
      if (typeof corps.id === "string" && corps.id !== id) throw new ErreurHttp(400, "Identifiant de clé incohérent.", "webauthn_format");
      const f = await this.#lire();
      if (f.cles.some((c) => c.id === id)) throw new ErreurHttp(409, "Cette clé est déjà enregistrée.", "cle_existe");
      const nomBrut = typeof corps.nom === "string" ? corps.nom : "";
      const nom = nomBrut.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 60) || "Clé d'accès";
      const transports = Array.isArray(r.transports) ? r.transports.filter((t): t is string => typeof t === "string" && /^[a-z-]{1,20}$/.test(t)).slice(0, 6) : undefined;
      const stockee: CleStockee = {
        id, alg: cle.alg, jwk: cle.jwk, signCount: ad.signCount, nom, rpId: defi.rpId, principal, cree: new Date().toISOString(), utilisee: null,
        ...(transports ? { transports } : {}),
      };
      f.cles.push(stockee);
      await this.#ecrire(f);
      this.#defis.delete(challenge);
      await fsp.rm(path.join(this.#dossier, "enrolement.json"), { force: true }); // usage unique
      return stockee;
    });
  }

  /** Défi d'une décision : SHA-256 du JSON canonique {v, espace, demande, empreinte, resultat, portee, nonce} (portée : décision et commentaire compris). */
  async defiDecision(d: DonneesDecision, origine: string, principal: string): Promise<Record<string, unknown>> {
    return this.#serie(async () => {
      const rpId = rpIdDe(origine);
      const cles = (await this.#lire()).cles.filter((c) => c.rpId === rpId);
      if (!cles.length) throw new ErreurHttp(409, `Aucune clé d'accès enregistrée pour ${rpId}.`, "cle_absente_origine");
      this.#nettoyer();
      const canon = { v: 1, espace: this.#nomEspace, demande: d.demande, empreinte: d.empreinte, resultat: d.resultat, portee: d.portee, nonce: b64u(crypto.randomBytes(16)) };
      const challenge = b64u(sha256(jsonCanonique(canon)));
      this.#defis.set(challenge, { type: "decision", expire: Date.now() + DUREE_DEFI_MS, principal, rpId, donnees: { ...d } });
      return {
        challenge,
        rpId,
        allowCredentials: cles.map((c) => ({ type: "public-key", id: c.id, transports: c.transports })),
        userVerification: "required",
        timeout: DUREE_DEFI_MS,
        decision: canon,
      };
    });
  }

  /**
   * Vérifie l'assertion d'une décision : défi émis pour CETTE décision (demande, empreinte, résultat, page), origine,
   * RP ID, UP + UV, signature, compteur. Un défi ne sert qu'une fois, sauf pour réessayer la MÊME requête.
   */
  async verifierDecision(
    a: unknown, d: DonneesDecision, origine: string, principal: string, requete: string, porteePour: (decision: string) => string,
  ): Promise<{ cle: string; decision: string }> {
    return this.#serie(async () => {
      if (!a || typeof a !== "object") throw new ErreurHttp(403, "Confirmation par clé d'accès requise.", "cle_requise");
      const x = a as Record<string, unknown>;
      const cdBrut = deB64u(x.clientDataJSON, "clientDataJSON");
      const { challenge } = this.#clientData(cdBrut, "webauthn.get", origine);
      this.#nettoyer();
      const defi = this.#defis.get(challenge);
      if (!defi || defi.type !== "decision" || defi.principal !== principal) throw new ErreurHttp(403, "Confirmation inconnue ou expirée : recommence.", "webauthn_defi");
      const dd = defi.donnees!;
      if (dd.chemin !== d.chemin || dd.demande !== d.demande || dd.empreinte !== d.empreinte || dd.resultat !== d.resultat) {
        throw new ErreurHttp(403, "La confirmation porte sur une autre décision.", "webauthn_autre_decision");
      }
      if (porteePour(dd.decision) !== dd.portee) {
        throw new ErreurHttp(403, "Le commentaire a changé depuis la confirmation : confirme de nouveau.", "webauthn_commentaire");
      }
      if (defi.consomme) {
        if (defi.consomme.requete === requete) return { cle: defi.consomme.cle, decision: defi.consomme.decision };
        throw new ErreurHttp(403, "Cette confirmation a déjà servi.", "webauthn_rejeu");
      }
      if (defi.expire < Date.now()) throw new ErreurHttp(403, "Confirmation expirée : recommence.", "webauthn_defi");
      const ad = deB64u(x.authenticatorData, "authenticatorData");
      const sig = deB64u(x.signature, "signature");
      const info = lireDonneesAuth(ad, false);
      if (!info.rpIdHash.equals(sha256(defi.rpId))) throw new ErreurHttp(403, "Clé d'accès d'un autre site.", "webauthn_rp");
      if (!(info.flags & 0x01) || !(info.flags & 0x04)) throw new ErreurHttp(403, "L'appareil n'a pas vérifié ton identité (Face ID, Touch ID ou code).", "webauthn_uv");
      const f = await this.#lire();
      const cle = f.cles.find((c) => c.id === x.id && c.rpId === defi.rpId);
      if (!cle) throw new ErreurHttp(403, "Clé d'accès inconnue.", "cle_inconnue");
      if (!verifierSignature(cle.alg, cle.jwk, Buffer.concat([ad, sha256(cdBrut)]), sig)) throw new ErreurHttp(403, "Signature de la clé d'accès invalide.", "webauthn_signature");
      if ((info.signCount !== 0 || cle.signCount !== 0) && info.signCount <= cle.signCount) {
        throw new ErreurHttp(403, "Compteur de la clé d'accès incohérent (clé copiée ?).", "webauthn_compteur");
      }
      cle.signCount = info.signCount;
      cle.utilisee = new Date().toISOString();
      await this.#ecrire(f);
      defi.consomme = { requete, t: Date.now(), cle: cle.id, decision: dd.decision };
      return { cle: cle.id, decision: dd.decision };
    });
  }
}
