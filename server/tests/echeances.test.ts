// Carnet · tests « Échéances » (11/10/2026) : les fiches datées d'une base remontent dans Aujourd'hui quand la base le
// DÉCLARE (`carnet.aujourdhui`), se cochent depuis Aujourd'hui (valeur « fait » déclarée, par l'Ecrivain, If-Match),
// s'annulent, et rien ne remonte ni ne s'écrit sans déclaration.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import YAML from "yaml";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";
import { lireDefinition, poserAujourdhui } from "../src/bases-yaml.ts";
import { dateDuJour } from "../../shared/identifiants.ts";
import { plusJours } from "../src/aujourdhui.ts";

// L'outil d'import Notion n'est pas publié (essai en cours) : il est chargé seulement s'il est présent, et le test qui
// s'en sert est sauté sinon (dépôt public). Un import statique ferait échouer tout ce fichier de tests en son absence.
const IMPORT_NOTION = new URL("../../outils/import-notion/src/bloc-base.ts", import.meta.url);
const SANS_IMPORT_NOTION = fs.existsSync(IMPORT_NOTION) ? false : "outil d'import Notion absent (non publié)";

const BLOC_SANS = `filters:
  and:
    - file.folder == "Suivi/Tâches"
properties:
  file.name:
    displayName: Tâche
  note.echeance:
    displayName: Échéance
views:
  - type: table
    name: Tâches
    order:
      - file.name
      - note.statut
      - note.priorite
      - note.echeance
carnet:
  dossier: Suivi/Tâches
  proprietes:
    statut:
      type: statut
      options:
        - À faire
        - En cours
        - Fait
    priorite:
      type: selection
      options:
        - Haute
        - Moyenne
        - Basse
    echeance:
      type: date   # l'échéance de Notion
`;

const DECL = { echeance: "echeance", fait: { propriete: "statut", valeur: "Fait" }, priorite: "priorite" };

