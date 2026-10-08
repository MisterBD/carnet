// Carnet · tests de la corbeille : suppression avec meta, liste, restauration (même place, nom pris, parent disparu),
// suppression définitive, vidage, aperçu, purge, éléments anciens sans meta, metas et liens piégés, CSRF.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, LOGIN, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

const disque = (rel: string) => path.join(b.espace, rel);
const lireDisque = (rel: string) => fs.readFileSync(disque(rel), "utf8");
const ecrire = async (rel: string, contenu: string) => {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
  await b.app.espace.traiter([rel.split("/")[0]]);
};
const supprimer = async (chemin: string) => {
  const r = await b.req("POST", "/api/supprimer", { corps: { chemin } });
  assert.equal(r.statut, 200, r.texte);
  return r.json;
};
const liste = async () => (await b.req("GET", "/api/corbeille")).json;

describe("suppression et liste", () => {
  test("supprimer écrit .meta.json (chemin, titre, icône, date, sous-pages, login)", async () => {
    await ecrire("Corb/Chantier.md", "---\nicon: 🧱\n---\n# Mon chantier\n\nTexte.\n");
    await ecrire("Corb/Chantier/Étape 1.md", "# Étape 1\n");
    await ecrire("Corb/Chantier/Étape 2.md", "# Étape 2\n");
    const r = await supprimer("Corb/Chantier.md");
    assert.match(r.id, /^\d{8}-\d{6}-[0-9a-f]{4}$/);
    assert.equal(r.titre, "Mon chantier");
    const meta = JSON.parse(fs.readFileSync(disque(`.corbeille/${r.id}/.meta.json`), "utf8"));
    assert.equal(meta.version, 1);
    assert.equal(meta.chemin, "Corb/Chantier.md");
    assert.equal(meta.titre, "Mon chantier");
    assert.equal(meta.icone, "🧱");
    assert.equal(meta.sousPages, 2);
    assert.equal(meta.login, LOGIN);
    assert.ok(Math.abs(Date.parse(meta.date) - Date.now()) < 60_000);
    assert.ok(!fs.existsSync(disque("Corb/Chantier.md")));
    assert.ok(fs.existsSync(disque(`.corbeille/${r.id}/Corb/Chantier/Étape 1.md`)));
  });
  test("GET /api/corbeille : éléments, plus récent d'abord, jours", async () => {
    const r1 = await (async () => { await ecrire("Corb/Vieux.md", "# Vieux\n"); return supprimer("Corb/Vieux.md"); })();
    const l = await liste();
    assert.equal(l.jours, 30);
    assert.ok(l.elements.length >= 2);
    const e = l.elements.find((x: any) => x.id === r1.id);
    assert.deepEqual(Object.keys(e).sort(), ["chemin", "date", "existe", "icone", "id", "sousPages", "titre"]);
    assert.equal(e.chemin, "Corb/Vieux.md");
    assert.equal(e.titre, "Vieux");
    assert.equal(e.existe, false);
    for (let i = 1; i < l.elements.length; i++) assert.ok(l.elements[i - 1].date >= l.elements[i].date);
    // le fichier « .corbeille/ancienne.md » du banc (pas un dossier) n'est pas un élément
    assert.ok(!l.elements.some((x: any) => x.id === "ancienne.md"));
  });
  test("la corbeille n'est jamais servie : page, fichier, recherche, arbre", async () => {
    const { elements } = await liste();
    const id = elements[0].id;
    for (const c of [`.corbeille/${id}/Corb/Vieux.md`, `.corbeille/${id}/.meta.json`, ".corbeille/ancienne.md"]) {
      const p = await b.req("GET", "/api/page?chemin=" + q(c));
      assert.equal(p.statut, 403, c);
      const f = await b.req("GET", "/api/fichier?chemin=" + q(c));
      assert.equal(f.statut, 403, c);
    }
    const a = await b.req("GET", "/api/arbre");
    assert.ok(!a.texte.includes(".corbeille"));
    assert.ok(!a.texte.includes(".carnet"));
    const s = await b.req("GET", "/api/recherche?q=zorglubinterdit");
    assert.deepEqual(s.json.resultats, []);
  });
});

