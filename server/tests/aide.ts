// Carnet · banc de test : copie temporaire de l'espace de test (fixtures/espace, jamais l'original) + pièges, serveur sur un port libre.
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { creerApplication } from "../src/app.ts";
import type { Application } from "../src/app.ts";
import { lireConfig } from "../src/config.ts";

// Le journal JSONL du serveur est coupé pendant les tests (CARNET_JOURNAL=0), sauf demande contraire.
process.env.CARNET_JOURNAL ??= "0";

/** Espace de test neutre livré avec les tests (jamais modifié : le banc en travaille une copie). */
export const ESPACE_TEST = ["fixtures/espace", "../fixtures/espace"]
  .map((rel) => path.resolve(import.meta.dirname, rel))
  .find((p) => fs.existsSync(p)) ?? path.resolve(import.meta.dirname, "fixtures/espace");
export const HOTE = "carnet.test";
export const LOGIN = "ami@exemple.test";
/** Dossiers de premier niveau masqués par le banc (CARNET_MASQUES) ; ils sont créés par preparerEspace. */
export const MASQUES = ["Privé", "bruts"];

export interface Reponse {
  statut: number;
  entetes: http.IncomingHttpHeaders;
  corps: Buffer;
  texte: string;
  json: any;
}

export interface Banc {
  app: Application;
  port: number;
  racine: string;
  espace: string;
  etat: string;
  cle: string;
  req(methode: string, chemin: string, opts?: { entetes?: Record<string, string | undefined>; corps?: unknown; brut?: Buffer }): Promise<Reponse>;
  fermer(): Promise<void>;
}

/** Copie l'espace de test (fichiers ≤ 1 Mo, liens gardés tels quels) dans un dossier temporaire, puis ajoute les pièges. */
export async function preparerEspace(racine: string): Promise<string> {
  const esp = path.join(racine, "espace");
  await fsp.cp(ESPACE_TEST, esp, {
    recursive: true,
    verbatimSymlinks: true,
    filter: async (src) => {
      const st = await fsp.lstat(src);
      return st.isSymbolicLink() || st.isDirectory() || st.size <= 1024 * 1024;
    },
  });
  const ecrire = async (rel: string, contenu: string | Buffer) => {
    const p = path.join(esp, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, contenu);
  };
  await ecrire(".git/config", "[core]\n\tsecret = zorglubinterdit\n");
  await ecrire(".corbeille/ancienne.md", "# Ancienne\nzorglubinterdit\n");
  await ecrire("bruts/session.md", "# Notes brutes\nzorglubinterdit\n");
  await ecrire("Privé/Cachée.md", "# Cachée\nzorglubinterdit\n");
  await ecrire("Privé/Atelier/Coffre.md", "# Coffre\nzorglubinterdit\n");
  await ecrire("Démo/.brouillon.md", "# Brouillon\nzorglubinterdit\n");
  await ecrire("Démo/_assets/note.md", "# Note\nzorglubinterdit\n");
  await ecrire("piege.html", "<script>alert(1)</script>");
  await ecrire("piege.svg", "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
  await ecrire("piege.js", "alert(1)");
  await ecrire("faux.png", "<html><script>alert(1)</script></html>");
  await ecrire("Dossier seul/Enfant.md", "# Enfant\n");
  await fsp.symlink("/etc/hostname", path.join(esp, "lien-sortant.md"));
  await fsp.symlink(".git/config", path.join(esp, "lien-git.md"));
  await fsp.symlink("artefacts/2026-10-01-tableau-de-bord/index.html", path.join(esp, "lien-art.md"));
  await fsp.symlink("Privé/Atelier/Coffre.md", path.join(esp, "lien-prive.md"));
  await fsp.symlink("Démo/To-do.md", path.join(esp, "lien-ok.md"));
  await fsp.symlink("Démo", path.join(esp, "dossier-lie"));
  await fsp.symlink("/etc", path.join(esp, "etc-lie"));
  // artefact piégé : lien qui sort du dossier de l'artefact
  await fsp.mkdir(path.join(esp, "artefacts/2026-10-08-piege"), { recursive: true });
  await fsp.writeFile(path.join(esp, "artefacts/2026-10-08-piege/index.html"), "<title>Piège &amp; test</title>");
  await fsp.symlink("../2026-10-01-tableau-de-bord/index.html", path.join(esp, "artefacts/2026-10-08-piege/autre.html"));
  await fsp.symlink("/etc/hostname", path.join(esp, "artefacts/2026-10-08-piege/hote.html"));
  return esp;
}

export async function demarrerBanc(opts: {
  env?: Record<string, string>; surveiller?: boolean; cle?: string;
  /** Appelé après la copie de l'espace et avant le démarrage (ex. créer un dépôt git dans `racine`). */
  preparer?: (racine: string, espace: string) => Promise<void> | void;
} = {}): Promise<Banc> {
  const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "carnet-test-"));
  const espace = await preparerEspace(racine);
  if (opts.preparer) await opts.preparer(racine, espace);
  const etat = path.join(racine, "etat");
  let cle = opts.cle ?? path.join(racine, "art-hmac.key");
  if (!opts.cle) await fsp.writeFile(cle, crypto.randomBytes(32).toString("hex") + "\n", { mode: 0o600 });
  const dist = path.join(racine, "dist");
  await fsp.mkdir(path.join(dist, "assets"), { recursive: true });
  await fsp.writeFile(path.join(dist, "index.html"), "<!doctype html><title>Carnet</title><div id=app></div>");
  await fsp.writeFile(path.join(dist, "assets/app-abc123.js"), "console.log('carnet');\n".repeat(200));
  await fsp.writeFile(path.join(dist, "sw.js"), "self.addEventListener('fetch', () => {});\n");
  await fsp.writeFile(path.join(dist, "manifest.webmanifest"), '{"name":"Carnet"}');
  const cfg = lireConfig({
    CARNET_ESPACE: espace,
    CARNET_PORT: "0",
    CARNET_HOTE: "127.0.0.1",
    CARNET_STATIQUE: dist,
    CARNET_UTILISATEURS_AUTORISES: LOGIN,
    CARNET_ORIGINES_ARTEFACTS: `http://${HOTE}=http://art.test https://carnet.ts.net:8447=https://carnet.ts.net:8446`,
    CARNET_MASQUES: MASQUES.join(" "),
    CARNET_MENTIONS: "@camille",
    CARNET_CLE: cle,
    CARNET_ETAT: etat,
    CARNET_REGROUPEMENT_MS: "60",
    ...(opts.env ?? {}),
  });
  const app = await creerApplication(cfg, { surveiller: opts.surveiller ?? false });
  const port = await app.demarrer();
  return {
    app, port, racine, espace, etat, cle,
    req: (methode, chemin, o = {}) => requete(port, methode, chemin, o),
    fermer: async () => {
      await app.arreter();
      await fsp.rm(racine, { recursive: true, force: true });
    },
  };
}

