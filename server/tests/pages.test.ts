// Carnet · tests des pages : lecture, écriture conditionnelle et atomique, création, renommer / déplacer / supprimer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, lsTmp, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

const disque = (rel: string) => path.join(b.espace, rel);
const lireDisque = (rel: string) => fs.readFileSync(disque(rel), "utf8");

describe("lecture", () => {
  test("GET /api/page : contenu, etag = 16 hexa du SHA-256, en-tête ETag, mtime", async () => {
    const r = await b.req("GET", "/api/page?chemin=" + q("Démo/Page riche.md"));
    assert.equal(r.statut, 200);
    const brut = lireDisque("Démo/Page riche.md");
    assert.equal(r.json.contenu, brut);
    assert.equal(r.json.etag, sha16(brut));
    assert.match(r.json.etag, /^"[0-9a-f]{16}"$/);
    assert.equal(r.entetes.etag, r.json.etag);
    assert.equal(r.json.chemin, "Démo/Page riche.md");
    assert.equal(typeof r.json.mtime, "number");
  });
  test("page absente avec dossier : 404 + dossier:true ; absente : 404", async () => {
    const r = await b.req("GET", "/api/page?chemin=" + q("Dossier seul.md"));
    assert.equal(r.statut, 404);
    assert.equal(r.json.dossier, true);
    const r2 = await b.req("GET", "/api/page?chemin=" + q("Nulle part.md"));
    assert.equal(r2.statut, 404);
    assert.equal(r2.json.dossier, undefined);
    assert.ok(r2.json.erreur);
  });
  test("chemin non .md : 400", async () => {
    const r = await b.req("GET", "/api/page?chemin=" + q("inbox/Fournitures.txt"));
    assert.equal(r.statut, 400);
  });
});

describe("écriture (PUT)", () => {
  const chemin = "Démo/To-do.md";
  test("sans If-Match : 412 + contenu actuel", async () => {
    const r = await b.req("PUT", "/api/page?chemin=" + q(chemin), { corps: { contenu: "x" } });
    assert.equal(r.statut, 412);
    assert.equal(r.json.contenu, lireDisque(chemin));
    assert.equal(r.json.etag, sha16(lireDisque(chemin)));
  });
  test("mauvais If-Match : 412 {erreur, etag, contenu}, fichier intact", async () => {
    const avant = lireDisque(chemin);
    const r = await b.req("PUT", "/api/page?chemin=" + q(chemin), { corps: { contenu: "x" }, entetes: { "If-Match": '"0000000000000000"' } });
    assert.equal(r.statut, 412);
    assert.ok(r.json.erreur);
    assert.equal(r.json.contenu, avant);
    assert.equal(lireDisque(chemin), avant);
  });
  test("bon If-Match : écrit, permissions conservées, aucun temporaire restant", async () => {
    fs.chmodSync(disque(chemin), 0o640);
    const lu = await b.req("GET", "/api/page?chemin=" + q(chemin));
    const nouveau = lu.json.contenu + "\n- [ ] Ajout par le test\n";
    const r = await b.req("PUT", "/api/page?chemin=" + q(chemin), { corps: { contenu: nouveau }, entetes: { "If-Match": lu.json.etag } });
    assert.equal(r.statut, 200);
    assert.equal(r.json.etag, sha16(nouveau));
    assert.equal(lireDisque(chemin), nouveau);
    assert.equal(fs.statSync(disque(chemin)).mode & 0o777, 0o640);
    assert.deepEqual(lsTmp(disque("Démo")), []);
    // l'ancien etag ne marche plus
    const r2 = await b.req("PUT", "/api/page?chemin=" + q(chemin), { corps: { contenu: "y" }, entetes: { "If-Match": lu.json.etag } });
    assert.equal(r2.statut, 412);
    assert.equal(r2.json.contenu, nouveau);
  });
  test("création : If-None-Match: * obligatoire, dossiers créés, 0644", async () => {
    const c = "Nouveau dossier/Sous dossier/Créée.md";
    const sans = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "# Créée\n" } });
    assert.equal(sans.statut, 428);
    const r = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "# Créée\n" }, entetes: { "If-None-Match": "*" } });
    assert.equal(r.statut, 200);
    assert.equal(lireDisque(c), "# Créée\n");
    assert.equal(fs.statSync(disque(c)).mode & 0o777, 0o644);
    const encore = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "autre" }, entetes: { "If-None-Match": "*" } });
    assert.equal(encore.statut, 412);
    assert.equal(encore.json.contenu, "# Créée\n");
  });
  test("If-Match sur une page disparue : 412 etag null", async () => {
    const r = await b.req("PUT", "/api/page?chemin=" + q("Disparue.md"), { corps: { contenu: "x" }, entetes: { "If-Match": '"0123456789abcdef"' } });
    assert.equal(r.statut, 412);
    assert.equal(r.json.etag, null);
  });
  test("première écriture d'une page « dossier » virtuelle", async () => {
    const r = await b.req("PUT", "/api/page?chemin=" + q("Dossier seul.md"), { corps: { contenu: "# Dossier seul\n" }, entetes: { "If-None-Match": "*" } });
    assert.equal(r.statut, 200);
    const a = await b.req("GET", "/api/arbre");
    const n = a.json.racine.find((x: any) => x.chemin === "Dossier seul.md");
    assert.equal(n.existe, true);
    assert.equal(n.enfants[0].chemin, "Dossier seul/Enfant.md");
  });
  test("page > 2 Mo : 413 ; contenu manquant : 400", async () => {
    const r = await b.req("PUT", "/api/page?chemin=" + q("Grosse.md"), { corps: { contenu: "x".repeat(2 * 1024 * 1024 + 10) }, entetes: { "If-None-Match": "*" } });
    assert.equal(r.statut, 413);
    const r2 = await b.req("PUT", "/api/page?chemin=" + q("Grosse.md"), { corps: { texte: "x" }, entetes: { "If-None-Match": "*" } });
    assert.equal(r2.statut, 400);
  });
});

