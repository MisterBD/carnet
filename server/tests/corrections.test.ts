// Carnet · tests du lot 4 « Corrections » (V3) : fichiers statiques absents (#7), extraits des rétroliens (K2-03),
// versions automatiques de séance (instantané du contenu d'avant au premier enregistrement après une pause).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import os from "node:os";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";
import { Instantanes, MAX_SEANCES, RE_INSTANTANE } from "../src/historique.ts";
import { lireConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { nettoyerLigne, texteApercu } from "../src/liens.ts";
import { decoderEntites, extraitCorps } from "../src/markdown.ts";

let b: Banc;
before(async () => {
  b = await demarrerBanc();
  const ecrire = (rel: string, c: string) => {
    const p = path.join(b.espace, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  ecrire("K2/Enfant Test renomme.md", "# Enfant Test renomme\n");
  // ligne réelle observée dans un fichier réel (liens accolés + espace finale encodée par la sérialisation)
  ecrire("K2/Test Lien.md", "# Test Lien\n\n[[K2/Enfant Test renomme]][[K2/Enfant Test renomme]]&#x20;\n");
  await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.balayerTout()));
});
after(async () => { await b.fermer(); });

describe("#7 : fichier statique absent = 404, routes de l'application = index.html", () => {
  test("extension connue et fichier absent : 404 (pas la page de l'appli)", async () => {
    for (const c of ["/lancement/inexistant.png", "/polices/x.woff2", "/icone.svg", "/robots.txt", "/a/b/c.json", "/x.webmanifest", "/" + q("é t é.png")]) {
      const r = await b.req("GET", c);
      assert.equal(r.statut, 404, c);
      assert.ok(!String(r.entetes["content-type"] ?? "").startsWith("text/html"), `${c} : ${r.entetes["content-type"]}`);
    }
  });
  test("routes de l'application servies quelle que soit l'extension", async () => {
    for (const c of ["/p/" + q("Une page"), "/p/rapport.txt", "/p/" + q("Démo") + "/" + q("Page riche"), "/h/notes.json", "/f/" + q("Démo/_assets/photo.png"),
      "/projets", "/corbeille", "/", "/une/route/inconnue", "/x.html"]) {
      const r = await b.req("GET", c);
      assert.equal(r.statut, 200, c);
      assert.equal(r.entetes["content-type"], "text/html; charset=utf-8", c);
      assert.equal(r.entetes["cache-control"], "no-cache", c);
    }
  });
  test("fichiers présents, sw.js et /sante inchangés", async () => {
    const sw = await b.req("GET", "/sw.js");
    assert.equal(sw.statut, 200);
    assert.equal(sw.entetes["cache-control"], "no-cache");
    assert.equal(sw.entetes["service-worker-allowed"], "/");
    const m = await b.req("GET", "/manifest.webmanifest");
    assert.equal(m.statut, 200);
    const a = await b.req("GET", "/assets/app-abc123.js");
    assert.equal(a.statut, 200);
    const s = await b.req("GET", "/sante");
    assert.equal(s.statut, 200);
  });
  test("chemin caché ou douteux : jamais un fichier, toujours le repli (comportement inchangé)", async () => {
    const r = await b.req("GET", "/.env");
    assert.equal(r.entetes["content-type"], "text/html; charset=utf-8");
    const r2 = await b.req("GET", "/.git/x.png");
    assert.notEqual(r2.statut, 500);
    assert.ok(!r2.texte.includes("zorglubinterdit"));
  });
});

describe("K2-03 : extraits lisibles (entités décodées, liens accolés séparés)", () => {
  test("la ligne réelle observée", () => {
    assert.equal(nettoyerLigne("[[CONFIG/Enfant Test renomme]][[CONFIG/Enfant Test renomme]]&#x20;"), "Enfant Test renomme Enfant Test renomme");
  });
  test("liens accolés de toutes sortes, ponctuation collée gardée", () => {
    assert.equal(nettoyerLigne("[[A]][[B|Bé]][c](c.md)![img](i.png)"), "A Bé c img");
    assert.equal(nettoyerLigne("Voir [[A]], puis [b](b.md)."), "Voir A, puis b.");
    assert.equal(nettoyerLigne("[[A]] [[B]]"), "A B");
    assert.equal(nettoyerLigne("- [ ] [[A]][[B]]"), "A B");
  });
  test("entités numériques et nommées décodées, une seule fois, après le balisage", () => {
    assert.equal(nettoyerLigne("caf&#233; &amp; th&eacute; &lt;b&gt;gras&lt;/b&gt; &#x1F30A;"), "café & th&eacute; <b>gras</b> 🌊");
    assert.equal(nettoyerLigne("&amp;#x20; reste"), "&#x20; reste");
    assert.equal(nettoyerLigne("&#42;pas de gras&#42; ici"), "*pas de gras* ici", "une entité décodée ne devient jamais du balisage");
    assert.equal(nettoyerLigne("a&nbsp;&nbsp;b&#9;c"), "a b c");
    assert.equal(decoderEntites("&#0; &#xD800; &#x110000;"), "\uFFFD \uFFFD \uFFFD");
    assert.equal(decoderEntites("&inconnu; &#x41;"), "&inconnu; A");
  });
  test("résumé (extraitCorps) et aperçu (texteApercu) : même nettoyage", () => {
    assert.equal(extraitCorps("[[A]][[B]]&#x20;\n"), "A B");
    assert.equal(extraitCorps("Prix&nbsp;: 3&#8239;€ &amp; plus"), "Prix : 3 € & plus");
    assert.equal(texteApercu("Premier [[X]][[Y]]&#x20;\n\n| a&amp;b | c |\n|---|---|\n"), "Premier X Y\n\na&b · c");
  });
  test("API : l'extrait du rétrolien de la page « Test Lien »", async () => {
    const r = await b.req("GET", "/api/retroliens?chemin=" + q("K2/Enfant Test renomme.md"));
    assert.equal(r.statut, 200);
    const p = r.json.pages.find((x: any) => x.chemin === "K2/Test Lien.md");
    assert.ok(p, JSON.stringify(r.json));
    assert.equal(p.extrait, "Enfant Test renomme Enfant Test renomme");
  });
});

describe("versions automatiques de séance", () => {
  const disque = (rel: string) => path.join(b.espace, rel);
  const vieillir = (rel: string, minutes: number) => {
    const t = (Date.now() - minutes * 60_000) / 1000;
    fs.utimesSync(disque(rel), t, t);
  };
  const versions = async (rel: string) => (await b.req("GET", "/api/historique?chemin=" + q(rel))).json;
  const seances = async (rel: string) => (await versions(rel)).versions.filter((v: any) => v.genre === "seance");
  const ecrire = async (rel: string, contenu: string) => {
    const lu = await b.req("GET", "/api/page?chemin=" + q(rel));
    const r = await b.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu }, entetes: lu.statut === 200 ? { "If-Match": lu.json.etag } : { "If-None-Match": "*" } });
    assert.equal(r.statut, 200, r.texte);
    return r;
  };
  const contenuDe = async (rel: string, id: string) => (await b.req("GET", `/api/version?chemin=${q(rel)}&id=${q(id)}`)).json.contenu;

  test("création puis écritures rapprochées : aucune version automatique", async () => {
    await ecrire("Seance/A.md", "# A\n\nv1\n");
    await ecrire("Seance/A.md", "# A\n\nv2\n");
    await ecrire("Seance/A.md", "# A\n\nv3\n");
    const h = await versions("Seance/A.md");
    assert.equal(h.pauseVersions, 10);
    assert.deepEqual(h.versions.filter((v: any) => v.source === "instantane"), []);
  });
  test("après une pause de 10 min : instantané du contenu d'AVANT, une seule fois par séance", async () => {
    vieillir("Seance/A.md", 11);
    await ecrire("Seance/A.md", "# A\n\nv4\n");
    let l = await seances("Seance/A.md");
    assert.equal(l.length, 1);
    assert.equal(l[0].auto, false);
    assert.equal(l[0].source, "instantane");
    assert.match(l[0].id, /^inst:\d{8}-\d{6}-\d{3}-seance$/);
    assert.equal(await contenuDe("Seance/A.md", l[0].id), "# A\n\nv3\n");
    // la séance continue : rien de plus
    await ecrire("Seance/A.md", "# A\n\nv5\n");
    assert.equal((await seances("Seance/A.md")).length, 1);
    // 9 min de pause : toujours la même séance
    vieillir("Seance/A.md", 9);
    await ecrire("Seance/A.md", "# A\n\nv6\n");
    assert.equal((await seances("Seance/A.md")).length, 1);
    // nouvelle pause : nouvelle version (v6)
    vieillir("Seance/A.md", 30);
    await ecrire("Seance/A.md", "# A\n\nv7\n");
    l = await seances("Seance/A.md");
    assert.equal(l.length, 2);
    assert.equal(await contenuDe("Seance/A.md", l[0].id), "# A\n\nv6\n");
    // fichiers hors de l'espace, droits restreints
    const dossier = path.join(b.etat, "instantanes", "espace", "Seance", "A.md");
    assert.ok(fs.readdirSync(dossier).every((f) => RE_INSTANTANE.test(f.slice(0, -3))));
    assert.ok(!fs.existsSync(path.join(b.espace, "instantanes")));
  });
  test("identique au dernier instantané : rien de nouveau ; une page inchangée n'est jamais réécrite", async () => {
    const pris = await b.req("POST", "/api/instantane", { corps: { chemin: "Seance/A.md" } });
    assert.equal(pris.statut, 201);
    vieillir("Seance/A.md", 20);
    const avant = (await versions("Seance/A.md")).versions.length;
    await ecrire("Seance/A.md", "# A\n\nv8\n");
    assert.equal((await versions("Seance/A.md")).versions.length, avant, "le contenu d'avant (v7) est déjà l'instantané manuel");
    // même contenu renvoyé : pas d'écriture, donc pas de version
    vieillir("Seance/A.md", 20);
    await ecrire("Seance/A.md", "# A\n\nv8\n");
    assert.equal((await versions("Seance/A.md")).versions.length, avant);
  });
  test("tâche cochée depuis l'accueil et propriété modifiée : version automatique aussi", async () => {
    await ecrire("Seance/T.md", "# T\n\n- [ ] appeler\n");
    vieillir("Seance/T.md", 15);
    const r = await b.req("POST", "/api/tache", { corps: { chemin: "Seance/T.md", ligne: 2, texte: "- [ ] appeler", coche: true } });
    assert.equal(r.statut, 200, r.texte);
    let l = await seances("Seance/T.md");
    assert.equal(l.length, 1);
    assert.equal(await contenuDe("Seance/T.md", l[0].id), "# T\n\n- [ ] appeler\n");
    vieillir("Seance/T.md", 15);
    const m = await b.req("POST", "/api/meta", { corps: { chemin: "Seance/T.md", champs: { statut: "en cours" } } });
    assert.equal(m.statut, 200, m.texte);
    l = await seances("Seance/T.md");
    assert.equal(l.length, 2);
    assert.equal(await contenuDe("Seance/T.md", l[0].id), "# T\n\n- [x] appeler\n");
    assert.equal(m.json.etag, sha16(fs.readFileSync(disque("Seance/T.md"))));
  });
  test("chemins hors espace ou interdits : refusés comme avant, aucune version", async () => {
    for (const c of ["../x.md", ".git/config.md", "Privé/Cachée.md"]) {
      const r = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "x" }, entetes: { "If-Match": "*" } });
      assert.ok([400, 403, 404].includes(r.statut), `${c} -> ${r.statut}`);
    }
    const racine = path.join(b.etat, "instantanes", "espace");
    const tous = fs.readdirSync(racine, { recursive: true }).map(String);
    assert.ok(!tous.some((f) => f.includes("..") || f.startsWith(".git") || f.startsWith("Privé")), tous.join(", "));
  });
  test("plafond : 30 versions de séance par page, les instantanés pris à la main restent", async () => {
    const etat = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-seances-"));
    try {
      const inst = new Instantanes({ etat, nomEspace: "essai" } as Config);
      const segs = ["Plafond.md"];
      await inst.creer(segs, "manuel 1", false);
      await inst.creer(segs, "avant restauration", true);
      for (let i = 0; i < MAX_SEANCES + 5; i++) {
        const x = await inst.seance(segs, `séance ${i}`, 0, 600_000);
        assert.ok(x && x.genre === "seance");
      }
      const l = await inst.lister(segs);
      const s = l.filter((x) => x.genre === "seance");
      assert.equal(s.length, MAX_SEANCES);
      assert.equal(l.filter((x) => x.genre === "manuel").length, 1);
      assert.equal(l.filter((x) => x.genre === "avant-restauration").length, 1);
      // les plus anciennes sont parties : la plus récente est la dernière prise
      assert.equal((await inst.lire(segs, s[0].stamp)).contenu, `séance ${MAX_SEANCES + 4}`);
      assert.ok(!(await Promise.all(s.map((x) => inst.lire(segs, x.stamp)))).some((x) => x.contenu === "séance 0"));
      // pause non atteinte ou réglage 0 : rien
      assert.equal(await inst.seance(segs, "récent", Date.now() - 1000, 600_000), null);
      assert.equal(await inst.seance(segs, "désactivé", 0, 0), null);
    } finally {
      fs.rmSync(etat, { recursive: true, force: true });
    }
  });
});

