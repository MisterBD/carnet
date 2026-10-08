// Carnet · fichiers statiques du build de l'interface (Vite), avec repli SPA sur index.html.
import fs from "node:fs";
import fsp from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { ErreurHttp } from "./http.ts";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".avif": "image/avif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
};
const COMPRESSIBLES = new Set([".html", ".js", ".mjs", ".css", ".json", ".map", ".webmanifest", ".txt", ".svg", ".wasm", ".ttf", ".otf", ".ico"]);

interface EnCache {
  cle: string;
  brut: Buffer;
  br?: Buffer;
  gz?: Buffer;
  etag: string;
}

const PAGE_ABSENTE = `<!doctype html>
<html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Carnet</title><style>body{font:16px/1.5 system-ui,sans-serif;margin:3rem auto;max-width:32rem;padding:0 1rem;color:#222}</style></head>
<body><h1>Carnet</h1><p>Le serveur tourne, mais l'interface n'est pas encore construite (build absent).</p></body></html>
`;

export class Statique {
  racine: string;
  #cache = new Map<string, EnCache>();
  #octets = 0;
  #max = 48 * 1024 * 1024;

  constructor(racine: string) {
    this.racine = racine;
  }

  async servir(req: IncomingMessage, res: ServerResponse, chemin: string): Promise<string> {
    let dec: string;
    try {
      dec = decodeURIComponent(chemin);
    } catch {
      throw new ErreurHttp(400, "Adresse invalide.", "encodage_invalide");
    }
    const segs = dec.split("/").filter((s) => s !== "");
    const sur = segs.every((s) => !s.startsWith(".") && !s.includes("\\") && !/[\u0000-\u001f\u007f]/.test(s));
    let racineReelle: string;
    try {
      racineReelle = await fsp.realpath(this.racine);
    } catch {
      return this.#absente(res);
    }
    if (sur && segs.length && segs.length <= 16) {
      const abs = path.join(racineReelle, ...segs);
      const ext = path.extname(abs).toLowerCase();
      const type = TYPES[ext];
      if (type) {
        const r = await this.#lire(racineReelle, abs);
        if (r) {
          let cache = "no-cache";
          if (segs[0] === "assets") cache = "public, max-age=31536000, immutable";
          const extra: Record<string, string> = {};
          if (segs.length === 1 && segs[0] === "sw.js") extra["Service-Worker-Allowed"] = "/";
          this.#envoyer(req, res, r, type, ext, cache, extra);
          return "statique";
        }
      }
    }
    if (segs[0] === "assets") throw new ErreurHttp(404, "Introuvable.", "statique_introuvable");
    if (segs.length === 1 && (segs[0] === "sw.js" || segs[0] === "manifest.webmanifest" || segs[0] === "favicon.ico")) {
      throw new ErreurHttp(404, "Introuvable.", "statique_introuvable");
    }
    const index = await this.#lire(racineReelle, path.join(racineReelle, "index.html"));
    if (!index) return this.#absente(res);
    this.#envoyer(req, res, index, TYPES[".html"], ".html", "no-cache", {});
    return "index";
  }

  #absente(res: ServerResponse): string {
    const corps = Buffer.from(PAGE_ABSENTE, "utf8");
    res.statusCode = 200;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Content-Length", String(corps.length));
    res.end(corps);
    return "build_absent";
  }

  async #lire(racineReelle: string, abs: string): Promise<EnCache | null> {
    let reel: string;
    let st: fs.Stats;
    try {
      reel = await fsp.realpath(abs);
      if (!reel.startsWith(racineReelle + path.sep)) return null;
      st = await fsp.stat(reel);
    } catch {
      return null;
    }
    if (!st.isFile() || st.size > 32 * 1024 * 1024) return null;
    const cle = `${st.mtimeMs}:${st.size}:${st.ino}`;
    const c = this.#cache.get(reel);
    if (c && c.cle === cle) return c;
    const brut = await fsp.readFile(reel);
    const e: EnCache = { cle, brut, etag: `"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"` };
    if (c) this.#octets -= c.brut.length + (c.br?.length ?? 0) + (c.gz?.length ?? 0);
    if (this.#octets + brut.length > this.#max) { this.#cache.clear(); this.#octets = 0; }
    this.#cache.set(reel, e);
    this.#octets += brut.length;
    return e;
  }

  #envoyer(req: IncomingMessage, res: ServerResponse, e: EnCache, type: string, ext: string, cache: string, extra: Record<string, string>): void {
    res.setHeader("Content-Type", type);
    res.setHeader("Cache-Control", cache);
    res.setHeader("ETag", e.etag);
    for (const [k, v] of Object.entries(extra)) res.setHeader(k, v);
    const compressible = COMPRESSIBLES.has(ext) && e.brut.length > 1024;
    if (compressible) res.setHeader("Vary", "Accept-Encoding");
    const inm = req.headers["if-none-match"];
    if (typeof inm === "string" && inm.split(",").some((x) => x.trim().replace(/^W\//, "") === e.etag)) {
      res.statusCode = 304;
      res.end();
      return;
    }
    let corps = e.brut;
    if (compressible) {
      const ae = String(req.headers["accept-encoding"] ?? "");
      if (/\bbr\b/.test(ae)) {
        if (!e.br) {
          e.br = zlib.brotliCompressSync(e.brut, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: e.brut.length } });
          this.#octets += e.br.length;
        }
        corps = e.br;
        res.setHeader("Content-Encoding", "br");
      } else if (/\bgzip\b/.test(ae)) {
        if (!e.gz) {
          e.gz = zlib.gzipSync(e.brut, { level: 9 });
          this.#octets += e.gz.length;
        }
        corps = e.gz;
        res.setHeader("Content-Encoding", "gzip");
      }
    }
    res.statusCode = 200;
    res.setHeader("Content-Length", String(corps.length));
    res.end(corps);
  }
}