describe("création de sous-page (POST)", () => {
  test("sous une page : dossier créé, contenu par défaut, suffixes ` 2`, ` 3`", async () => {
    const r1 = await b.req("POST", "/api/page", { corps: { parent: "Démo/Réunions.md", titre: "Point mensuel" } });
    assert.equal(r1.statut, 201);
    assert.equal(r1.json.chemin, "Démo/Réunions/Point mensuel.md");
    assert.equal(lireDisque(r1.json.chemin), "# Point mensuel\n\n");
    assert.equal(r1.json.etag, sha16("# Point mensuel\n\n"));
    const r2 = await b.req("POST", "/api/page", { corps: { parent: "Démo/Réunions.md", titre: "Point mensuel" } });
    assert.equal(r2.json.chemin, "Démo/Réunions/Point mensuel 2.md");
    const r3 = await b.req("POST", "/api/page", { corps: { parent: "Démo/Réunions.md", titre: "Point mensuel", contenu: "Corps fourni\n" } });
    assert.equal(r3.json.chemin, "Démo/Réunions/Point mensuel 3.md");
    assert.equal(lireDisque(r3.json.chemin), "Corps fourni\n");
  });
  test("sous une page sans dossier : le dossier X/ est créé", async () => {
    const r = await b.req("POST", "/api/page", { corps: { parent: "Démo/Tableau de bord T3.md", titre: "Annexe" } });
    assert.equal(r.statut, 201);
    assert.equal(r.json.chemin, "Démo/Tableau de bord T3/Annexe.md");
    assert.ok(fs.statSync(disque("Démo/Tableau de bord T3")).isDirectory());
  });
  test("à la racine ; titre nettoyé ; parent absent : 404 ; titre vide : 400", async () => {
    const r = await b.req("POST", "/api/page", { corps: { parent: "", titre: "Idées / brouillon: v2?" } });
    assert.equal(r.statut, 201);
    assert.equal(r.json.chemin, "Idées brouillon v2.md");
    assert.equal(lireDisque(r.json.chemin), "# Idées / brouillon: v2?\n\n");
    const p = await b.req("POST", "/api/page", { corps: { parent: "Inexistante.md", titre: "x" } });
    assert.equal(p.statut, 404);
    const v = await b.req("POST", "/api/page", { corps: { parent: "", titre: "   " } });
    assert.equal(v.statut, 400);
  });
  test("un titre qui correspond à un dossier existant reçoit un suffixe (pas d'adoption)", async () => {
    const r = await b.req("POST", "/api/page", { corps: { parent: "", titre: "inbox" } });
    assert.equal(r.json.chemin, "inbox 2.md");
    const a = await b.req("POST", "/api/page", { corps: { parent: "", titre: "artefacts" } });
    assert.equal(a.statut, 201);
    assert.equal(a.json.chemin, "artefacts 2.md");
  });
});

