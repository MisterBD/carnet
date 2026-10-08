// Carnet · tests : recherche, accueil, tâches, méta (frontmatter), projets, favoris, artefacts, images et fichiers.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { creerApplication } from "../src/app.ts";
import { lireConfig } from "../src/config.ts";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
before(async () => {
  b = await demarrerBanc();
  const ecrire = (rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(b.espace, rel)), { recursive: true });
    fs.writeFileSync(path.join(b.espace, rel), txt);
  };
  ecrire("Tests/Relire statut.md", "---\nstatut: À relire\n---\n# Relire statut\n\nTexte.\n");
  ecrire("Tests/Mention.md", "# Mention\n\nQuestion pour @Camille : on valide ?\n\n```\n@camille dans le code\n```\n");
  ecrire("Tests/Mention code seulement.md", "# Code\n\n```\n@camille\n```\n`@camille` en ligne aussi\n");
  ecrire("Tests/Taches.md", [
    "---", "tags: [projet]", "statut: en cours", "echeance: 2026-11-01", "responsable: Camille", "pageDecoration:", "  icon: list", "---",
    "# Tâches", "", "- [ ] Première", "* [ ] Deuxième", "+ [ ] Troisième", "1. [ ] Quatrième", "- [x] Faite", "  - [ ] Imbriquée",
    "```", "- [ ] Dans le code", "```", "- [ ]", "",
  ].join("\n"));
  ecrire("Tests/Recherche.md", "# Mémo réunion\n\nLe budget prévisionnel de l'Été dépasse les prévisions : il faut arbitrer avant jeudi avec Sacha.\n");
  await b.app.espace.traiter(["Tests"]);
});
after(async () => { await b.fermer(); });

const lireDisque = (rel: string) => fs.readFileSync(path.join(b.espace, rel), "utf8");

describe("recherche", () => {
  test("insensible à la casse et aux accents, extrait découpé", async () => {
    const r = await b.req("GET", "/api/recherche?q=" + q("ete PREVISIONNEL"));
    assert.equal(r.statut, 200);
    const x = r.json.resultats.find((e: any) => e.chemin === "Tests/Recherche.md");
    assert.ok(x, JSON.stringify(r.json));
    assert.equal(x.titre, "Mémo réunion");
    assert.equal(x.extrait, "prévisionnel");
    assert.ok(x.avant.endsWith("Le budget "), x.avant);
    assert.ok(x.apres.startsWith(" de l'Été dépasse"), x.apres);
    assert.ok((x.avant + x.extrait + x.apres).length <= 140);
  });
  test("plusieurs mots : tous présents", async () => {
    const r = await b.req("GET", "/api/recherche?q=" + q("budget licorne"));
    assert.equal(r.json.resultats.length, 0);
  });
  test("titre > nom > contenu", async () => {
    const r = await b.req("GET", "/api/recherche?q=" + q("reunions"));
    assert.equal(r.json.resultats[0].chemin, "Démo/Réunions.md");
    const r2 = await b.req("GET", "/api/recherche?q=" + q("SACHA") + "&limite=3");
    assert.ok(r2.json.resultats.length >= 1 && r2.json.resultats.length <= 3);
    assert.equal(r2.json.resultats[0].chemin, "Tests/Recherche.md");
  });
  test("q vide : aucun résultat", async () => {
    const r = await b.req("GET", "/api/recherche?q=");
    assert.deepEqual(r.json, { resultats: [] });
  });
  test("pages cachées / interdites jamais trouvées", async () => {
    const r = await b.req("GET", "/api/recherche?q=" + q("zorglubinterdit"));
    assert.equal(r.json.resultats.length, 0);
  });
  test("< 30 ms sur 1000 pages", async () => {
    const racine = await fsp.mkdtemp(path.join(os.tmpdir(), "carnet-perf-"));
    const esp = path.join(racine, "esp");
    const mots = ["projet", "réunion", "budget", "équipe", "client", "facture", "podcast", "épisode", "agent", "modèle", "données", "tableau"];
    for (let i = 0; i < 1000; i++) {
      const d = path.join(esp, `Dossier ${i % 20}`);
      fs.mkdirSync(d, { recursive: true });
      let txt = `---\ntags: [t${i % 7}]\n---\n# Page numéro ${i}\n\n`;
      for (let k = 0; k < 60; k++) txt += mots[(i * 7 + k * 5) % mots.length] + (k % 9 === 0 ? ".\n" : " ");
      txt += `\nMot rare : zéphyr${i}\n`;
      fs.writeFileSync(path.join(d, `Page ${i}.md`), txt);
    }
    const cfg = lireConfig({ CARNET_ESPACE: esp, CARNET_PORT: "0", CARNET_ETAT: path.join(racine, "etat"), CARNET_UTILISATEURS_AUTORISES: "x", CARNET_ORIGINES_ARTEFACTS: "http://perf.test=http://art.test" });
    const app = await creerApplication(cfg, { surveiller: false });
    try {
      assert.equal(app.espace.pages.size, 1000);
      for (const terme of ["budget equipe", "zephyr999", "modele donnees tableau", "e"]) {
        const t0 = performance.now();
        const r = app.espace.rechercher(terme, 30);
        const ms = performance.now() - t0;
        assert.ok(r.length > 0, terme);
        assert.ok(ms < 30, `${terme} : ${ms.toFixed(1)} ms`);
      }
      const t0 = performance.now();
      const arbre = app.espace.arbreJson();
      assert.ok(performance.now() - t0 < 100);
      assert.ok(arbre.length > 1000);
    } finally {
      app.espace.arreter();
      await fsp.rm(racine, { recursive: true, force: true });
    }
  });
});