describe("restauration", () => {
  test("à sa place : X.md et X/ reviennent, l'élément disparaît, l'arbre suit", async () => {
    const l = await liste();
    const e = l.elements.find((x: any) => x.chemin === "Corb/Chantier.md");
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: e.id } });
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(r.json, { chemin: "Corb/Chantier.md", renomme: false });
    assert.match(lireDisque("Corb/Chantier.md"), /# Mon chantier/);
    assert.ok(fs.existsSync(disque("Corb/Chantier/Étape 2.md")));
    assert.ok(!fs.existsSync(disque(`.corbeille/${e.id}`)));
    const a = await b.req("GET", "/api/arbre");
    assert.ok(a.texte.includes('"chemin":"Corb/Chantier/Étape 1.md"'));
  });
  test("nom pris : « X (restaurée) », puis « X (restaurée 2) »", async () => {
    await ecrire("Corb/Double.md", "# Double v1\n");
    const s1 = await supprimer("Corb/Double.md");
    await ecrire("Corb/Double.md", "# Double v2\n");
    const s2 = await supprimer("Corb/Double.md");
    await ecrire("Corb/Double.md", "# Double v3\n");
    const r1 = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s1.id } });
    assert.deepEqual(r1.json, { chemin: "Corb/Double (restaurée).md", renomme: true });
    assert.equal(lireDisque("Corb/Double (restaurée).md"), "# Double v1\n");
    const r2 = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s2.id } });
    assert.deepEqual(r2.json, { chemin: "Corb/Double (restaurée 2).md", renomme: true });
    assert.equal(lireDisque("Corb/Double.md"), "# Double v3\n");
  });
  test("parent disparu : dossiers recréés", async () => {
    await ecrire("Parent/Enfant.md", "# Enfant\n");
    const s = await supprimer("Parent/Enfant.md");
    fs.rmSync(disque("Parent"), { recursive: true, force: true });
    await b.app.espace.traiter(["Parent"]);
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s.id } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(lireDisque("Parent/Enfant.md"), "# Enfant\n");
  });
  test("page « dossier » (dossier seul) supprimée puis restaurée", async () => {
    await ecrire("Seul/Dedans.md", "# Dedans\n");
    const s = await supprimer("Seul.md");
    assert.equal(s.corbeille, `.corbeille/${s.id}/Seul`);
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s.id } });
    assert.deepEqual(r.json, { chemin: "Seul.md", renomme: false });
    assert.ok(fs.existsSync(disque("Seul/Dedans.md")));
  });
  test("identifiants invalides : 400 ; inconnu : 404 ; lien symbolique : 403", async () => {
    for (const id of ["../x", "..", ".meta.json", "/etc", "20261008-120000/../..", "abc", "", 12]) {
      const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id } });
      assert.equal(r.statut, 400, String(id));
    }
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: "20990101-000000-ffff" } });
    assert.equal(r.statut, 404);
    fs.symlinkSync("/etc", disque(".corbeille/20990101-000000-aaaa"));
    const l = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: "20990101-000000-aaaa" } });
    assert.equal(l.statut, 403);
    const e = await b.req("POST", "/api/corbeille/effacer", { corps: { id: "20990101-000000-aaaa" } });
    assert.equal(e.statut, 403);
    assert.ok(fs.existsSync("/etc/hostname"));
    fs.unlinkSync(disque(".corbeille/20990101-000000-aaaa"));
  });
  test("meta piégée (traversée, caché, absolu, zone interdite) : refus, rien ne bouge", async () => {
    const pieges = ["../../evade.md", ".git/x.md", "/etc/x.md", "bruts/x.md", "Privé/x.md", "artefacts/x.md", "a/../b.md", "Corb/.cache.md"];
    for (const [i, chemin] of pieges.entries()) {
      const id = `20990102-00000${i}-beef`;
      const el = disque(`.corbeille/${id}`);
      fs.mkdirSync(path.join(el, "Corb"), { recursive: true });
      fs.writeFileSync(path.join(el, "Corb", "Leurre.md"), "# Leurre\n");
      fs.writeFileSync(path.join(el, ".meta.json"), JSON.stringify({ version: 1, chemin, titre: "Leurre" }));
      const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id } });
      assert.ok(r.statut === 400 || r.statut === 403, `${chemin} : ${r.statut}`);
      assert.ok(fs.existsSync(path.join(el, "Corb", "Leurre.md")), chemin);
      const ap = await b.req("GET", "/api/corbeille/apercu?id=" + id);
      assert.ok(ap.statut === 400 || ap.statut === 403, `aperçu ${chemin} : ${ap.statut}`);
      fs.rmSync(el, { recursive: true, force: true });
    }
    assert.ok(!fs.existsSync(path.join(b.espace, "..", "evade.md")));
  });
  test("lien symbolique planté DANS un élément : jamais suivi", async () => {
    const id = "20990103-000000-cafe";
    const el = disque(`.corbeille/${id}`);
    fs.mkdirSync(el, { recursive: true });
    fs.symlinkSync("/etc", path.join(el, "Corb"));
    fs.writeFileSync(path.join(el, ".meta.json"), JSON.stringify({ version: 1, chemin: "Corb/hostname.md", titre: "x" }));
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id } });
    assert.equal(r.statut, 403);
    const ap = await b.req("GET", "/api/corbeille/apercu?id=" + id);
    assert.equal(ap.statut, 403);
    fs.rmSync(el, { recursive: true, force: true });
    // fichier final lien symbolique
    const id2 = "20990103-000001-cafe";
    const el2 = disque(`.corbeille/${id2}`);
    fs.mkdirSync(path.join(el2, "Corb"), { recursive: true });
    fs.symlinkSync("/etc/hostname", path.join(el2, "Corb", "Hote.md"));
    fs.writeFileSync(path.join(el2, ".meta.json"), JSON.stringify({ version: 1, chemin: "Corb/Hote.md", titre: "x" }));
    const r2 = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: id2 } });
    assert.equal(r2.statut, 409);
    const ap2 = await b.req("GET", "/api/corbeille/apercu?id=" + id2);
    assert.equal(ap2.statut, 403);
    assert.ok(!fs.existsSync(disque("Corb/Hote.md")));
    fs.rmSync(el2, { recursive: true, force: true });
  });
});

