// Carnet · tests de l'ordre manuel (.carnet/ordre.json, /api/placer), de la duplication et du renommage par le titre.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, ouvrirSse, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
after(async () => { await b.fermer(); });

const disque = (rel: string) => path.join(b.espace, rel);
const lireDisque = (rel: string) => fs.readFileSync(disque(rel), "utf8");
const ecrire = (rel: string, contenu: string) => {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
};
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
const ordreFichier = () => JSON.parse(lireDisque(".carnet/ordre.json"));

/** Noms des enfants d'un dossier dans l'arbre servi. */
async function enfants(dossier: string): Promise<string[]> {
  const a = (await b.req("GET", "/api/arbre")).json;
  let liste = a.racine;
  if (dossier) {
    const segs = dossier.split("/");
    for (let i = 0; i < segs.length; i++) {
      const c = segs.slice(0, i + 1).join("/") + ".md";
      liste = liste.find((n: any) => n.chemin === c)?.enfants ?? [];
    }
  }
  return liste.map((n: any) => n.nom);
}
const placer = (chemin: string, cible: string, position: string) => b.req("POST", "/api/placer", { corps: { chemin, cible, position } });

before(async () => {
  b = await demarrerBanc();
  ecrire("Ord.md", "# Ord\n");
  for (const n of ["Alpha", "Bravo", "Charlie", "Delta"]) ecrire(`Ord/${n}.md`, `# ${n}\n`);
  ecrire("Ord/Bravo/Sous.md", "# Sous\n");
  ecrire("Ord/rapport.pdf", "%PDF-1.4\n");
  ecrire("Autre.md", "# Autre\n");
  ecrire("Autre/Un.md", "# Un\n");
  await indexer(["Ord.md", "Ord", "Autre.md", "Autre"]);
});