describe("accueil et tâches", () => {
  test("récents (12), à relire (statut / mention hors code), tâches non cochées hors code", async () => {
    const r = await b.req("GET", "/api/accueil");
    assert.equal(r.statut, 200);
    assert.ok(r.json.recents.length <= 12 && r.json.recents.length > 0);
    for (let i = 1; i < r.json.recents.length; i++) assert.ok(r.json.recents[i - 1].mtime >= r.json.recents[i].mtime);
    const relire = Object.fromEntries(r.json.aRelire.map((x: any) => [x.chemin, x.raisons]));
    assert.deepEqual(relire["Tests/Relire statut.md"], ["statut"]);
    assert.deepEqual(relire["Tests/Mention.md"], ["mention"]);
    assert.equal(relire["Tests/Mention code seulement.md"], undefined);
    const t = r.json.taches.filter((x: any) => x.chemin === "Tests/Taches.md");
    assert.deepEqual(t.map((x: any) => [x.ligne, x.libelle]), [[10, "Première"], [11, "Deuxième"], [12, "Troisième"], [13, "Quatrième"], [15, "Imbriquée"], [19, ""]]);
    assert.equal(t[0].texte, "- [ ] Première");
    assert.equal(t[0].titre, "Tâches");
  });
  test("cocher une tâche : seule la ligne change ; 409 si la ligne a changé", async () => {
    const avant = lireDisque("Tests/Taches.md");
    const r = await b.req("POST", "/api/tache", { corps: { chemin: "Tests/Taches.md", ligne: 11, texte: "* [ ] Deuxième", coche: true } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.texte, "* [x] Deuxième");
    const apres = lireDisque("Tests/Taches.md");
    assert.equal(r.json.etag, sha16(apres));
    const la = avant.split("\n");
    const lb = apres.split("\n");
    assert.equal(la.length, lb.length);
    assert.deepEqual(la.map((l, i) => (l === lb[i] ? null : i)).filter((x) => x !== null), [11]);
    const conflit = await b.req("POST", "/api/tache", { corps: { chemin: "Tests/Taches.md", ligne: 11, texte: "* [ ] Deuxième", coche: true } });
    assert.equal(conflit.statut, 409);
    const decoche = await b.req("POST", "/api/tache", { corps: { chemin: "Tests/Taches.md", ligne: 11, texte: "* [x] Deuxième", coche: false } });
    assert.equal(decoche.json.texte, "* [ ] Deuxième");
    assert.equal(lireDisque("Tests/Taches.md"), avant);
    const code = await b.req("POST", "/api/tache", { corps: { chemin: "Tests/Taches.md", ligne: 17, texte: "- [ ] Dans le code", coche: true } });
    assert.equal(code.statut, 409);
  });
});

describe("méta (frontmatter)", () => {
  test("modifier un champ : une seule ligne change", async () => {
    const avant = lireDisque("Tests/Taches.md");
    const r = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Taches.md", champs: { statut: "à relire" } } });
    assert.equal(r.statut, 200, r.texte);
    const apres = lireDisque("Tests/Taches.md");
    assert.equal(r.json.etag, sha16(apres));
    const la = avant.split("\n");
    const lb = apres.split("\n");
    assert.deepEqual(la.map((l, i) => (l === lb[i] ? null : [l, lb[i]])).filter((x) => x !== null), [["statut: en cours", "statut: à relire"]]);
  });
  test("ajouter, retirer ; If-Match faux : 412 ; clé invalide : 400 ; sans frontmatter : bloc créé", async () => {
    const r = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Taches.md", champs: { priorite: "haute", responsable: null } } });
    assert.equal(r.statut, 200);
    const txt = lireDisque("Tests/Taches.md");
    assert.match(txt, /pageDecoration:\n  icon: list\npriorite: haute\n---\n/);
    assert.ok(!txt.includes("responsable:"));
    const f = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Taches.md", champs: { statut: "x" } }, entetes: { "If-Match": '"ffffffffffffffff"' } });
    assert.equal(f.statut, 412);
    assert.equal(f.json.contenu, txt);
    const c = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Taches.md", champs: { "mauvaise clé": "x" } } });
    assert.equal(c.statut, 400);
    // liste YAML en colonne 0 (« tags:\n- a », style PyYAML) : la clé ET ses items sont remplacés (corrigé dans
    // shared/page.ts) ; le serveur garde sa validation YAML (422) en dernier rempart
    fs.writeFileSync(path.join(b.espace, "Tests/Liste.md"), "---\ntags:\n- projet\n- demo\nstatut: x\n---\n# Liste\n");
    await b.app.espace.traiter(["Tests/Liste.md"]);
    const l = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Liste.md", champs: { tags: "autre" } } });
    assert.equal(l.statut, 200);
    assert.equal(lireDisque("Tests/Liste.md"), "---\ntags: autre\nstatut: x\n---\n# Liste\n");
    const s = await b.req("POST", "/api/meta", { corps: { chemin: "Tests/Recherche.md", champs: { statut: "en cours" } } });
    assert.equal(s.statut, 200);
    assert.ok(lireDisque("Tests/Recherche.md").startsWith("---\nstatut: en cours\n---\n# Mémo réunion\n"));
  });
});

describe("projets et favoris", () => {
  test("projets : par tag « projet » ; par dossier ; méta en chaînes", async () => {
    const r = await b.req("GET", "/api/projets");
    const chemins = r.json.pages.map((p: any) => p.chemin);
    assert.ok(chemins.includes("Tests/Taches.md"));
    assert.ok(chemins.includes("Démo/Projets/Site web.md"));
    const t = r.json.pages.find((p: any) => p.chemin === "Tests/Taches.md");
    assert.equal(t.meta.tags, "projet");
    assert.equal(t.meta.echeance, "2026-11-01");
    assert.equal(t.meta.pageDecoration, undefined);
    assert.equal(t.icone, "list");
    const d = await b.req("GET", "/api/projets?dossier=" + q("Démo/Projets"));
    assert.equal(d.json.pages.length, 3);
    assert.ok(d.json.pages.every((p: any) => p.chemin.startsWith("Démo/Projets/")));
    const interdit = await b.req("GET", "/api/projets?dossier=" + q("Privé"));
    assert.equal(interdit.statut, 403);
  });
  test("favoris : lecture, écriture atomique dans CARNET_ETAT (0600), suivis au renommage", async () => {
    const vide = await b.req("GET", "/api/favoris");
    assert.deepEqual(vide.json, { chemins: [] });
    const w = await b.req("PUT", "/api/favoris", { corps: { chemins: ["Démo/To-do.md", "Démo/Réunions.md", "Démo/To-do.md"] } });
    assert.equal(w.statut, 200);
    assert.deepEqual(w.json.chemins, ["Démo/To-do.md", "Démo/Réunions.md"]);
    const f = path.join(b.etat, "favoris.json");
    assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    assert.equal(fs.statSync(b.etat).mode & 0o777, 0o700);
    const bad = await b.req("PUT", "/api/favoris", { corps: { chemins: ["../x.md"] } });
    assert.equal(bad.statut, 403);
    await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/Réunions.md", nom: "Rendez-vous" } });
    const apres = await b.req("GET", "/api/favoris");
    assert.deepEqual(apres.json.chemins, ["Démo/To-do.md", "Démo/Rendez-vous.md"]);
  });
  test("artefacts : dossiers avec index.html, titre et date", async () => {
    const r = await b.req("GET", "/api/artefacts");
    assert.equal(r.statut, 200);
    const demo = r.json.artefacts.find((a: any) => a.chemin === "2026-10-01-tableau-de-bord/index.html");
    assert.deepEqual(demo, { chemin: "2026-10-01-tableau-de-bord/index.html", titre: "Tableau de bord T3 (démo)", date: "2026-10-01" });
    assert.equal(r.json.artefacts[0].titre, "Piège & test");
  });
});

// PNG 1×1 valide
const PNG = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082", "hex");

describe("images (envoi) et fichiers (lecture)", () => {
  test("envoi PNG : écrit dans <dossier de la page>/_assets/, nom nettoyé + horodatage", async () => {
    const r = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: PNG, entetes: { "Content-Type": "image/png", "X-Nom-Fichier": encodeURIComponent("Photo été (1).PNG") } });
    assert.equal(r.statut, 201, r.texte);
    assert.match(r.json.chemin, /^Démo\/_assets\/photo-ete-1-\d{8}-\d{6}\.png$/);
    assert.equal(r.json.relatif, r.json.chemin.replace("Démo/", ""));
    assert.deepEqual(fs.readFileSync(path.join(b.espace, r.json.chemin)), PNG);
    const r2 = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: PNG, entetes: { "Content-Type": "image/png", "X-Nom-Fichier": encodeURIComponent("Photo été (1).PNG") } });
    assert.notEqual(r2.json.chemin, r.json.chemin);
  });
  test("octets magiques faux : 415 ; SVG : 415 ; > 10 Mo : 413 ; vide : 400", async () => {
    const faux = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: Buffer.from("<html>pas une image</html>"), entetes: { "Content-Type": "image/png" } });
    assert.equal(faux.statut, 415);
    const jpegAnnonce = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: PNG, entetes: { "Content-Type": "image/jpeg" } });
    assert.equal(jpegAnnonce.statut, 415);
    const svg = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'/>"), entetes: { "Content-Type": "image/svg+xml" } });
    assert.equal(svg.statut, 415);
    const gros = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]), entetes: { "Content-Type": "image/png" } });
    assert.equal(gros.statut, 413);
    const vide = await b.req("POST", "/api/images?page=" + q("Démo/To-do.md"), { brut: Buffer.alloc(0), entetes: { "Content-Type": "image/png" } });
    assert.equal(vide.statut, 400);
    const zone = await b.req("POST", "/api/images?page=" + q("artefacts/x.md"), { brut: PNG, entetes: { "Content-Type": "image/png" } });
    assert.equal(zone.statut, 403);
  });
  test("image servie en ligne : type, CSP sandbox, nosniff, ETag, cache, 304", async () => {
    const r = await b.req("GET", "/api/fichier?chemin=" + q("Démo/_assets/mer-matin.webp"));
    assert.equal(r.statut, 200);
    assert.equal(r.entetes["content-type"], "image/webp");
    assert.equal(r.entetes["content-security-policy"], "sandbox; default-src 'none'");
    assert.equal(r.entetes["x-content-type-options"], "nosniff");
    assert.equal(r.entetes["cache-control"], "private, max-age=300");
    assert.ok(r.entetes.etag);
    assert.equal(r.corps.length, fs.statSync(path.join(b.espace, "Démo/_assets/mer-matin.webp")).size);
    const r2 = await b.req("GET", "/api/fichier?chemin=" + q("Démo/_assets/mer-matin.webp"), { entetes: { "If-None-Match": String(r.entetes.etag) } });
    assert.equal(r2.statut, 304);
  });
  test("autres types : téléchargement octet-stream ; html, svg, js, faux png : 403", async () => {
    const t = await b.req("GET", "/api/fichier?chemin=" + q("inbox/Fournitures.txt"));
    assert.equal(t.statut, 200);
    assert.equal(t.entetes["content-type"], "application/octet-stream");
    assert.match(String(t.entetes["content-disposition"]), /^attachment; filename="Fournitures.txt"; filename\*=UTF-8''Fournitures\.txt$/);
    const md = await b.req("GET", "/api/fichier?chemin=" + q("Démo/To-do.md"));
    assert.equal(md.entetes["content-type"], "application/octet-stream");
    for (const c of ["piege.html", "piege.svg", "piege.js", "faux.png", "artefacts/2026-10-01-tableau-de-bord/apercu.png", ".git/config", "Démo"]) {
      const r = await b.req("GET", "/api/fichier?chemin=" + q(c));
      assert.ok(r.statut === 403 || r.statut === 404, `${c} -> ${r.statut}`);
      assert.notEqual(r.entetes["content-type"], "text/html; charset=utf-8");
    }
  });
});
