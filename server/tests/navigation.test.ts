// Carnet · tests des rétroliens, de l'aperçu d'une page et de la liste des images de couverture.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
const disque = (rel: string) => path.join(b.espace, rel);
const ecrire = (rel: string, contenu: string | Buffer) => {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
};

before(async () => {
  b = await demarrerBanc({ env: { CARNET_GIT: "non" } });
  ecrire("Retro/Cible.md", "# La cible\n\nJe me cite : [[Retro/Cible]].\n");
  ecrire("Retro/A.md", "# A\n\nVoir [[Retro/Cible]] ici, **vraiment**.\n");
  ecrire("Retro/B.md", "# B\n\n- [ ] Lien relatif [[Cible|la cible]]\n");
  ecrire("Autre/C.md", "# C\n\n> Par son nom : [[Cible]]\n");
  ecrire("Retro/D.md", "# D\n\nEn code : `[[Retro/Cible]]`\n\n```\n[[Retro/Cible]]\n```\n");
  ecrire("Retro/E.md", "# E\n\nUn [lien Markdown](Cible.md) relatif.\n");
  ecrire("Retro/F.md", "# F\n\nUne ancre [[Retro/Cible#Section|section]].\n");
  ecrire("Retro/G.md", "# G\n\n[[Retro/Cibles]] et [[Cible2]] (relatif : Retro/Cible2).\n");
  ecrire("Autre/I.md", "# I\n\n[[Cible2]] ambigu depuis Autre/.\n");
  ecrire("Retro/Cible2.md", "# Cible2\n");
  ecrire("Ailleurs/Cible2.md", "# Cible2 bis\n");
  ecrire("Retro/H.md", "---\nicon: 🧭\n---\n# H\n\n" + "très long ".repeat(40) + "[[Retro/Cible]]\n");
  ecrire("Apercu.md", "---\nicon: 📝\nresume: Le résumé\n---\n# Aperçu\n\nPremier **paragraphe** avec [[Retro/A|un lien]].\n\n- [ ] une tâche\n- point\n\n```js\ncode()\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n");
  ecrire("Apercu/Sous 1.md", "# Sous 1\n");
  ecrire("Apercu/Sous 2.md", "# Sous 2\n");
  ecrire("Apercu/doc.pdf", "%PDF");
  ecrire("Dossier pur/x.md", "# x\n");
  ecrire("Couv/Page.md", "# Page\n");
  ecrire("Couv/_assets/b.png", "png");
  ecrire("Couv/_assets/a matin.webp", "webp");
  ecrire("Couv/_assets/.cache.png", "png");
  ecrire("Couv/_assets/note.txt", "txt");
  ecrire("Couv/_assets/vecteur.svg", "<svg/>");
  ecrire("Couv/photo.jpg", "jpg");
  ecrire("_assets/racine.gif", "gif");
  fs.symlinkSync("/etc/hostname", disque("Couv/_assets/sortant.png"));
  fs.symlinkSync("../../Démo/_assets/mer-matin.webp", disque("Couv/_assets/interne.webp"));
  await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.balayerTout()));
});
after(async () => { await b.fermer(); });

describe("rétroliens", () => {
  test("liens [[…]] (chemin, relatif, nom unique, ancre, alias) et Markdown relatif ; jamais dans le code ni soi-même", async () => {
    const r = await b.req("GET", "/api/retroliens?chemin=" + q("Retro/Cible.md"));
    assert.equal(r.statut, 200);
    const chemins = r.json.pages.map((p: any) => p.chemin).sort();
    assert.deepEqual(chemins, ["Autre/C.md", "Retro/A.md", "Retro/B.md", "Retro/E.md", "Retro/F.md", "Retro/H.md"]);
    const a = r.json.pages.find((p: any) => p.chemin === "Retro/A.md");
    assert.deepEqual(a, { chemin: "Retro/A.md", titre: "A", icone: null, extrait: "Voir Cible ici, vraiment." });
    const bb = r.json.pages.find((p: any) => p.chemin === "Retro/B.md");
    assert.equal(bb.extrait, "Lien relatif la cible");
    const c = r.json.pages.find((p: any) => p.chemin === "Autre/C.md");
    assert.equal(c.extrait, "Par son nom : Cible");
    const h = r.json.pages.find((p: any) => p.chemin === "Retro/H.md");
    assert.equal(h.icone, "🧭");
    assert.ok(h.extrait.length <= 160 && h.extrait.endsWith("…"));
  });
  test("nom ambigu : aucune des deux ; le relatif l'emporte ; page sans lien entrant : liste vide", async () => {
    const r = await b.req("GET", "/api/retroliens?chemin=" + q("Retro/Cible2.md"));
    assert.deepEqual(r.json.pages.map((p: any) => p.chemin), ["Retro/G.md"]);
    const r2 = await b.req("GET", "/api/retroliens?chemin=" + q("Ailleurs/Cible2.md"));
    assert.deepEqual(r2.json.pages, []);
  });
  test("chemins refusés : caché, traversée, zone interdite, non .md", async () => {
    for (const c of [".corbeille/ancienne.md", "../x.md", "Privé/Cachée.md", "bruts/session.md", "Retro/Cible.txt"]) {
      const r = await b.req("GET", "/api/retroliens?chemin=" + q(c));
      assert.ok(r.statut === 400 || r.statut === 403, `${c} : ${r.statut}`);
    }
    // les pages des zones interdites ne sont jamais des rétroliens
    ecrire("Privé/Lien.md", "[[Retro/Cible]] zorglubinterdit\n");
    const r = await b.req("GET", "/api/retroliens?chemin=" + q("Retro/Cible.md"));
    assert.ok(!r.texte.includes("Privé"));
  });
});

