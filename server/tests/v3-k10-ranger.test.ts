// Carnet · K10-01 : « Ajouter à <base> » au rangement. GET /api/bases/destinations liste une destination
// par base dont le dossier des entrées est connu (carnet.dossier, sinon l'unique file.inFolder du filtre global en « et »),
// confinée et existante ; le rangement passe par POST /api/deplacer (porte d'écriture habituelle) avec `parent`.
import "../src/analyseur-yaml.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";
import { dossierDuFiltre } from "../src/bases.ts";
import { lireDefinition } from "../src/bases-yaml.ts";

let b: Banc;
const rq = () => crypto.randomUUID();
const disque = (rel: string) => path.join(b.espace, rel);
const bloc = (yaml: string) => "```base\n" + yaml + "\n```\n";
type Dest = { titre: string; page: string; bloc: number; dossier: string; parent: string };
const destinations = async (): Promise<Dest[]> => {
  const r = await b.req("GET", "/api/bases/destinations");
  assert.equal(r.statut, 200, r.texte);
  return r.json.destinations;
};

before(async () => {
  b = await demarrerBanc({
    env: { CARNET_MASQUES: "Privé" },
    preparer: (_r, espace) => {
      const w = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(espace, rel)), { recursive: true }); fs.writeFileSync(path.join(espace, rel), t); };
      // dossier déduit du filtre (sans carnet.dossier)
      w("K10/Suivi.md", "# Suivi\n\n" + bloc('filters:\n  and:\n    - file.inFolder("K10/Suivi/Tâches")\n    - \'statut != "Terminé"\''));
      w("K10/Suivi/Tâches/Existante.md", "---\nstatut: À faire\n---\n# Existante\n");
      // dossier déclaré
      w("K10/Lectures.md", "# Lectures\n\n" + bloc("carnet:\n  dossier: K10/Lectures/Livres"));
      w("K10/Lectures/Livres/Un livre.md", "# Un livre\n");
      // pas de destination : « ou », dossier absent, zone masquée, fichier caché, sortie de l'espace, page archivée, modèle
      w("K10/Ou.md", "# Ou\n\n" + bloc('filters:\n  or:\n    - file.inFolder("K10/A")\n    - file.inFolder("K10/B")'));
      w("K10/Absent.md", "# Absent\n\n" + bloc("carnet:\n  dossier: K10/Nulle/Part"));
      w("K10/Masquee.md", "# Masquée\n\n" + bloc("carnet:\n  dossier: Privé/Base"));
      w("Privé/Base/Secret.md", "# Secret\n");
      w("K10/Cachee.md", "# Cachée\n\n" + bloc("carnet:\n  dossier: K10/.cache"));
      fs.mkdirSync(path.join(espace, "K10/.cache"), { recursive: true });
      w("K10/Sortie.md", "# Sortie\n\n" + bloc("carnet:\n  dossier: ../hors"));
      w("K10/Rangée.md", "---\narchive: true\n---\n# Rangée\n\n" + bloc("carnet:\n  dossier: K10/Rangée/Entrées"));
      w("K10/Rangée/Entrées/E.md", "# E\n");
      w("Modèles/Base modèle.md", "# Base modèle\n\n" + bloc("carnet:\n  dossier: K10/Lectures/Livres"));
      w("Inbox/Idée K10.md", "---\ncapture: true\n---\n# Idée K10\n\nÀ ranger dans la base.\n");
      w("Inbox/Autre idée K10.md", "# Autre idée K10\n");
    },
  });
});
after(async () => { await b.fermer(); });

describe("K10-01 · dossier des entrées d'une base", () => {
  test("déduit de l'unique file.inFolder d'une conjonction ; rien sous « ou », « non », ni avec deux dossiers", () => {
    const d = (yaml: string) => dossierDuFiltre(lireDefinition(yaml).def!.filtre);
    assert.equal(d('filters:\n  and:\n    - file.inFolder("A/B")\n    - \'x == 1\''), "A/B");
    assert.equal(d('filters: file.inFolder("/A/B/") && x == 1'), "A/B");
    assert.equal(d('filters:\n  or:\n    - file.inFolder("A")\n    - file.inFolder("B")'), null);
    assert.equal(d('filters:\n  not:\n    - file.inFolder("A")'), null);
    assert.equal(d('filters:\n  and:\n    - file.inFolder("A")\n    - file.inFolder("B")'), null);
    assert.equal(d("filters: 'x == 1'"), null);
    assert.equal(d("views:\n  - type: table"), null);
  });
});

