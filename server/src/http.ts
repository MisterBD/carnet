// Carnet · outils HTTP : erreurs, réponses JSON, lecture des corps, journal.
import type { IncomingMessage, ServerResponse } from "node:http";
import zlib from "node:zlib";

/** Erreur destinée au client : statut HTTP + message en français (+ champs JSON en plus). */
export class ErreurHttp extends Error {
  statut: number;
  raison: string;
  extra: Record<string, unknown> | undefined;
  entetes: Record<string, string> | undefined;
  constructor(statut: number, message: string, raison = "", extra?: Record<string, unknown>, entetes?: Record<string, string>) {
    super(message);
    this.statut = statut;
    this.raison = raison;
    this.extra = extra;
    this.entetes = entetes;
  }
}

/** Journal JSONL sur stdout (jamais de contenu de page). */
export function journal(objet: Record<string, unknown>): void {
  if (process.env.CARNET_JOURNAL === "0") return;
  process.stdout.write(JSON.stringify({ t: new Date().toISOString(), ...objet }) + "\n");
}

export function accepteGzip(req: IncomingMessage): boolean {
  const ae = req.headers["accept-encoding"];
  return typeof ae === "string" && /\bgzip\b/i.test(ae);
}

/** Envoie un JSON (compressé en gzip au-delà de 1 Kio si le client l'accepte). `Cache-Control: no-store` par défaut. */
export function envoyerJson(req: IncomingMessage, res: ServerResponse, statut: number, objet: unknown, entetes: Record<string, string> = {}): void {
  let corps: Buffer = Buffer.from(typeof objet === "string" ? objet : JSON.stringify(objet), "utf8");
  res.statusCode = statut;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(entetes)) res.setHeader(k, v);
  if (corps.length > 1024 && accepteGzip(req)) {
    corps = zlib.gzipSync(corps, { level: 5 });
    res.setHeader("Content-Encoding", "gzip");
    res.setHeader("Vary", "Accept-Encoding");
  }
  res.setHeader("Content-Length", String(corps.length));
  res.end(corps);
}

export function envoyerTexte(res: ServerResponse, statut: number, texte: string, entetes: Record<string, string> = {}): void {
  const corps = Buffer.from(texte, "utf8");
  res.statusCode = statut;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(entetes)) res.setHeader(k, v);
  res.setHeader("Content-Length", String(corps.length));
  res.end(corps);
}

/** Lit le corps brut, au plus `max` octets (413 au-delà, sans tout lire). */
export function lireCorps(req: IncomingMessage, max: number): Promise<Buffer> {
  const annonce = Number(req.headers["content-length"] ?? "NaN");
  if (Number.isFinite(annonce) && annonce > max) {
    return Promise.reject(new ErreurHttp(413, `Corps trop volumineux (maximum ${Math.round(max / 1024 / 1024)} Mo).`, "trop_gros", undefined, { Connection: "close" }));
  }
  return new Promise((resoudre, rejeter) => {
    const morceaux: Buffer[] = [];
    let total = 0;
    let fini = false;
    req.on("data", (m: Buffer) => {
      if (fini) return;
      total += m.length;
      if (total > max) {
        fini = true;
        req.pause();
        rejeter(new ErreurHttp(413, `Corps trop volumineux (maximum ${Math.round(max / 1024 / 1024)} Mo).`, "trop_gros", undefined, { Connection: "close" }));
        return;
      }
      morceaux.push(m);
    });
    req.on("end", () => { if (!fini) { fini = true; resoudre(Buffer.concat(morceaux)); } });
    req.on("error", (e) => { if (!fini) { fini = true; rejeter(e); } });
    req.on("aborted", () => { if (!fini) { fini = true; rejeter(new ErreurHttp(400, "Requête interrompue.", "interrompue")); } });
  });
}

/** Lit un corps JSON (objet attendu). Content-Type absent ou application/json seulement. */
export async function lireJson(req: IncomingMessage, max = 2 * 1024 * 1024): Promise<Record<string, unknown>> {
  const ct = req.headers["content-type"];
  if (ct !== undefined && !/^application\/json\s*(;|$)/i.test(ct)) {
    throw new ErreurHttp(415, "Corps JSON attendu (Content-Type: application/json).", "type_corps");
  }
  const brut = await lireCorps(req, max);
  let v: unknown;
  try {
    v = JSON.parse(brut.toString("utf8"));
  } catch {
    throw new ErreurHttp(400, "JSON invalide.", "json_invalide");
  }
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErreurHttp(400, "Objet JSON attendu.", "json_invalide");
  return v as Record<string, unknown>;
}

/** Normalise une valeur d'ETag reçue (sans W/, avec guillemets). */
export function normEtag(v: string): string {
  let s = v.trim().replace(/^W\//, "");
  if (!s.startsWith('"')) s = `"${s}"`;
  return s;
}

export function chaine(v: unknown, nom: string, max = 4096): string {
  if (typeof v !== "string") throw new ErreurHttp(400, `Champ « ${nom} » manquant ou invalide.`, "champ_invalide");
  if (v.length > max) throw new ErreurHttp(400, `Champ « ${nom} » trop long.`, "champ_trop_long");
  return v;
}