describe("aperçu, suppression définitive, vidage, anciens éléments", () => {
  test("aperçu : contenu de la page principale ; dossier seul : contenu vide", async () => {
    await ecrire("Corb/Lire.md", "# À lire\n\nBonjour.\n");
    const s = await supprimer("Corb/Lire.md");
    const r = await b.req("GET", "/api/corbeille/apercu?id=" + s.id);
    assert.equal(r.statut, 200);
    assert.deepEqual(r.json, { id: s.id, chemin: "Corb/Lire.md", titre: "À lire", contenu: "# À lire\n\nBonjour.\n" });
    await ecrire("Vide2/a.md", "# a\n");
    const s2 = await supprimer("Vide2.md");
    const r2 = await b.req("GET", "/api/corbeille/apercu?id=" + s2.id);
    assert.equal(r2.json.contenu, "");
    const r3 = await b.req("GET", "/api/corbeille/apercu?id=" + q("../Démo"));
    assert.equal(r3.statut, 400);
  });
  test("ancien élément sans meta (AAAAMMJJ-HHMMSS) : chemin déduit, restaurable", async () => {
    const id = "20260101-101010";
    fs.mkdirSync(disque(`.corbeille/${id}/Ancien/Projet`), { recursive: true });
    fs.writeFileSync(disque(`.corbeille/${id}/Ancien/Projet.md`), "# Projet ancien\n");
    fs.writeFileSync(disque(`.corbeille/${id}/Ancien/Projet/Sous.md`), "# Sous\n");
    const e = (await liste()).elements.find((x: any) => x.id === id);
    assert.equal(e.chemin, "Ancien/Projet.md");
    assert.equal(e.titre, "Projet ancien");
    assert.equal(e.sousPages, 1);
    assert.equal(e.date, new Date(2026, 0, 1, 10, 10, 10).getTime());
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id } });
    assert.deepEqual(r.json, { chemin: "Ancien/Projet.md", renomme: false });
    assert.ok(fs.existsSync(disque("Ancien/Projet/Sous.md")));
  });
  test("effacer : un élément, puis tout ; jamais hors de la corbeille", async () => {
    await ecrire("Corb/Jeter.md", "# Jeter\n");
    const s = await supprimer("Corb/Jeter.md");
    const r = await b.req("POST", "/api/corbeille/effacer", { corps: { id: s.id } });
    assert.deepEqual(r.json, { effaces: 1 });
    assert.ok(!fs.existsSync(disque(`.corbeille/${s.id}`)));
    const r404 = await b.req("POST", "/api/corbeille/effacer", { corps: { id: s.id } });
    assert.equal(r404.statut, 404);
    const avant = (await liste()).elements.length;
    assert.ok(avant >= 1);
    const t = await b.req("POST", "/api/corbeille/effacer", { corps: { tout: true } });
    assert.deepEqual(t.json, { effaces: avant });
    assert.deepEqual((await liste()).elements, []);
    // ce qui n'est pas un élément (fichier du banc) reste
    assert.ok(fs.existsSync(disque(".corbeille/ancienne.md")));
    assert.ok(fs.existsSync(disque("Démo/To-do.md")));
  });
  test("purge : seuls les éléments plus vieux que 30 jours partent", async () => {
    await ecrire("Corb/Recent.md", "# Récent\n");
    const s = await supprimer("Corb/Recent.md");
    const vieux = "20200101-000000-0001";
    fs.mkdirSync(disque(`.corbeille/${vieux}/Corb`), { recursive: true });
    fs.writeFileSync(disque(`.corbeille/${vieux}/Corb/Vieux.md`), "# Vieux\n");
    fs.writeFileSync(disque(`.corbeille/${vieux}/.meta.json`), JSON.stringify({ version: 1, chemin: "Corb/Vieux.md", titre: "Vieux", date: "2020-01-01T00:00:00Z" }));
    const n = await b.app.api.purgerCorbeille(Date.now());
    assert.equal(n, 1);
    assert.ok(!fs.existsSync(disque(`.corbeille/${vieux}`)));
    assert.ok(fs.existsSync(disque(`.corbeille/${s.id}`)));
    // dans 31 jours, le récent part aussi
    assert.equal(await b.app.api.purgerCorbeille(Date.now() + 31 * 24 * 3600 * 1000), 1);
  });
  test("CARNET_CORBEILLE_JOURS=0 : jamais de purge ; config expose jours et git", async () => {
    const d = await demarrerBanc({ env: { CARNET_CORBEILLE_JOURS: "0", CARNET_GIT: "non" } });
    try {
      fs.mkdirSync(path.join(d.espace, ".corbeille/20200101-000000-0002/X"), { recursive: true });
      assert.equal(await d.app.api.purgerCorbeille(Date.now()), 0);
      assert.ok(fs.existsSync(path.join(d.espace, ".corbeille/20200101-000000-0002")));
      const c = await d.req("GET", "/api/config");
      assert.deepEqual(c.json.corbeille, { jours: 0 });
      assert.deepEqual(c.json.historique, { git: false });
    } finally {
      await d.fermer();
    }
  });
  test("anti-CSRF sur les nouvelles mutations", async () => {
    for (const route of ["/api/corbeille/restaurer", "/api/corbeille/effacer", "/api/placer", "/api/dupliquer", "/api/instantane", "/api/restaurer-version"]) {
      const sans = await b.req("POST", route, { corps: { tout: true }, entetes: { "X-Carnet": undefined } });
      assert.equal(sans.statut, 403, route);
      const origine = await b.req("POST", route, { corps: { tout: true }, entetes: { Origin: "http://evil.com" } });
      assert.equal(origine.statut, 403, route);
      const site = await b.req("POST", route, { corps: { tout: true }, entetes: { "Sec-Fetch-Site": "cross-site" } });
      assert.equal(site.statut, 403, route);
    }
    const g = await b.req("GET", "/api/corbeille", { entetes: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(g.statut, 403);
  });
});
