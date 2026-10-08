// Carnet · tests de /_art : jeton calculé aussi indépendamment (node:crypto) et, si le serveur d'artefacts (art.py) est
// disponible, en Python ; refus ; contrôle contre un vrai serveur d'artefacts quand il est configuré (variables CARNET_TEST_ART_*).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc } from "./aide.ts";
import type { Banc } from "./aide.ts";

const ART = "2026-10-01-tableau-de-bord";
const SPECIAL = "2026-10-08 démo (spéciale)!";
const SPECIAL_ENCODE = "2026-10-08%20d%C3%A9mo%20%28sp%C3%A9ciale%29%21/sous%20dossier/donn%C3%A9es%20~%2A%27.html";

/** Dossier d'art.py : premier candidat existant (dépôt d'origine, puis dépôt publié). Undefined : tests croisés sautés. */
const ART_PY = ["../../../deploy/art/app", "../../artefacts/app"]
  .map((rel) => path.resolve(import.meta.dirname, rel))
  .find((d) => fs.existsSync(path.join(d, "art.py")));

function pythonDisponible(): boolean {
  try { execFileSync("python3", ["--version"], { stdio: "ignore" }); return true; } catch { return false; }
}
const RAISON_SANS_PYTHON = !ART_PY ? "art.py introuvable (deploy/art/app, artefacts/app)" : !pythonDisponible() ? "python3 introuvable" : undefined;

/** Calcule en Python (fonctions de art.py) : mac(clé, exp, portée) et quote(chemin, safe="/"). */
function python(cleFichier: string, exp: number, portee: string, chemin: string): { mac: string; quote: string } {
  const code = [
    "import json, sys",
    "sys.path.insert(0, sys.argv[1])",
    "import art",
    "from urllib.parse import quote",
    "cle = bytes.fromhex(open(sys.argv[2]).read().strip())",
    "print(json.dumps({'mac': art.mac(cle, int(sys.argv[3]), sys.argv[4]), 'quote': quote(sys.argv[5], safe='/')}))",
  ].join("\n");
  return JSON.parse(execFileSync("python3", ["-c", code, ART_PY!, cleFichier, String(exp), portee, chemin], { encoding: "utf8" }));
}

function get(url: string): Promise<{ statut: number; type: string }> {
  return new Promise((ok, ko) => {
    http.get(url, (res) => { res.resume(); res.on("end", () => ok({ statut: res.statusCode ?? 0, type: String(res.headers["content-type"]) })); }).on("error", ko);
  });
}

let b: Banc;
before(async () => {
  b = await demarrerBanc();
  const d = path.join(b.espace, "artefacts", SPECIAL);
  fs.mkdirSync(path.join(d, "sous dossier"), { recursive: true });
  fs.writeFileSync(path.join(d, "index.html"), "<title>Spéciale</title>");
  fs.writeFileSync(path.join(d, "sous dossier/données ~*'.html"), "x");
  fs.writeFileSync(path.join(b.espace, "artefacts/2026-10-08-piege/gros.html"), Buffer.alloc(5 * 1024 * 1024 + 1));
});
after(async () => { await b.fermer(); });

const art = (brut: string, entetes: Record<string, string | undefined> = {}) => b.req("GET", "/_art/" + brut, { entetes });