describe("ordre manuel", () => {
  test("sans ordre : alphabétique ; .carnet absent", async () => {
    assert.deepEqual(await enfants("Ord"), ["Alpha", "Bravo", "Charlie", "Delta", "rapport.pdf"]);
    assert.ok(!fs.existsSync(disque(".carnet")));
  });
  test("placer avant / après : ordre complet écrit, aucun .md touché, SSE arbre", async () => {
    const avant = lireDisque("Ord/Delta.md");
    const sse = await ouvrirSse(b.port);
    try {
      const r = await placer("Ord/Delta.md", "Ord/Alpha.md", "avant");
      assert.equal(r.statut, 200, r.texte);
      assert.deepEqual(r.json, { chemin: "Ord/Delta.md", liensMisAJour: 0 });
      assert.deepEqual(await enfants("Ord"), ["Delta", "Alpha", "Bravo", "Charlie", "rapport.pdf"]);
      await sse.attendre((e) => e.type === "arbre", 2000);
    } finally {
      sse.fermer();
    }
    assert.deepEqual(ordreFichier(), { version: 1, dossiers: { Ord: ["Delta", "Alpha", "Bravo", "Charlie", "rapport.pdf"] } });
    assert.equal(lireDisque("Ord/Delta.md"), avant);
    const r2 = await placer("Ord/Alpha.md", "Ord/Charlie.md", "apres");
    assert.equal(r2.statut, 200);
    assert.deepEqual(await enfants("Ord"), ["Delta", "Bravo", "Charlie", "Alpha", "rapport.pdf"]);
    const r3 = await placer("Ord/rapport.pdf", "Ord/Delta.md", "avant");
    assert.equal(r3.statut, 200, r3.texte);
    assert.deepEqual(await enfants("Ord"), ["rapport.pdf", "Delta", "Bravo", "Charlie", "Alpha"]);
  });
  test("une page créée ensuite (agent) se range après les noms ordonnés ; l'ordre manuel gagne sur `ordre:`", async () => {
    ecrire("Ord/Aaa nouvelle.md", "---\nordre: 1\n---\n# Aaa nouvelle\n");
    await indexer(["Ord/Aaa nouvelle.md"]);
    assert.deepEqual(await enfants("Ord"), ["rapport.pdf", "Delta", "Bravo", "Charlie", "Alpha", "Aaa nouvelle"]);
  });
  test("renommer : le nom suit dans l'ordre ; déplacer : retiré, clés de sous-dossiers renommées", async () => {
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Ord/Bravo.md", nom: "Bravissimo" } });
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(await enfants("Ord"), ["rapport.pdf", "Delta", "Bravissimo", "Charlie", "Alpha", "Aaa nouvelle"]);
    // ordre dans le sous-dossier, puis déplacement du parent
    ecrire("Ord/Bravissimo/Autre sous.md", "# Autre sous\n");
    await indexer(["Ord/Bravissimo"]);
    assert.equal((await placer("Ord/Bravissimo/Sous.md", "Ord/Bravissimo/Autre sous.md", "apres")).statut, 200);
    assert.deepEqual(await enfants("Ord/Bravissimo"), ["Autre sous", "Sous"]);
    const d = await b.req("POST", "/api/deplacer", { corps: { chemin: "Ord/Bravissimo.md", parent: "Autre.md" } });
    assert.equal(d.statut, 200, d.texte);
    assert.deepEqual(await enfants("Ord"), ["rapport.pdf", "Delta", "Charlie", "Alpha", "Aaa nouvelle"]);
    assert.deepEqual(await enfants("Autre/Bravissimo"), ["Autre sous", "Sous"]);
    assert.deepEqual(ordreFichier().dossiers["Autre/Bravissimo"], ["Autre sous", "Sous"]);
    assert.equal(ordreFichier().dossiers["Ord/Bravissimo"], undefined);
  });
  test("placer dans une autre branche : déplacement + liens, puis rang ; « dans » : à la fin", async () => {
    ecrire("Lieur.md", "# Lieur\n\nVoir [[Ord/Delta]].\n");
    await indexer(["Lieur.md"]);
    const r = await placer("Ord/Delta.md", "Autre/Un.md", "avant");
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(r.json, { chemin: "Autre/Delta.md", liensMisAJour: 1 });
    assert.match(lireDisque("Lieur.md"), /\[\[Autre\/Delta\]\]/);
    assert.deepEqual(await enfants("Autre"), ["Bravissimo", "Delta", "Un"]);
    const d = await placer("Ord/Charlie.md", "Autre.md", "dans");
    assert.equal(d.statut, 200, d.texte);
    assert.deepEqual(await enfants("Autre"), ["Bravissimo", "Delta", "Un", "Charlie"]);
    const racine = await placer("Autre/Charlie.md", "", "dans");
    assert.equal(racine.statut, 200, racine.texte);
    const top = await enfants("");
    assert.equal(top[top.length - 1], "Charlie");
  });
  test("refus : soi-même, descendant, cible absente, position inconnue, fichier hors de ses voisins, zones", async () => {
    assert.equal((await placer("Autre.md", "Autre.md", "avant")).statut, 400);
    assert.equal((await placer("Autre.md", "Autre/Un.md", "avant")).statut, 400);
    assert.equal((await placer("Autre.md", "Autre/Un.md", "dans")).statut, 400);
    assert.equal((await placer("Autre/Un.md", "Ord/Inexistante.md", "avant")).statut, 404);
    assert.equal((await placer("Autre/Inexistante.md", "Autre/Delta.md", "avant")).statut, 404);
    assert.equal((await placer("Autre/Un.md", "Autre/Delta.md", "dessus")).statut, 400);
    assert.equal((await placer("Ord/rapport.pdf", "Autre/Un.md", "avant")).statut, 400);
    assert.equal((await placer("Ord/rapport.pdf", "Ord.md", "dans")).statut, 400);
    assert.equal((await placer("Autre/Un.md", "../x.md", "avant")).statut, 403);
    assert.equal((await placer("Autre/Un.md", ".carnet/x.md", "avant")).statut, 403);
    assert.equal((await placer("Autre/Un.md", "Privé/Atelier.md", "dans")).statut, 403);
    assert.equal((await placer("/etc/passwd", "Autre/Un.md", "avant")).statut, 400);
    // conflit de nom en changeant de dossier
    ecrire("Ord/Un.md", "# Un bis\n");
    await indexer(["Ord/Un.md"]);
    assert.equal((await placer("Ord/Un.md", "Autre/Delta.md", "apres")).statut, 409);
  });
  test(".carnet/ordre.json : jamais servi ; illisible ou piégé : ignoré sans planter", async () => {
    for (const c of [".carnet/ordre.json", ".carnet/ordre.md", "%2Ecarnet/ordre.json"]) {
      const r = await b.req("GET", "/api/fichier?chemin=" + c.replace("%2E", "%2E"));
      assert.ok(r.statut === 403 || r.statut === 400, c);
    }
    const p = await b.req("GET", "/api/page?chemin=" + q(".carnet/ordre.md"));
    assert.equal(p.statut, 403);
    fs.writeFileSync(disque(".carnet/ordre.json"), "{ pas du json");
    await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.balayerTout()));
    assert.deepEqual(await enfants("Ord"), (await enfants("Ord")).slice().sort((x, y) => x.localeCompare(y, "fr", { numeric: true, sensitivity: "base" })));
    fs.writeFileSync(disque(".carnet/ordre.json"), JSON.stringify({ version: 1, dossiers: { Ord: ["Alpha", "../x", ".cache", 3, "Alpha"], "../evil": ["x"] } }));
    await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.balayerTout()));
    assert.equal((await enfants("Ord"))[0], "Alpha");
  });
  test(".carnet en lien symbolique : écriture refusée (500), rien hors de l'espace", async () => {
    const d = await demarrerBanc({ env: { CARNET_GIT: "non" } });
    try {
      const dehors = fs.mkdtempSync(path.join(path.dirname(d.espace), "dehors-"));
      fs.symlinkSync(dehors, path.join(d.espace, ".carnet"));
      const r = await d.req("POST", "/api/placer", { corps: { chemin: "Démo/To-do.md", cible: "Démo/Projets.md", position: "avant" } });
      assert.equal(r.statut, 500);
      assert.deepEqual(fs.readdirSync(dehors), []);
    } finally {
      await d.fermer();
    }
  });
});