describe("K10-01 · GET /api/bases/destinations", () => {
  test("une destination par base au dossier connu, existant et autorisé", async () => {
    const l = await destinations();
    const par = new Map(l.map((x) => [x.page, x]));
    assert.deepEqual(par.get("K10/Suivi.md"), { titre: "Suivi", page: "K10/Suivi.md", bloc: 0, dossier: "K10/Suivi/Tâches", parent: "K10/Suivi/Tâches.md", icone: null });
    assert.equal(par.get("K10/Lectures.md")?.dossier, "K10/Lectures/Livres");
    for (const p of ["K10/Ou.md", "K10/Absent.md", "K10/Masquee.md", "K10/Cachee.md", "K10/Sortie.md", "K10/Rangée.md", "Modèles/Base modèle.md"]) {
      assert.equal(par.has(p), false, p);
    }
    assert.equal(l.some((x) => x.dossier.startsWith("Privé") || x.dossier.includes("..") || x.dossier.includes("/.")), false);
    // un même dossier n'apparaît qu'une fois
    assert.equal(new Set(l.map((x) => x.dossier)).size, l.length);
  });

  test("un dossier d'entrées qui est un lien symbolique n'est pas proposé", async () => {
    fs.writeFileSync(disque("K10/Lien.md"), "# Lien\n\n" + bloc("carnet:\n  dossier: K10/Lien/Entrées"));
    fs.mkdirSync(disque("K10/Lien"), { recursive: true });
    fs.symlinkSync(disque("K10/Suivi/Tâches"), disque("K10/Lien/Entrées"));
    await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(["K10"])));
    assert.equal((await destinations()).some((x) => x.page === "K10/Lien.md"), false);
  });
});

describe("K10-01 · ranger une capture dans une base par la porte habituelle", () => {
  test("POST /api/deplacer vers `parent` : la page entre dans le dossier des entrées et dans la base", async () => {
    const d = (await destinations()).find((x) => x.page === "K10/Suivi.md")!;
    const requete = rq();
    const r = await b.req("POST", "/api/deplacer", { corps: { chemin: "Inbox/Idée K10.md", parent: d.parent }, entetes: { "X-Carnet-Requete": requete } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.chemin, "K10/Suivi/Tâches/Idée K10.md");
    assert.equal(fs.existsSync(disque("Inbox/Idée K10.md")), false);
    assert.match(fs.readFileSync(disque("K10/Suivi/Tâches/Idée K10.md"), "utf8"), /À ranger dans la base\./);
    const base = await b.req("GET", "/api/base?chemin=" + q("K10/Suivi.md") + "&bloc=0");
    assert.equal(base.statut, 200, base.texte);
    assert.equal(base.json.lignes.some((l: { chemin: string }) => l.chemin === "K10/Suivi/Tâches/Idée K10.md"), true);
    // même geste renvoyé (réponse perdue) : pas de second déplacement, même résultat
    const r2 = await b.req("POST", "/api/deplacer", { corps: { chemin: "Inbox/Idée K10.md", parent: d.parent }, entetes: { "X-Carnet-Requete": requete } });
    assert.equal(r2.statut, 200, r2.texte);
    assert.equal(r2.json.chemin, "K10/Suivi/Tâches/Idée K10.md");
  });

  test("un `parent` hors de l'espace ou masqué est refusé, rien ne bouge", async () => {
    for (const parent of ["../hors.md", "Privé/Base.md", "K10/.cache.md"]) {
      const r = await b.req("POST", "/api/deplacer", { corps: { chemin: "Inbox/Autre idée K10.md", parent }, entetes: { "X-Carnet-Requete": rq() } });
      assert.ok(r.statut >= 400 && r.statut < 500, `${parent} : ${r.statut}`);
    }
    assert.equal(fs.existsSync(disque("Inbox/Autre idée K10.md")), true);
  });
});