describe("aperçu", () => {
  test("titre, icône, résumé, extrait en texte simple, sous-pages", async () => {
    const r = await b.req("GET", "/api/apercu?chemin=" + q("Apercu.md"));
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.titre, "Aperçu");
    assert.equal(r.json.icone, "📝");
    assert.equal(r.json.resume, "Le résumé");
    assert.equal(r.json.sousPages, 3);
    assert.equal(typeof r.json.mtime, "number");
    assert.equal(r.json.extrait, "Premier paragraphe avec un lien.\n\nune tâche\npoint\n\na · b\n1 · 2");
    assert.ok(!r.json.extrait.includes("code()"));
  });
  test("page « dossier » : titre = nom, extrait vide ; absente : 404 ; refus de zone", async () => {
    const r = await b.req("GET", "/api/apercu?chemin=" + q("Dossier pur.md"));
    assert.equal(r.statut, 200);
    assert.equal(r.json.titre, "Dossier pur");
    assert.equal(r.json.extrait, "");
    assert.equal(r.json.sousPages, 1);
    assert.equal((await b.req("GET", "/api/apercu?chemin=" + q("Nulle.md"))).statut, 404);
    assert.equal((await b.req("GET", "/api/apercu?chemin=" + q("Privé/Cachée.md"))).statut, 403);
  });
});

describe("couvertures", () => {
  test("images du dossier de la page, des dossiers parents, puis de l'index ; relatif encodé", async () => {
    const r = await b.req("GET", "/api/couvertures?page=" + q("Couv/Page.md"));
    assert.equal(r.statut, 200, r.texte);
    const chemins = r.json.images.map((i: any) => i.chemin);
    assert.deepEqual(chemins.slice(0, 4), ["Couv/_assets/a matin.webp", "Couv/_assets/b.png", "Couv/_assets/interne.webp", "_assets/racine.gif"]);
    assert.ok(chemins.includes("Couv/photo.jpg"));
    const rel = Object.fromEntries(r.json.images.map((i: any) => [i.chemin, i.relatif]));
    assert.equal(rel["Couv/_assets/a matin.webp"], "_assets/a%20matin.webp");
    assert.equal(rel["_assets/racine.gif"], "../_assets/racine.gif");
    assert.equal(rel["Couv/photo.jpg"], "photo.jpg");
    for (const exclu of ["Couv/_assets/.cache.png", "Couv/_assets/note.txt", "Couv/_assets/vecteur.svg", "Couv/_assets/sortant.png"]) {
      assert.ok(!chemins.includes(exclu), exclu);
    }
    assert.ok(chemins.length <= 200);
    assert.ok(chemins.every((c: string) => !c.split("/").some((s) => s.startsWith("."))));
  });
  test("page à la racine : relatif sans « ../ » ; chemin refusé : 403", async () => {
    const r = await b.req("GET", "/api/couvertures?page=" + q("Racine.md"));
    assert.equal(r.statut, 200);
    assert.equal(r.json.images.find((i: any) => i.chemin === "_assets/racine.gif").relatif, "_assets/racine.gif");
    assert.equal((await b.req("GET", "/api/couvertures?page=" + q("../x.md"))).statut, 403);
    assert.equal((await b.req("GET", "/api/couvertures?page=" + q(".git/x.md"))).statut, 403);
  });
});