describe("renommer / déplacer / supprimer + liens", () => {
  const LIENS = [
    "---",
    "lien: \"[[Démo/Projets]]\"",
    "---",
    "# Liens",
    "",
    "Voir [[Démo/Projets]], [[Démo/Projets|les projets]], [[Démo/Projets#Statuts]] et [[Démo/Projets/Site web]].",
    "Aussi [[Démo/Projets.md]] et [[Démo/Projets/Site web|SW]] mais pas [[Démo/Projets bis]] ni [[Démo/ProjetsX]].",
    "En code : `[[Démo/Projets]]` reste.",
    "```",
    "[[Démo/Projets]] dans un bloc",
    "```",
    "~~~md",
    "[[Démo/Projets/Site web]]",
    "~~~",
    "[relatif](Démo/Projets/Site%20web.md) et ![img](Démo/_assets/mer-matin.webp)",
    "",
  ].join("\n");

  test("renommer : X.md + X/ renommés, liens mis à jour hors code", async () => {
    fs.writeFileSync(disque("Liens.md"), LIENS);
    await b.app.espace.traiter(["Liens.md"]);
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/Projets.md", nom: "Chantiers" } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.chemin, "Démo/Chantiers.md");
    assert.ok(fs.existsSync(disque("Démo/Chantiers.md")));
    assert.ok(fs.existsSync(disque("Démo/Chantiers/Site web.md")));
    assert.ok(!fs.existsSync(disque("Démo/Projets.md")));
    assert.ok(!fs.existsSync(disque("Démo/Projets")));
    const apres = lireDisque("Liens.md");
    assert.match(apres, /lien: "\[\[Démo\/Chantiers\]\]"/);
    assert.match(apres, /Voir \[\[Démo\/Chantiers\]\], \[\[Démo\/Chantiers\|les projets\]\], \[\[Démo\/Chantiers#Statuts\]\] et \[\[Démo\/Chantiers\/Site web\]\]\./);
    assert.match(apres, /Aussi \[\[Démo\/Chantiers\.md\]\] et \[\[Démo\/Chantiers\/Site web\|SW\]\] mais pas \[\[Démo\/Projets bis\]\] ni \[\[Démo\/ProjetsX\]\]\./);
    assert.match(apres, /`\[\[Démo\/Projets\]\]` reste/);
    assert.match(apres, /```\n\[\[Démo\/Projets\]\] dans un bloc\n```/);
    assert.match(apres, /~~~md\n\[\[Démo\/Projets\/Site web\]\]\n~~~/);
    assert.match(apres, /\[relatif\]\(Démo\/Chantiers\/Site%20web\.md\)/);
    assert.match(apres, /!\[img\]\(Démo\/_assets\/mer-matin\.webp\)/);
    // 8 liens dans Liens.md + 1 dans Démo.md (« - [[Démo/Projets]] : … »)
    assert.match(lireDisque("Démo.md"), /- \[\[Démo\/Chantiers\]\] : des pages projet/);
    assert.equal(r.json.liensMisAJour, 9);
    const arbre = await b.req("GET", "/api/arbre");
    assert.ok(arbre.texte.includes('"chemin":"Démo/Chantiers/Site web.md"'));
    assert.ok(!arbre.texte.includes('"chemin":"Démo/Projets.md"'));
  });
  test("renommer vers un nom existant : 409 ; page absente : 404 ; même nom : no-op", async () => {
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/Chantiers.md", nom: "To-do" } });
    assert.equal(r.statut, 409);
    const r2 = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/Absente.md", nom: "X" } });
    assert.equal(r2.statut, 404);
    const r3 = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/Chantiers.md", nom: "Chantiers" } });
    assert.equal(r3.statut, 200);
    assert.equal(r3.json.liensMisAJour, 0);
  });
  test("déplacer : sous un autre parent, liens relatifs (images) recalculés", async () => {
    const r = await b.req("POST", "/api/deplacer", { corps: { chemin: "Démo/Page riche.md", parent: "Démo/Chantiers.md" } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.chemin, "Démo/Chantiers/Page riche.md");
    const txt = lireDisque("Démo/Chantiers/Page riche.md");
    assert.match(txt, /!\[Mer au petit matin\]\(\.\.\/_assets\/mer-matin\.webp\)/);
    assert.ok(r.json.liensMisAJour >= 1);
  });
  test("déplacer dans soi-même ou un descendant : 400 ; vers la racine : ok", async () => {
    const r = await b.req("POST", "/api/deplacer", { corps: { chemin: "Démo/Chantiers.md", parent: "Démo/Chantiers/Site web.md" } });
    assert.equal(r.statut, 400);
    const r2 = await b.req("POST", "/api/deplacer", { corps: { chemin: "Démo/Chantiers.md", parent: "Démo/Chantiers.md" } });
    assert.equal(r2.statut, 400);
    const r3 = await b.req("POST", "/api/deplacer", { corps: { chemin: "Démo/Chantiers/Page riche.md", parent: "" } });
    assert.equal(r3.statut, 200);
    assert.equal(r3.json.chemin, "Page riche.md");
    assert.match(lireDisque("Page riche.md"), /!\[Mer au petit matin\]\(Démo\/_assets\/mer-matin\.webp\)/);
    const r4 = await b.req("POST", "/api/deplacer", { corps: { chemin: "Page riche.md", parent: "Privé/Atelier.md" } });
    assert.equal(r4.statut, 403);
  });
  test("supprimer : X.md et X/ vers .corbeille/<id>/<chemin>", async () => {
    const r = await b.req("POST", "/api/supprimer", { corps: { chemin: "Démo/Chantiers.md" } });
    assert.equal(r.statut, 200);
    assert.match(r.json.corbeille, /^\.corbeille\/\d{8}-\d{6}-[0-9a-f]{4}\/Démo\/Chantiers\.md$/);
    assert.equal(r.json.corbeille, `.corbeille/${r.json.id}/Démo/Chantiers.md`);
    assert.equal(r.json.chemin, "Démo/Chantiers.md");
    assert.ok(fs.existsSync(disque(r.json.corbeille)));
    assert.ok(fs.existsSync(disque(r.json.corbeille.replace(/\.md$/, "") + "/Site web.md")));
    assert.ok(!fs.existsSync(disque("Démo/Chantiers.md")));
    assert.ok(!fs.existsSync(disque("Démo/Chantiers")));
    const a = await b.req("GET", "/api/arbre");
    assert.ok(!a.texte.includes("Chantiers"));
    const r2 = await b.req("POST", "/api/supprimer", { corps: { chemin: "Démo/Chantiers.md" } });
    assert.equal(r2.statut, 404);
  });
  test("supprimer une page « dossier » virtuelle (dossier seul)", async () => {
    fs.mkdirSync(disque("Vide/Sous"), { recursive: true });
    fs.writeFileSync(disque("Vide/Sous/a.md"), "a");
    await b.app.espace.traiter(["Vide"]);
    const r = await b.req("POST", "/api/supprimer", { corps: { chemin: "Vide.md" } });
    assert.equal(r.statut, 200);
    assert.match(r.json.corbeille, /\/Vide$/);
    assert.ok(!fs.existsSync(disque("Vide")));
  });
});