describe("versions automatiques : réglage CARNET_PAUSE_VERSIONS", () => {
  test("0 = désactivé (aucune version automatique), valeur invalide refusée", async () => {
    const b0 = await demarrerBanc({ env: { CARNET_PAUSE_VERSIONS: "0" } });
    try {
      const rel = "Zero.md";
      const r1 = await b0.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu: "# Z\n\nv1\n" }, entetes: { "If-None-Match": "*" } });
      assert.equal(r1.statut, 200);
      const t = (Date.now() - 3_600_000) / 1000;
      fs.utimesSync(path.join(b0.espace, rel), t, t);
      const r2 = await b0.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu: "# Z\n\nv2\n" }, entetes: { "If-Match": r1.json.etag } });
      assert.equal(r2.statut, 200);
      const h = (await b0.req("GET", "/api/historique?chemin=" + q(rel))).json;
      assert.equal(h.pauseVersions, 0);
      assert.deepEqual(h.versions.filter((v: any) => v.source === "instantane"), []);
    } finally {
      await b0.fermer();
    }
    assert.throws(() => lireConfig({ CARNET_ESPACE: os.tmpdir(), CARNET_UTILISATEURS_AUTORISES: "a@b.test", CARNET_PAUSE_VERSIONS: "dix" }), /CARNET_PAUSE_VERSIONS/);
    assert.throws(() => lireConfig({ CARNET_ESPACE: os.tmpdir(), CARNET_UTILISATEURS_AUTORISES: "a@b.test", CARNET_PAUSE_VERSIONS: "-1" }), /CARNET_PAUSE_VERSIONS/);
    assert.equal(lireConfig({ CARNET_ESPACE: os.tmpdir(), CARNET_UTILISATEURS_AUTORISES: "a@b.test" }).pauseVersions, 10);
  });
});