describe("dupliquer", () => {
  test("X.md et X/ copiés en « X (copie) », titre suffixé, liens relatifs intacts, ordre suivi", async () => {
    ecrire("Dup.md", "---\nstatut: actif\n---\n# Dup\n\n![img](_assets/a.png) [[Dup/Enfant]]\n");
    ecrire("Dup/Enfant.md", "# Enfant\n");
    ecrire("Dup/_assets/b.png", "png");
    ecrire("Dup/.cache.md", "secret");
    fs.symlinkSync("/etc/hostname", disque("Dup/lien.md"));
    await indexer(["Dup.md", "Dup"]);
    // ordre manuel à la racine : la copie se place juste après l'original
    await placer("Dup.md", "Ord.md", "avant");
    const r = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Dup.md" } });
    assert.equal(r.statut, 201, r.texte);
    assert.deepEqual(r.json, { chemin: "Dup (copie).md" });
    assert.equal(lireDisque("Dup (copie).md"), "---\nstatut: actif\n---\n# Dup (copie)\n\n![img](_assets/a.png) [[Dup/Enfant]]\n");
    assert.equal(lireDisque("Dup (copie)/Enfant.md"), "# Enfant\n");
    assert.equal(lireDisque("Dup (copie)/_assets/b.png"), "png");
    assert.ok(!fs.existsSync(disque("Dup (copie)/.cache.md")));
    assert.ok(!fs.existsSync(disque("Dup (copie)/lien.md")));
    const top = await enfants("");
    assert.equal(top[top.indexOf("Dup") + 1], "Dup (copie)");
    const r2 = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Dup.md" } });
    assert.equal(r2.json.chemin, "Dup (copie 2).md");
    assert.match(lireDisque("Dup (copie 2).md"), /^# Dup \(copie 2\)$/m);
  });
  test("titre en `title:` : suffixé ; sans titre écrit : contenu identique", async () => {
    ecrire("Fm.md", "---\ntitle: Titre fm\n---\nCorps\n");
    ecrire("Brut.md", "Juste du texte\n");
    await indexer(["Fm.md", "Brut.md"]);
    const r = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Fm.md" } });
    assert.equal(lireDisque(r.json.chemin), "---\ntitle: Titre fm (copie)\n---\nCorps\n");
    const r2 = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Brut.md" } });
    assert.equal(lireDisque(r2.json.chemin), "Juste du texte\n");
  });
  test("refus : absente 404, lien symbolique 403, caché/traversée 403", async () => {
    assert.equal((await b.req("POST", "/api/dupliquer", { corps: { chemin: "Nulle.md" } })).statut, 404);
    assert.equal((await b.req("POST", "/api/dupliquer", { corps: { chemin: "lien-ok.md" } })).statut, 403);
    assert.equal((await b.req("POST", "/api/dupliquer", { corps: { chemin: "../x.md" } })).statut, 403);
    assert.equal((await b.req("POST", "/api/dupliquer", { corps: { chemin: ".corbeille/ancienne.md" } })).statut, 403);
  });
});

describe("renommer par le titre", () => {
  test("nom qui suit le titre (« Sans titre », pas de H1) : fichier renommé, H1 inchangé (absent)", async () => {
    ecrire("Sans titre.md", "");
    ecrire("Pointeur.md", "# Pointeur\n\n[[Sans titre]]\n");
    await indexer(["Sans titre.md", "Pointeur.md"]);
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Sans titre.md", titre: "Courses de la semaine" } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.chemin, "Courses de la semaine.md");
    assert.equal(r.json.renomme, true);
    assert.equal(r.json.liensMisAJour, 1);
    assert.equal(lireDisque("Courses de la semaine.md"), "");
    assert.match(lireDisque("Pointeur.md"), /\[\[Courses de la semaine\]\]/);
  });
  test("H1 dont le nom suit : H1 réécrit ET fichier renommé ; etag rendu", async () => {
    ecrire("Idées.md", "---\nicon: 💡\n---\n# Idées\n\nCorps\n");
    await indexer(["Idées.md"]);
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Idées.md", titre: "Idées en vrac" } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.chemin, "Idées en vrac.md");
    assert.equal(lireDisque("Idées en vrac.md"), "---\nicon: 💡\n---\n# Idées en vrac\n\nCorps\n");
    const p = await b.req("GET", "/api/page?chemin=" + q("Idées en vrac.md"));
    assert.equal(r.json.etag, p.json.etag);
  });
  test("nom choisi par un agent (ne suit pas) : seul le H1 change", async () => {
    ecrire("2026-10-08-note.md", "# Notes du jour\n\nx\n");
    await indexer(["2026-10-08-note.md"]);
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "2026-10-08-note.md", titre: "Notes du 8 octobre" } });
    assert.deepEqual({ chemin: r.json.chemin, renomme: r.json.renomme }, { chemin: "2026-10-08-note.md", renomme: false });
    assert.equal(lireDisque("2026-10-08-note.md"), "# Notes du 8 octobre\n\nx\n");
  });
  test("`title:` : seule la ligne title change ; nom déjà pris : titre seul ; titre vide : 400", async () => {
    ecrire("Fiche.md", "---\ntitle: Fiche\nstatut: x\n---\nCorps\n");
    ecrire("Occupé.md", "# Occupé\n");
    await indexer(["Fiche.md", "Occupé.md"]);
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Fiche.md", titre: "Occupé" } });
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual({ chemin: r.json.chemin, renomme: r.json.renomme }, { chemin: "Fiche.md", renomme: false });
    assert.equal(lireDisque("Fiche.md"), "---\ntitle: Occupé\nstatut: x\n---\nCorps\n");
    const v = await b.req("POST", "/api/renommer", { corps: { chemin: "Fiche.md", titre: "  \n " } });
    assert.equal(v.statut, 400);
    const absent = await b.req("POST", "/api/renommer", { corps: { chemin: "Nulle part.md", titre: "x" } });
    assert.equal(absent.statut, 404);
  });
  test("requête rejouée (Entrée puis perte de focus) : même réponse, sans erreur ni nouveau changement", async () => {
    ecrire("Rejeu.md", "");
    ecrire("Rejeu titre.md", "# Rejeu titre\n\nx\n");
    await indexer(["Rejeu.md", "Rejeu titre.md"]);
    // deux requêtes quasi simultanées, forme {nom}
    const [a, c] = await Promise.all([
      b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu.md", nom: "Rejeu fait" } }),
      b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu.md", nom: "Rejeu fait" } }),
    ]);
    assert.equal(a.statut, 200, a.texte);
    assert.equal(c.statut, 200, c.texte);
    assert.equal(a.json.chemin, "Rejeu fait.md");
    assert.equal(c.json.chemin, "Rejeu fait.md");
    assert.equal([a.json.rejoue, c.json.rejoue].filter(Boolean).length, 1);
    // une AUTRE demande sur la source disparue reste une erreur
    const autre = await b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu.md", nom: "Encore autre" } });
    assert.equal(autre.statut, 404);
    // forme {titre}
    const [t1, t2] = await Promise.all([
      b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu titre.md", titre: "Rejeu titre fait" } }),
      b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu titre.md", titre: "Rejeu titre fait" } }),
    ]);
    assert.equal(t1.statut, 200, t1.texte);
    assert.equal(t2.statut, 200, t2.texte);
    const rejoue = t1.json.rejoue ? t1.json : t2.json;
    assert.deepEqual(rejoue, { chemin: "Rejeu titre fait.md", liensMisAJour: 0, renomme: true, rejoue: true, etag: (await b.req("GET", "/api/page?chemin=" + q("Rejeu titre fait.md"))).json.etag });
    assert.equal(lireDisque("Rejeu titre fait.md"), "# Rejeu titre fait\n\nx\n");
    // la source recréée entre-temps : vraie demande, plus de rejeu
    ecrire("Rejeu.md", "");
    await indexer(["Rejeu.md"]);
    const vraie = await b.req("POST", "/api/renommer", { corps: { chemin: "Rejeu.md", nom: "Rejeu fait" } });
    assert.equal(vraie.statut, 409);
  });
  test("l'ancienne forme {chemin, nom} marche toujours", async () => {
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Occupé.md", nom: "Libre" } });
    assert.equal(r.json.chemin, "Libre.md");
  });
});