export function requete(port: number, methode: string, chemin: string, o: { entetes?: Record<string, string | undefined>; corps?: unknown; brut?: Buffer } = {}): Promise<Reponse> {
  const entetes: Record<string, string> = { Host: HOTE, "Tailscale-User-Login": LOGIN };
  let corps: Buffer | undefined = o.brut;
  if (o.corps !== undefined) {
    corps = Buffer.from(JSON.stringify(o.corps));
    entetes["Content-Type"] = "application/json";
  }
  if (methode !== "GET" && methode !== "HEAD") entetes["X-Carnet"] = "1";
  for (const [k, v] of Object.entries(o.entetes ?? {})) {
    const cleExistante = Object.keys(entetes).find((x) => x.toLowerCase() === k.toLowerCase());
    if (cleExistante) delete entetes[cleExistante];
    if (v !== undefined) entetes[k] = v;
  }
  if (corps) entetes["Content-Length"] = String(corps.length);
  return new Promise((ok, ko) => {
    const r = http.request({ host: "127.0.0.1", port, method: methode, path: chemin, headers: entetes, setHost: false }, (res) => {
      const morceaux: Buffer[] = [];
      res.on("data", (m: Buffer) => morceaux.push(m));
      res.on("end", () => {
        const b = Buffer.concat(morceaux);
        const t = b.toString("utf8");
        let j: unknown = undefined;
        if (String(res.headers["content-type"] ?? "").startsWith("application/json")) {
          try { j = JSON.parse(t); } catch { /* */ }
        }
        ok({ statut: res.statusCode ?? 0, entetes: res.headers, corps: b, texte: t, json: j });
      });
      res.on("error", ko);
    });
    r.on("error", ko);
    if (corps) r.write(corps);
    r.end();
  });
}

export function q(chemin: string): string {
  return encodeURIComponent(chemin);
}

export function sha16(s: string | Buffer): string {
  return `"${crypto.createHash("sha256").update(s).digest("hex").slice(0, 16)}"`;
}

export function attendre(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Ouvre un flux SSE ; renvoie les événements reçus au fil de l'eau. */
export function ouvrirSse(port: number, entetes: Record<string, string> = {}): Promise<{ evenements: any[]; statut: number; entetes: http.IncomingHttpHeaders; fermer(): void; attendre(pred: (e: any) => boolean, ms: number): Promise<any> }> {
  return new Promise((ok, ko) => {
    const r = http.request({ host: "127.0.0.1", port, method: "GET", path: "/api/evenements", headers: { Host: HOTE, "Tailscale-User-Login": LOGIN, ...entetes }, setHost: false }, (res) => {
      const evenements: any[] = [];
      const attentes: { pred: (e: any) => boolean; ok: (e: any) => void }[] = [];
      let tampon = "";
      res.setEncoding("utf8");
      res.on("data", (m: string) => {
        tampon += m;
        let i;
        while ((i = tampon.indexOf("\n\n")) !== -1) {
          const bloc = tampon.slice(0, i);
          tampon = tampon.slice(i + 2);
          for (const l of bloc.split("\n")) {
            if (!l.startsWith("data: ")) continue;
            const e = JSON.parse(l.slice(6));
            e._t = Date.now();
            evenements.push(e);
            for (const a of [...attentes]) if (a.pred(e)) { attentes.splice(attentes.indexOf(a), 1); a.ok(e); }
          }
        }
      });
      ok({
        evenements,
        statut: res.statusCode ?? 0,
        entetes: res.headers,
        fermer: () => { r.destroy(); },
        attendre: (pred, ms) => new Promise((ok2, ko2) => {
          const deja = evenements.find(pred);
          if (deja) return ok2(deja);
          const t = setTimeout(() => ko2(new Error("événement SSE non reçu à temps")), ms);
          attentes.push({ pred, ok: (e) => { clearTimeout(t); ok2(e); } });
        }),
      });
    });
    r.on("error", ko);
    r.end();
  });
}

export function lsTmp(dossier: string): string[] {
  return fs.readdirSync(dossier).filter((n) => n.includes(".carnet-") && n.endsWith(".tmp"));
}