describe("/_art", () => {
  /** Cas de la table : [chemin demandé (brut), chemin signé (portée = premier segment)]. */
  const CAS: [string, string][] = [
    [`${ART}/index.html`, `${ART}/index.html`],
    [`${ART}/`, `${ART}/index.html`],
    [ART, `${ART}/index.html`],
    [encodeURIComponent(SPECIAL) + "/" + encodeURIComponent("sous dossier") + "/" + encodeURIComponent("données ~*'.html"), `${SPECIAL}/sous dossier/données ~*'.html`],
  ];

  test("302 vers <base>/a/<exp>.<hmac>/<chemin> : jeton recalculé avec node:crypto, chemin encodé à la Python", async () => {
    const cle = Buffer.from(fs.readFileSync(b.cle, "ascii").trim(), "hex");
    for (const [brut, finaux] of CAS) {
      const avant = Math.floor(Date.now() / 1000);
      const r = await art(brut);
      assert.equal(r.statut, 302, brut);
      assert.equal(r.entetes["cache-control"], "no-store");
      const m = /^http:\/\/art\.test\/a\/(\d+)\.([A-Za-z0-9_-]{43})\/(.+)$/.exec(String(r.entetes.location));
      assert.ok(m, String(r.entetes.location));
      const exp = Number(m[1]);
      assert.ok(exp >= avant + 900 && exp <= avant + 902, "exp = maintenant + 900");
      assert.equal(m[2], crypto.createHmac("sha256", cle).update(`${exp}/${finaux.split("/")[0]}`, "utf8").digest("base64url"), "HMAC de « exp/portée »");
      if (finaux.startsWith(SPECIAL)) assert.equal(m[3], SPECIAL_ENCODE, "caractères réservés encodés comme quote(safe='/')");
      else assert.equal(m[3], finaux);
    }
  });
  test("jeton et encodage identiques à art.py (clé jetable)", { skip: RAISON_SANS_PYTHON }, async () => {
    for (const [brut, finaux] of CAS) {
      const r = await art(brut);
      assert.equal(r.statut, 302, brut);
      const m = /^http:\/\/art\.test\/a\/(\d+)\.([A-Za-z0-9_-]{43})\/(.+)$/.exec(String(r.entetes.location));
      assert.ok(m, String(r.entetes.location));
      const py = python(b.cle, Number(m[1]), finaux.split("/")[0], finaux);
      assert.equal(m[2], py.mac, "HMAC identique à art.mac()");
      assert.equal(m[3], py.quote, "chemin encodé comme quote(safe='/')");
    }
  });
  test("base choisie d'après le Host (Tailscale)", async () => {
    const r = await art(`${ART}/index.html`, { Host: "carnet.ts.net:8447" });
    assert.match(String(r.entetes.location), /^https:\/\/carnet\.ts\.net:8446\/a\//);
  });
  test("refus : traversées, cachés, contrôles, encodage invalide, liens hors du dossier, trop gros", async () => {
    const cas: [string, number][] = [
      ["../secrets/x", 403], ["%2e%2e/x", 403], [`${ART}/../2026-10-08-piege/index.html`, 403],
      [".cache/index.html", 403], [`${ART}/.env`, 403], ["a%00b", 403], ["a%5cb", 403], ["%ff%fe", 403],
      ["a//b", 403], ["", 404], ["inexistant/index.html", 404],
      ["2026-10-08-piege/autre.html", 403], ["2026-10-08-piege/hote.html", 403], ["2026-10-08-piege/gros.html", 413],
      [Array(17).fill("a").join("/"), 403], ["x".repeat(1100), 403],
    ];
    for (const [brut, attendu] of cas) {
      const r = await art(brut);
      assert.equal(r.statut, attendu, `/_art/${brut.slice(0, 50)} -> ${r.statut}`);
      assert.equal(r.entetes.location, undefined);
    }
  });
  test("identité, intersite, méthode", async () => {
    assert.equal((await art(`${ART}/`, { "Tailscale-User-Login": undefined })).statut, 403);
    assert.equal((await art(`${ART}/`, { "Sec-Fetch-Site": "cross-site" })).statut, 403);
    assert.equal((await art(`${ART}/`, { Host: "evil.com" })).statut, 421);
    const p = await b.req("POST", `/_art/${ART}/`);
    assert.equal(p.statut, 405);
  });

  // Test d'intégration facultatif : un vrai serveur d'artefacts qui sert le même dossier artefacts/ que l'espace de test.
  //   CARNET_TEST_ART_CLE = fichier de la clé HMAC de ce serveur ; CARNET_TEST_ART_URL = sa base (défaut http://127.0.0.1:3006).
  test("un vrai serveur d'artefacts accepte le jeton, refuse un jeton altéré", async (t) => {
    const fichierCle = process.env.CARNET_TEST_ART_CLE;
    const base = (process.env.CARNET_TEST_ART_URL || "http://127.0.0.1:3006").replace(/\/+$/, "");
    if (!fichierCle) {
      t.skip("CARNET_TEST_ART_CLE non définie");
      return;
    }
    let lisible = false;
    try { fs.accessSync(fichierCle, fs.constants.R_OK); lisible = true; } catch { /* */ }
    const vivant = await get(`${base}/sante`).then((r) => r.statut === 200, () => false);
    if (!lisible || !vivant) {
      t.skip(`serveur d'artefacts ${vivant ? "joignable" : "injoignable"}, clé ${lisible ? "lisible" : "illisible"}`);
      return;
    }
    const d = await demarrerBanc({ cle: fichierCle, env: { CARNET_ORIGINES_ARTEFACTS: `http://carnet.test=${base}` } });
    try {
      const r = await d.req("GET", `/_art/${ART}/index.html`);
      assert.equal(r.statut, 302);
      const lien = String(r.entetes.location);
      assert.ok(lien.startsWith(`${base}/a/`), lien);
      const ok = await get(lien);
      assert.equal(ok.statut, 200);
      assert.match(ok.type, /^text\/html/);
      const m = /\/a\/(\d+)\.([A-Za-z0-9_-])/.exec(lien)!;
      const autre = m[2] === "A" ? "B" : "A";
      const altere = lien.replace(`/a/${m[1]}.${m[2]}`, `/a/${m[1]}.${autre}`);
      assert.equal((await get(altere)).statut, 403);
      const expAltere = lien.replace(`/a/${m[1]}.`, `/a/${Number(m[1]) + 1}.`);
      assert.equal((await get(expAltere)).statut, 403);
    } finally {
      await d.fermer();
    }
  });
});
