// Carnet · tests des événements en direct (SSE) et de la surveillance du disque.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { attendre, demarrerBanc, ouvrirSse, q, requete, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
before(async () => { b = await demarrerBanc({ surveiller: true }); });
after(async () => { await b.fermer(); });

const abs = (rel: string) => path.join(b.espace, rel);

describe("SSE", () => {
  test("en-têtes du flux", async () => {
    const s = await ouvrirSse(b.port);
    s.fermer();
    assert.equal(s.statut, 200);
    assert.equal(s.entetes["content-type"], "text/event-stream; charset=utf-8");
    assert.equal(s.entetes["cache-control"], "no-store");
    assert.equal(s.entetes["x-accel-buffering"], "no");
    assert.ok(String(s.entetes["content-security-policy"]).startsWith("default-src 'self'"));
  });

  test("écriture externe (non atomique) : « modif » avec le bon etag en moins d'1 s", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      const nouveau = fs.readFileSync(abs("Démo/To-do.md"), "utf8") + "\n- [ ] Écrit par un agent\n";
      const t0 = Date.now();
      fs.writeFileSync(abs("Démo/To-do.md"), nouveau);
      const e = await s.attendre((x) => x.type === "modif" && x.chemin === "Démo/To-do.md" && x.etag === sha16(nouveau), 1000);
      assert.ok(e._t - t0 < 1000, `${e._t - t0} ms`);
      assert.deepEqual(Object.keys(e).filter((k) => k !== "_t").sort(), ["chemin", "etag", "type"]);
    } finally {
      s.fermer();
    }
  });

  test("écriture externe atomique (temporaire caché + rename) : un seul « modif »", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      const nouveau = "# Page riche réécrite\n\nPar un agent.\n";
      const tmp = abs("Démo/.Page riche.md.agent.tmp");
      fs.writeFileSync(tmp, nouveau);
      fs.renameSync(tmp, abs("Démo/Page riche.md"));
      await s.attendre((x) => x.type === "modif" && x.chemin === "Démo/Page riche.md" && x.etag === sha16(nouveau), 1000);
      await attendre(300);
      assert.equal(s.evenements.filter((x) => x.type === "modif" && x.chemin === "Démo/Page riche.md").length, 1);
      // le titre a changé (H1) : l'arbre aussi
      assert.ok(s.evenements.some((x) => x.type === "arbre"));
    } finally {
      s.fermer();
    }
  });

  test("création externe d'une page, d'un dossier : « arbre » ; le nouveau dossier est surveillé", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      const v0 = JSON.parse((await b.req("GET", "/api/arbre")).texte).version;
      fs.mkdirSync(abs("Nouveau/Profond"), { recursive: true });
      fs.writeFileSync(abs("Nouveau/Profond/Page.md"), "# Page\n");
      const e = await s.attendre((x) => x.type === "arbre" && x.version > v0, 1000);
      const arbre = await b.req("GET", "/api/arbre");
      assert.ok(arbre.json.version >= e.version);
      assert.ok(arbre.texte.includes('"chemin":"Nouveau/Profond/Page.md"'));
      await attendre(150);
      fs.writeFileSync(abs("Nouveau/Profond/Page.md"), "# Page\n\nmodifiée\n");
      await s.attendre((x) => x.type === "modif" && x.chemin === "Nouveau/Profond/Page.md" && x.etag === sha16("# Page\n\nmodifiée\n"), 1000);
    } finally {
      s.fermer();
    }
  });

  test("dossier supprimé puis recréé aussitôt sous le même nom : toujours surveillé", async () => {
    const s = await ouvrirSse(b.port);
    try {
      fs.mkdirSync(abs("Phenix"));
      fs.writeFileSync(abs("Phenix/A.md"), "# A\n");
      await s.attendre((x) => x.type === "arbre", 1000);
      await attendre(300);
      fs.rmSync(abs("Phenix"), { recursive: true });
      fs.mkdirSync(abs("Phenix"));
      fs.writeFileSync(abs("Phenix/B.md"), "# B\n");
      await attendre(400);
      const contenu = "# B\n\nmodifiée dans le dossier recréé\n";
      const tmp = abs("Phenix/.B.md.tmp");
      fs.writeFileSync(tmp, contenu);
      fs.renameSync(tmp, abs("Phenix/B.md"));
      await s.attendre((x) => x.type === "modif" && x.chemin === "Phenix/B.md" && x.etag === sha16(contenu), 1500);
    } finally {
      s.fermer();
    }
  });

  test("renommage externe d'un dossier : « arbre », anciens chemins retirés", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      fs.renameSync(abs("Nouveau"), abs("Renommé"));
      await s.attendre((x) => x.type === "arbre", 1000);
      await attendre(200);
      const arbre = await b.req("GET", "/api/arbre");
      assert.ok(arbre.texte.includes('"chemin":"Renommé/Profond/Page.md"'));
      assert.ok(!arbre.texte.includes('"chemin":"Nouveau/'));
      const n = s.evenements.length;
      fs.rmSync(abs("Renommé"), { recursive: true });
      await s.attendre((x) => x.type === "arbre" && s.evenements.indexOf(x) >= n, 1000);
    } finally {
      s.fermer();
    }
  });

  test("fichiers cachés, .git, dossiers masqués, artefacts : aucun événement", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      fs.writeFileSync(abs("Démo/.temporaire.tmp"), "x");
      fs.writeFileSync(abs(".git/HEAD"), "ref: refs/heads/main\n");
      fs.writeFileSync(abs("bruts/nouvelle.md"), "# x\n");
      fs.writeFileSync(abs("artefacts/2026-10-08-piege/nouveau.md"), "# x\n");
      fs.writeFileSync(abs("Démo/_assets/nouveau.png"), "x");
      await attendre(400);
      assert.deepEqual(s.evenements, []);
    } finally {
      s.fermer();
    }
  });

  test("écriture par l'API : « modif » diffusé aux autres onglets", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      const lu = await b.req("GET", "/api/page?chemin=" + q("Démo/Réunions.md"));
      const nouveau = lu.json.contenu + "\nAjout API\n";
      const r = await b.req("PUT", "/api/page?chemin=" + q("Démo/Réunions.md"), { corps: { contenu: nouveau }, entetes: { "If-Match": lu.json.etag } });
      assert.equal(r.statut, 200);
      await s.attendre((x) => x.type === "modif" && x.chemin === "Démo/Réunions.md" && x.etag === r.json.etag, 500);
      await attendre(300); // l'événement disque qui suit ne doit pas produire de doublon
      assert.equal(s.evenements.filter((x) => x.type === "modif" && x.chemin === "Démo/Réunions.md").length, 1);
    } finally {
      s.fermer();
    }
  });

  test("rebalayage de sécurité : rattrape un changement non signalé", async () => {
    const d = await demarrerBanc({ surveiller: false });
    try {
      const nouveau = "# To-do\n\nchangé sans surveillance\n";
      fs.writeFileSync(path.join(d.espace, "Démo/To-do.md"), nouveau);
      fs.writeFileSync(path.join(d.espace, "Démo/Nouvelle.md"), "# Nouvelle\n");
      const ch = await d.app.espace.balayerTout();
      assert.equal(ch.modifs.get("Démo/To-do.md"), sha16(nouveau));
      assert.equal(ch.arbre, true);
      assert.ok(d.app.espace.pages.has("Démo/Nouvelle.md"));
    } finally {
      await d.fermer();
    }
  });

  test("plafond de connexions SSE : 503 au-delà", async () => {
    const d = await demarrerBanc({ env: { CARNET_MAX_SSE: "2" } });
    try {
      const a = await ouvrirSse(d.port);
      const c = await ouvrirSse(d.port);
      const r = await requete(d.port, "GET", "/api/evenements");
      assert.equal(r.statut, 503);
      a.fermer();
      c.fermer();
      await attendre(100);
      const e = await ouvrirSse(d.port);
      assert.equal(e.statut, 200);
      e.fermer();
    } finally {
      await d.fermer();
    }
  });
});