describe("Échéances · déclaration carnet.aujourdhui", () => {
  test("lue quand elle est valide ; absente = null", () => {
    assert.equal(lireDefinition(BLOC_SANS).def!.aujourdhui, null);
    const s = poserAujourdhui(BLOC_SANS, DECL);
    assert.deepEqual(lireDefinition(s).def!.aujourdhui, DECL);
    assert.deepEqual(lireDefinition(s).def!.avertissements, []);
  });

  test("forme invalide : avertissement visible, la base reste affichable, rien ne remonte", () => {
    const cas: Array<[unknown, RegExp]> = [
      [{ echeance: "statut", fait: { propriete: "priorite", valeur: "Haute" } }, /n'est pas une propriété date/],
      [{ echeance: "echeance", fait: { propriete: "statut", valeur: "Terminé" } }, /n'est pas une option de « statut »/],
      [{ echeance: "echeance", fait: { propriete: "statut" } }, /fait\.valeur/],
      [{ echeance: "echeance" }, /« fait » attend/],
      [{ echeance: "echeance", fait: { propriete: "echeance", valeur: "x" } }, /deux propriétés différentes/],
      ["oui", /attend « echeance »/],
    ];
    for (const [v, re] of cas) {
      const js = YAML.parse(BLOC_SANS);
      js.carnet.aujourdhui = v;
      const { def, erreurs } = lireDefinition(YAML.stringify(js));
      assert.deepEqual(erreurs, []);
      assert.equal(def!.aujourdhui, null);
      assert.ok(def!.avertissements.some((a) => re.test(a)), `${JSON.stringify(v)} → ${def!.avertissements.join(" | ")}`);
    }
  });

  test("bloc écrit par l'import Notion (base To-Do) : déclaration lue telle quelle par le serveur", { skip: SANS_IMPORT_NOTION }, async () => {
    const { genererBlocBase } = (await import(IMPORT_NOTION.href)) as { genererBlocBase: (o: unknown) => string };
    const bloc = genererBlocBase({
      dossier: "Notion/To-Do — Suivi", libelleTitre: "Tâche", nomVue: "Tableau",
      colonnes: [
        { cle: "statut", libelle: "Statut", type: "selection", options: ["À faire", "En cours", "Fait"] },
        { cle: "priorite", libelle: "Priorité", type: "selection", options: ["Haute", "Moyenne", "Basse"] },
        { cle: "categorie", libelle: "Catégorie", type: "selection", options: ["Admin", "Perso"] },
        { cle: "echeance", libelle: "Échéance", type: "date", options: null },
        { cle: "notes", libelle: "Notes", type: "texte", options: null },
      ],
      ordre: ["statut", "priorite", "categorie", "echeance", "notes"],
    });
    const { def, erreurs } = lireDefinition(/^```base\n([\s\S]*)\n```\n$/.exec(bloc)![1]);
    assert.deepEqual(erreurs, []);
    assert.deepEqual(def!.aujourdhui, DECL);
    assert.deepEqual(def!.avertissements, []);
  });

  test("case à cocher : valeur true acceptée", () => {
    const js = YAML.parse(BLOC_SANS);
    js.carnet.proprietes.termine = { type: "case" };
    js.carnet.aujourdhui = { echeance: "echeance", fait: { propriete: "termine", valeur: true } };
    assert.deepEqual(lireDefinition(YAML.stringify(js)).def!.aujourdhui, { echeance: "echeance", fait: { propriete: "termine", valeur: true }, priorite: null });
  });

  test("poser puis retirer : seules les lignes de la déclaration changent, retour à l'octet (commentaire gardé)", () => {
    const s = poserAujourdhui(BLOC_SANS, DECL);
    assert.ok(s.startsWith(BLOC_SANS), "ajout à la fin de « carnet », le reste à l'octet");
    assert.equal(s.slice(BLOC_SANS.length), "  aujourdhui:\n    echeance: echeance\n    fait:\n      propriete: statut\n      valeur: Fait\n    priorite: priorite\n");
    assert.equal(poserAujourdhui(s, null), BLOC_SANS);
    // sans clé « carnet » : elle est créée, puis retirée
    const nu = "views:\n  - type: table\n    name: Tous\n";
    const avec = poserAujourdhui(nu, DECL);
    assert.deepEqual(YAML.parse(avec).carnet, { aujourdhui: DECL });
    assert.equal(poserAujourdhui(avec, null), nu);
    // retirer une déclaration absente : rien ne change
    assert.equal(poserAujourdhui(BLOC_SANS, null), BLOC_SANS);
  });
});

describe("Échéances · routes", () => {
  let b: Banc;
  const jour = dateDuJour("Europe/Paris");
  const fm = (statut: string, echeance: string | null, priorite = "Moyenne") =>
    `---\nstatut: ${statut}\npriorite: ${priorite}\n${echeance ? `echeance: ${echeance}\n` : ""}categorie: Admin\n---\n# `;
  const FICHES: Record<string, string> = {
    "Suivi/Tâches/Payer la cotisation.md": fm("À faire", plusJours(jour, -3), "Haute") + "Payer la cotisation\n\nNotes : penser au reçu.\n",
    "Suivi/Tâches/Relire le contrat.md": fm("En cours", plusJours(jour, -1)) + "Relire le contrat\n",
    "Suivi/Tâches/Appeler le plombier.md": fm("À faire", jour, "Basse") + "Appeler le plombier\n",
    "Suivi/Tâches/Ranger le garage.md": fm("Fait", plusJours(jour, -10)) + "Ranger le garage\n",
    "Suivi/Tâches/Trier les photos.md": fm("À faire", null) + "Trier les photos\n",
    "Suivi/Tâches/Préparer la réunion.md": fm("À faire", plusJours(jour, 3)) + "Préparer la réunion\n",
  };
  const page = (decl: boolean) => "# Suivi\n\nTexte avant la base.\n\n```base\n" + (decl ? poserAujourdhui(BLOC_SANS, DECL) : BLOC_SANS) + "```\n\nTexte après.\n";

  before(async () => {
    b = await demarrerBanc({
      preparer: async (_r, espace) => {
        for (const [rel, contenu] of Object.entries({ ...FICHES, "Suivi.md": page(true), "Autre.md": "# Autre\n\n```base\n" + BLOC_SANS + "```\n" })) {
          await fsp.mkdir(path.dirname(path.join(espace, rel)), { recursive: true });
          await fsp.writeFile(path.join(espace, rel), contenu);
        }
      },
    });
  });
  after(async () => { await b.fermer(); });

  const fiches = (l: Array<{ fiche?: unknown; libelle: string }>) => l.filter((t) => t.fiche).map((t) => t.libelle);
  const lire = (rel: string) => fs.readFileSync(path.join(b.espace, rel), "utf8");

  test("Aujourd'hui : fiches non faites et datées, en retard / aujourd'hui / à venir, avec provenance, sans doublon", async () => {
    const r = await b.req("GET", "/api/aujourdhui");
    assert.equal(r.statut, 200);
    assert.deepEqual(fiches(r.json.enRetard), ["Payer la cotisation", "Relire le contrat"]);
    assert.deepEqual(fiches(r.json.aujourdhui), ["Appeler le plombier"]);
    assert.deepEqual(fiches(r.json.semaine), ["Préparer la réunion"]);
    assert.deepEqual(fiches(r.json.sansDate), []); // une fiche sans échéance ne remonte pas
    const t = r.json.enRetard.find((x: { libelle: string }) => x.libelle === "Payer la cotisation");
    assert.equal(t.chemin, "Suivi/Tâches/Payer la cotisation.md");
    assert.equal(t.priorite, "haute");
    assert.equal(t.echeance, plusJours(jour, -3));
    assert.equal(t.ligne, -1);
    assert.deepEqual({ ...t.fiche, etag: "x" }, { base: "Suivi.md", baseTitre: "Suivi", bloc: 0, etag: "x", propriete: "statut", valeur: "Fait", avant: "À faire" });
    // « Autre.md » (même dossier, SANS déclaration) : aucune fiche en double
    const toutes = [...r.json.enRetard, ...r.json.aujourdhui, ...r.json.semaine, ...r.json.plusTard].filter((x: { fiche?: unknown }) => x.fiche);
    assert.equal(new Set(toutes.map((x: { chemin: string }) => x.chemin)).size, toutes.length);
  });

  test("aperçu de « Afficher dans Aujourd'hui » (rien n'est écrit)", async () => {
    const avant = lire("Autre.md");
    const r = await b.req("POST", "/api/base/reecrire", { corps: { chemin: "Autre.md", source: BLOC_SANS, vue: 0, changement: { aujourdhui: DECL } } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.source, poserAujourdhui(BLOC_SANS, DECL));
    assert.deepEqual(r.json.apercu, { fiches: 4, enRetard: 2, aujourdhui: 1, aVenir: 1, sansDate: 1, faites: 1, dossier: "Suivi/Tâches" });
    assert.equal(lire("Autre.md"), avant);
    // valeur hors des options : 422 avec la raison
    const k = await b.req("POST", "/api/base/reecrire", { corps: { chemin: "Autre.md", source: BLOC_SANS, vue: 0, changement: { aujourdhui: { ...DECL, fait: { propriete: "statut", valeur: "Terminé" } } } } });
    assert.equal(k.statut, 422);
    assert.match(k.json.erreur, /n'est pas une option/);
    // retirer
    const s = await b.req("POST", "/api/base/reecrire", { corps: { source: poserAujourdhui(BLOC_SANS, DECL), vue: 0, changement: { aujourdhui: null } } });
    assert.equal(s.json.source, BLOC_SANS);
    // mélangé à un autre changement : 400
    const m = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_SANS, vue: 0, changement: { aujourdhui: null, tri: null } } });
    assert.equal(m.statut, 400);
  });

  test("cocher : `statut: Fait` posé par l'Ecrivain, le reste à l'octet ; annuler : retour à l'octet", async () => {
    const rel = "Suivi/Tâches/Payer la cotisation.md";
    const original = lire(rel);
    const a = await b.req("GET", "/api/aujourdhui");
    const t = a.json.enRetard.find((x: { chemin: string }) => x.chemin === rel);
    const sans = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true } });
    assert.equal(sans.statut, 428);
    const r = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true }, entetes: { "If-Match": t.fiche.etag, "X-Carnet-Requete": "a".repeat(32) } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(lire(rel), original.replace("statut: À faire", "statut: Fait"));
    // rejoué (même identifiant de geste) : aucun second effet
    const bis = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true }, entetes: { "If-Match": t.fiche.etag, "X-Carnet-Requete": "a".repeat(32) } });
    assert.equal(bis.statut, 200);
    assert.equal(bis.json.rejoue, true);
    const apres = await b.req("GET", "/api/aujourdhui");
    assert.ok(!fiches(apres.json.enRetard).includes("Payer la cotisation"));
    const u = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: false, avant: "À faire" }, entetes: { "If-Match": r.json.etag } });
    assert.equal(u.statut, 200, u.texte);
    assert.equal(lire(rel), original);
  });

  test("conflit : fichier modifié ailleurs = 412, rien n'est écrasé", async () => {
    const rel = "Suivi/Tâches/Relire le contrat.md";
    const a = await b.req("GET", "/api/aujourdhui");
    const t = a.json.enRetard.find((x: { chemin: string }) => x.chemin === rel);
    const externe = lire(rel).replace("Relire le contrat\n", "Relire le contrat\n\nAjouté par un agent.\n");
    fs.writeFileSync(path.join(b.espace, rel), externe);
    const r = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true }, entetes: { "If-Match": t.fiche.etag } });
    assert.equal(r.statut, 412);
    assert.equal(lire(rel), externe);
  });

  test("sans déclaration : 422, rien n'est écrit ; sécurité des chemins et X-Carnet", async () => {
    const rel = "Autre.md";
    const avant = lire(rel);
    const p = await b.req("GET", `/api/page?chemin=${q(rel)}`);
    const r = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true }, entetes: { "If-Match": String(p.entetes.etag ?? "x") } });
    assert.equal(r.statut, 422);
    assert.equal(r.json.raison, "sans_declaration");
    assert.equal(lire(rel), avant);
    for (const chemin of ["../hors.md", "Privé/Cachée.md", ".git/config", "Suivi/Tâches/../../Privé/Cachée.md"]) {
      const x = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin, fait: true }, entetes: { "If-Match": "x" } });
      assert.ok([400, 403, 404, 422].includes(x.statut), `${chemin} → ${x.statut}`);
    }
    const sx = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: "Suivi/Tâches/Appeler le plombier.md", fait: true }, entetes: { "X-Carnet": undefined, "If-Match": "x" } });
    assert.equal(sx.statut, 403);
    assert.ok(lire("Suivi/Tâches/Appeler le plombier.md").includes("statut: À faire"));
  });

  test("case à cocher déclarée : cocher écrit `termine: true`, annuler retire la clé absente avant", async () => {
    const js = YAML.parse(BLOC_SANS);
    js.filters.and = ['file.folder == "Courses"'];
    js.carnet.dossier = "Courses";
    js.carnet.proprietes.termine = { type: "case" };
    js.carnet.aujourdhui = { echeance: "echeance", fait: { propriete: "termine", valeur: true } };
    fs.writeFileSync(path.join(b.espace, "Courses.md"), "# Courses\n\n```base\n" + YAML.stringify(js) + "```\n");
    const rel = "Courses/Pain.md";
    fs.mkdirSync(path.join(b.espace, "Courses"), { recursive: true });
    const original = `---\necheance: ${jour}\n---\n# Pain\n`;
    fs.writeFileSync(path.join(b.espace, rel), original);
    b.app.espace.appliquer(await b.app.espace.traiter(["Courses.md", "Courses", rel]));
    const a = await b.req("GET", "/api/aujourdhui");
    const t = a.json.aujourdhui.find((x: { chemin: string }) => x.chemin === rel);
    assert.ok(t, JSON.stringify(a.json.aujourdhui.map((x: { chemin: string }) => x.chemin)));
    assert.equal(t.fiche.absente, true);
    const r = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: true }, entetes: { "If-Match": t.fiche.etag } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(lire(rel), `---\necheance: ${jour}\ntermine: true\n---\n# Pain\n`);
    const u = await b.req("POST", "/api/aujourdhui/fiche", { corps: { chemin: rel, fait: false, absente: true }, entetes: { "If-Match": r.json.etag } });
    assert.equal(u.statut, 200, u.texte);
    assert.equal(lire(rel), original);
  });

  test("déclaration retirée : plus rien ne remonte", async () => {
    fs.writeFileSync(path.join(b.espace, "Suivi.md"), page(false));
    b.app.espace.appliquer(await b.app.espace.traiter(["Suivi.md"]));
    const r = await b.req("GET", "/api/aujourdhui");
    assert.deepEqual([...r.json.enRetard, ...r.json.aujourdhui, ...r.json.semaine].filter((x: { fiche?: { base: string } }) => x.fiche?.base === "Suivi.md"), []);
  });
});
