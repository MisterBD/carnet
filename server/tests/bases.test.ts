// Carnet · tests du lot 2 « Bases » : grammaire fermée, contrat de valeurs, résultat déterministe, réécriture
// chirurgicale du bloc, routes (sécurité des chemins comprise).
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";
import {
  analyserExpression, ecrireFiltreSimple, ErreurExpression, lireDate, lireFiltreSimple, validerSaisie,
} from "../../shared/bases.ts";
import { lireFrontmatterBase, poserCle, reecrireVue, trouverBlocsBase } from "../src/bases-yaml.ts";

export const BLOC_SUIVI = `filters:
  and:
    - file.inFolder("Essais/Suivi")   # seulement le dossier de la base
# vues de la base
views:
  - type: table
    name: Tableau
    filters:
      and:
        - 'statut != "Terminé"'
    order:
      - file.name
      - categorie
      - priorite
      - statut
      - echeance
      - notes
    sort:
      - property: echeance
        direction: ASC
    largeurs:
      statut: 140
properties:
  file.name:
    displayName: Tâche
  echeance:
    displayName: Échéance
inconnue_de_carnet: conservée
carnet:
  dossier: Essais/Suivi
  proprietes:
    statut:
      type: statut
      options: [À faire, En cours, Terminé]
    priorite:
      type: selection
      options: [Haute, Moyenne, Basse]
    categorie:
      type: selection
      options: [Business, Perso, Admin]
    echeance:
      type: date
    notes:
      type: texte
    compte:
      type: nombre
    fait:
      type: case
  nouvelle:
    statut: À faire`;

export const PAGE_SUIVI = `# Suivi\n\nLa base des essais.\n\n\`\`\`base\n${BLOC_SUIVI}\n\`\`\`\n\nFin de page.\n`;

export const ENTREES: Record<string, string> = {
  "Essais/Suivi/Appeler la banque.md": "---\nstatut: À faire\npriorite: Haute\ncategorie: Admin\necheance: 2026-10-12\nnotes: avant midi\n---\n# Appeler la banque\n",
  "Essais/Suivi/Relire le devis.md": "---\nstatut: En cours\npriorite: Moyenne\necheance: 2026-10-11\n---\n# Relire le devis\n",
  "Essais/Suivi/Classer les factures.md": "---\nstatut: Terminé\necheance: 2026-10-01\n---\n# Classer les factures\n",
  "Essais/Suivi/Sans statut.md": "---\npriorite: Basse\n---\n# Sans statut\n",
  "Essais/Suivi/Statut nul.md": "---\nstatut: null\necheance:\n---\n# Statut nul\n",
  "Essais/Suivi/Statut vide.md": "---\nstatut: \"\"\ncompte: 0\nfait: false\n---\n# Statut vide\n",
  "Essais/Suivi/En double.md": "---\nstatut: À faire\nstatut: Terminé\n---\n# En double\n",
  "Essais/Suivi/Bloqué.md": "---\nstatut: Bloqué\nid: \"00123\"\n# commentaire\nnotes: |\n  ligne 1\n  ligne 2\ninconnu: {a: 1}\n---\n# Bloqué\n\nCorps #urgent\n",
  "Essais/Autre.md": "---\nstatut: À faire\n---\n# Autre\n",
};

let b: Banc;
before(async () => {
  b = await demarrerBanc({
    preparer: async (_r, espace) => {
      for (const [rel, contenu] of Object.entries({ ...ENTREES, "Essais/Suivi.md": PAGE_SUIVI })) {
        await fsp.mkdir(path.dirname(path.join(espace, rel)), { recursive: true });
        await fsp.writeFile(path.join(espace, rel), contenu);
      }
      await fsp.mkdir(path.join(espace, "Privé"), { recursive: true });
      await fsp.writeFile(path.join(espace, "Privé/Base.md"), "```base\nviews:\n  - type: table\n```\n");
    },
  });
});
after(async () => { await b.fermer(); });

const lireDisque = (rel: string) => fs.readFileSync(path.join(b.espace, rel), "utf8");

// ------------------------------------------------------------------------------------------------ grammaire

describe("grammaire fermée des expressions", () => {
  test("le sous-ensemble est accepté", () => {
    for (const e of [
      'statut == "En cours"', 'statut != "Terminé"', "compte >= 2", "!fait", 'file.inFolder("Essais")', 'file.hasTag("urgent", "projet")',
      'file.hasProperty("statut")', 'notes.contains("midi")', "statut.isEmpty()", 'note["Échéance"] < today()', 'echeance > date("2026-10-11")',
      '(a == 1 || b == 2) && !c.isEmpty()', 'notes.lower().contains("midi")', 'file.name.startsWith("A")', "file.mtime > now()", 'note.statut == "x"',
    ]) assert.doesNotThrow(() => analyserExpression(e), e);
  });

  test("tout le reste est une erreur explicite (jamais exécuté)", () => {
    const refus: Array<[string, RegExp]> = [
      ["1 + 1", /calcul/],
      ['/abc/.matches(notes)', /expressions régulières/],
      ['require("fs")', /Fonction non prise en charge/],
      ['constructor.constructor("return process")()', /Méthode non prise en charge|non pris en charge/],
      ['this.file.name == "x"', /this/],
      ["formula.prix > 2", /formules/],
      ['file.hasLink("x")', /non prise en charge/],
      ['notes.split(",")', /Méthode non prise en charge/],
      ['today() + "7x"', /Unité de durée inconnue/],
      ['"a" + "b"', /calcul/],
      ["compte - 1", /calcul/],
      ["statut = 1", /affectation/],
      ["a == 1 == 2", /enchaînées/],
      ["[1, 2].contains(1)", /listes littérales/],
      ['statut == "ouvert', /non fermé/],
      ['date("2026-13-45")', /date/],
      ["`x`", /gabarits/],
      ["statut ==", /incomplète/],
      ["(".repeat(40) + "a" + ")".repeat(40), /imbriquée/],
    ];
    for (const [e, re] of refus) {
      assert.throws(() => analyserExpression(e), (x: unknown) => x instanceof ErreurExpression && re.test(x.message), e);
    }
  });

  test("filtres simples : écriture puis relecture à l'identique", () => {
    const cas = [
      { propriete: "statut", operateur: "est", valeur: "En cours" },
      { propriete: "statut", operateur: "nest_pas", valeur: 'Dit "non"' },
      { propriete: "Échéance", operateur: "avant", valeur: "2026-10-12" },
      { propriete: "date de fin", operateur: "vide", valeur: null },
      { propriete: "compte", operateur: "sup", valeur: 3 },
      { propriete: "fait", operateur: "coche", valeur: null },
      { propriete: "notes", operateur: "ne_contient_pas", valeur: "x" },
    ] as const;
    for (const f of cas) {
      const e = ecrireFiltreSimple(f);
      assert.deepEqual(lireFiltreSimple(e), f, e);
    }
  });

  test("dates : jour (minuit Europe/Paris), instant avec fuseau, dates impossibles refusées", () => {
    assert.equal(new Date(lireDate("2026-10-12")!.ms).toISOString(), "2026-10-11T22:00:00.000Z");
    assert.equal(new Date(lireDate("2026-01-12")!.ms).toISOString(), "2026-01-11T23:00:00.000Z");
    assert.equal(new Date(lireDate("2026-10-12T08:30:00+02:00")!.ms).toISOString(), "2026-10-12T06:30:00.000Z");
    assert.equal(lireDate("2026-02-30"), null);
    assert.equal(lireDate("12/10/2026"), null);
  });

  test("validation des saisies selon le type déclaré", () => {
    assert.equal(validerSaisie({ type: "date", options: null }, "2026-13-45").ok, false);
    assert.equal(validerSaisie({ type: "nombre", options: null }, "12").ok, false);
    assert.equal(validerSaisie({ type: "nombre", options: null }, Number.POSITIVE_INFINITY).ok, false);
    assert.equal(validerSaisie({ type: "statut", options: ["À faire"] }, "Bloqué").ok, false);
    assert.deepEqual(validerSaisie({ type: "texte", options: null }, "00123"), { ok: true, valeur: "00123" });
    assert.deepEqual(validerSaisie({ type: "case", options: null }, false), { ok: true, valeur: false });
    assert.deepEqual(validerSaisie({ type: "statut", options: ["À faire"] }, null), { ok: true, valeur: null });
  });
});

describe("lecture du frontmatter (YAML 1.2 strict)", () => {
  test("absente, null, vide, 0, false, liste, et anomalies jamais devinées", () => {
    const l = lireFrontmatterBase('a: null\nb:\nc: ""\nd: 0\ne: false\nf: [x, 2]\ng: 1\ng: 2\nh: &x 3\ni: *x\nj: !!str 4\nk: {z: 1}\nl: .inf\n"<<": 1\nm: 00123\nn: "00123"\no: 2026-10-12\n');
    const v = (k: string) => l.proprietes.get(k);
    assert.deepEqual(v("a"), { etat: "valeur", valeur: null, brut: "null" });
    assert.equal(v("b")!.etat, "valeur");
    assert.equal((v("b") as { valeur: unknown }).valeur, null);
    assert.equal((v("c") as { valeur: unknown }).valeur, "");
    assert.equal((v("d") as { valeur: unknown }).valeur, 0);
    assert.equal((v("e") as { valeur: unknown }).valeur, false);
    assert.deepEqual((v("f") as { valeur: unknown }).valeur, ["x", 2]);
    for (const k of ["g", "h", "i", "j", "k", "l", "<<"]) assert.equal(v(k)!.etat, "anomalie", k);
    assert.match((v("g") as { raison: string }).raison, /double/);
    assert.equal((v("m") as { valeur: unknown }).valeur, 123, "00123 sans guillemets est un nombre en YAML 1.2 (documenté)");
    assert.equal((v("n") as { valeur: unknown }).valeur, "00123");
    assert.equal((v("o") as { valeur: unknown }).valeur, "2026-10-12", "une date YAML reste un texte (schéma core)");
    assert.equal(v("zz"), undefined);
    assert.ok(lireFrontmatterBase("a: [").yamlInvalide);
  });

  test("blocs ```base : premier niveau seulement, pas dans un autre bloc de code", () => {
    const md = "x\n\n````md\n```base\nfaux: 1\n```\n````\n\n```base\nviews: []\n```\n\n~~~base\na: 1\n~~~\n";
    const blocs = trouverBlocsBase(md);
    assert.equal(blocs.length, 2);
    assert.equal(blocs[0].source, "views: []");
    assert.equal(blocs[1].source, "a: 1");
  });
});

// ------------------------------------------------------------------------------------------------ routes de lecture

describe("GET /api/base : résultat déterministe", () => {
  test("dossier + statut + tri explicite ; les autres pages exclues ; aucun fichier réécrit", async () => {
    const avant = Object.fromEntries(Object.keys(ENTREES).map((k) => [k, [lireDisque(k), fs.statSync(path.join(b.espace, k)).mtimeMs]]));
    const r = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=0`);
    assert.equal(r.statut, 200, r.texte);
    const titres = r.json.lignes.map((l: { titre: string }) => l.titre);
    // échéance croissante, puis les vides (absente, null) à la fin, départagés par le chemin
    assert.deepEqual(titres, ["Relire le devis", "Appeler la banque", "Bloqué", "Sans statut", "Statut nul", "Statut vide"]);
    assert.ok(!titres.includes("Classer les factures"), "Terminé exclu");
    assert.ok(!titres.includes("Autre"), "hors dossier exclu");
    assert.deepEqual(r.json.nonClassees.map((x: { titre: string }) => x.titre), ["En double"]);
    assert.match(r.json.nonClassees[0].raison, /double/);
    assert.equal(r.json.total, 6);
    assert.deepEqual(r.json.colonnes.map((c: { libelle: string }) => c.libelle), ["Tâche", "categorie", "priorite", "statut", "Échéance", "notes"]);
    assert.deepEqual(r.json.tri, [{ propriete: "echeance", sens: "ASC" }]);
    assert.equal(r.json.dossier, "Essais/Suivi");
    assert.ok(r.json.avertissements.some((a: string) => a.includes("inconnue_de_carnet")));
    // relecture identique : déterministe
    const r2 = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=0`);
    assert.deepEqual(r2.json.lignes, r.json.lignes);
    for (const [k, [c, m]] of Object.entries(avant)) {
      assert.equal(lireDisque(k), c, k);
      assert.equal(fs.statSync(path.join(b.espace, k)).mtimeMs, m, k);
    }
  });

  test("cellules : absente, nulle, vide, 0, false, option hors liste, anomalie", async () => {
    const r = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=0`);
    const ligne = (t: string) => r.json.lignes.find((l: { titre: string }) => l.titre === t);
    assert.deepEqual(ligne("Sans statut").cellules.statut, { etat: "absente" });
    assert.deepEqual(ligne("Statut nul").cellules.statut, { etat: "nulle" });
    assert.deepEqual(ligne("Statut nul").cellules.echeance, { etat: "nulle" });
    assert.deepEqual(ligne("Statut vide").cellules.statut, { etat: "valeur", valeur: "", horsListe: true });
    assert.deepEqual(ligne("Bloqué").cellules.statut, { etat: "valeur", valeur: "Bloqué", horsListe: true });
    assert.equal(ligne("Bloqué").cellules.notes.valeur, "ligne 1\nligne 2\n");
    assert.equal(ligne("Appeler la banque").cellules["file.name"].texte, "Appeler la banque");
    assert.match(ligne("Appeler la banque").etag, /^"[0-9a-f]{16}"$/);
  });
});

async function evaluer(source: string, vue = 0) {
  return b.req("POST", "/api/base/evaluer", { corps: { chemin: "Essais/Suivi.md", source, vue } });
}

const DOSSIER = 'filters:\n  and:\n    - file.inFolder("Essais/Suivi")\n';
const noms = (r: { json: { lignes: Array<{ titre: string }> } }) => r.json.lignes.map((l) => l.titre).sort();

describe("contrat de valeurs", () => {
  test("== null : absente ou null ; isEmpty : absente, null ou vide ; hasProperty : clé présente", async () => {
    const nul = await evaluer(`${DOSSIER}    - statut == null\n`);
    assert.deepEqual(noms(nul), ["Sans statut", "Statut nul"]);
    const vide = await evaluer(`${DOSSIER}    - statut.isEmpty()\n`);
    assert.deepEqual(noms(vide), ["Sans statut", "Statut nul", "Statut vide"]);
    const a = await evaluer(`${DOSSIER}    - '!file.hasProperty("statut")'\n`);
    assert.deepEqual(noms(a), ["Sans statut"]);
    const ch = await evaluer(`${DOSSIER}    - 'statut == ""'\n`);
    assert.deepEqual(noms(ch), ["Statut vide"]);
  });

  test("0 et false sont des valeurs, pas des absences", async () => {
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - compte == 0\n`)), ["Statut vide"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - fait == false\n`)), ["Statut vide"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - '!compte.isEmpty()'\n`)), ["Statut vide"]);
    const r = await evaluer(`${DOSSIER}    - file.hasProperty("fait")\nviews:\n  - type: table\n    order: [compte, fait]\n`);
    assert.deepEqual(r.json.lignes[0].cellules.compte, { etat: "valeur", valeur: 0 });
    assert.deepEqual(r.json.lignes[0].cellules.fait, { etat: "valeur", valeur: false });
  });

  test("texte et nombre ne se confondent pas ; casse respectée ; dates comparées comme des dates", async () => {
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'id == "00123"'\n`)), ["Bloqué"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - id == 123\n`)), []);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'statut == "en cours"'\n`)), []);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'statut.lower() == "en cours"'\n`)), ["Relire le devis"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'echeance < date("2026-10-12")'\n`)), ["Classer les factures", "Relire le devis"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'echeance == date("2026-10-12")'\n`)), ["Appeler la banque"]);
    assert.deepEqual(noms(await evaluer(`${DOSSIER}    - 'file.hasTag("URGENT")'\n`)), ["Bloqué"]);
  });

  test("clé en double : jamais rangée au hasard, même avec un filtre qui ne la regarde pas… seulement si nécessaire", async () => {
    const r = await evaluer(`${DOSSIER}    - 'statut == "Terminé"'\n`);
    assert.deepEqual(noms(r), ["Classer les factures"]);
    assert.deepEqual(r.json.nonClassees.map((x: { titre: string }) => x.titre), ["En double"]);
    // un filtre décidé sans la propriété illisible range la page normalement (logique à trois valeurs)
    const r2 = await evaluer(`${DOSSIER}    - 'file.name == "En double.md" || statut == "x"'\n`);
    assert.deepEqual(noms(r2), ["En double"]);
    assert.equal(r2.json.nonClassees.length, 0);
    const cel = r2.json.lignes[0].cellules;
    assert.equal(cel["file.name"].etat, "valeur");
  });
});

describe("requête interdite", () => {
  test("fonction non autorisée, code, regex, formule, vue non prise en charge : 422 explicite, pas de tableau vide", async () => {
    const page = lireDisque("Essais/Suivi.md");
    for (const e of ['process.exit()', 'require("child_process")', "/a+$/.matches(notes)", "formula.x > 1", "this.file.name == 1", '1 + 1 == 2']) {
      const r = await evaluer(`filters:\n  and:\n    - '${e.replace(/'/g, "''")}'\n`);
      assert.equal(r.statut, 422, e);
      assert.equal(r.json.raison, "base_invalide");
      assert.equal(r.json.lignes, undefined, "aucune ligne renvoyée");
      assert.ok(r.json.erreurs.length >= 1);
      assert.match(r.json.erreurs[0].ou, /filters\.and\[0\]/);
    }
    const kanban = await evaluer("views:\n  - type: kanban\n    name: K\n");
    assert.equal(kanban.statut, 422);
    assert.match(kanban.json.erreurs[0].message, /tableau/);
    const yaml = await evaluer("views: [\n");
    assert.equal(yaml.statut, 422);
    const formeInconnue = await evaluer("filters:\n  xor:\n    - a\n");
    assert.equal(formeInconnue.statut, 422);
    assert.equal(lireDisque("Essais/Suivi.md"), page, "aucune modification du .md");
  });
});

// ------------------------------------------------------------------------------------------------ réécriture du bloc

describe("réécriture chirurgicale du bloc", () => {
  test("tri : seule la clé sort change ; commentaires, clés inconnues et autres vues intacts", () => {
    const s = reecrireVue(BLOC_SUIVI, 0, { tri: [{ propriete: "statut", sens: "DESC" }] });
    assert.ok(s.includes("    sort:\n      - property: statut\n        direction: DESC\n    largeurs:"));
    const avant = BLOC_SUIVI.split("\n"), apres = s.split("\n");
    // tout ce qui n'est pas le tri est identique, ligne pour ligne
    const sansTri = (l: string[]) => l.filter((x, i) => !(i > 0 && /^\s+(sort:|- property:|direction:)/.test(x)));
    assert.deepEqual(sansTri(apres), sansTri(avant));
    assert.ok(s.includes("# seulement le dossier de la base") && s.includes("# vues de la base") && s.includes("inconnue_de_carnet: conservée"));
  });

  test("ajouter puis retirer un filtre : le bloc revient à l'octet", () => {
    const plus = reecrireVue(BLOC_SUIVI, 0, { ajouterFiltre: 'priorite == "Haute"' });
    assert.ok(plus.includes("        - 'statut != \"Terminé\"'\n        - priorite == \"Haute\"\n"));
    const moins = reecrireVue(plus, 0, { retirerFiltre: 1 });
    assert.equal(moins, BLOC_SUIVI);
    const sansTri = reecrireVue(BLOC_SUIVI, 0, { tri: null });
    assert.ok(!sansTri.includes("sort:"));
    assert.equal(reecrireVue(sansTri, 0, { tri: [{ propriete: "echeance", sens: "ASC" }] }).replace("    largeurs:\n      statut: 140\n    sort:\n      - property: echeance\n        direction: ASC\n", "    sort:\n      - property: echeance\n        direction: ASC\n    largeurs:\n      statut: 140\n"), BLOC_SUIVI);
  });

  test("vue sans filtres ni vues : créés ; filtre texte unique : transformé en liste « and »", () => {
    const a = reecrireVue("filters: file.inFolder(\"X\")", 0, { ajouterFiltre: "fait == true" });
    assert.equal(a, 'filters: file.inFolder("X")\nviews:\n  - type: table\n    name: Tableau\n    filters:\n      and:\n        - fait == true');
    const c = reecrireVue("views:\n  - type: table\n    filters: 'a == 1'\n", 0, { ajouterFiltre: "b == 2" });
    assert.equal(c, "views:\n  - type: table\n    filters:\n      and:\n        - a == 1\n        - b == 2\n");
  });

  test("refus quand la conservation n'est pas garantie", () => {
    assert.throws(() => reecrireVue("views: [{type: table}]", 0, { tri: null }), /une ligne/);
    assert.throws(() => reecrireVue("views:\n  - type: table\n    filters:\n      or:\n        - a == 1\n", 0, { ajouterFiltre: "b == 2" }), /avancés/);
    assert.throws(() => reecrireVue("views:\n  - type: table\n    sort: # tri choisi\n      - property: a\n", 0, { tri: null }), /commentaire/);
    assert.throws(() => reecrireVue(BLOC_SUIVI, 0, { ajouterFiltre: "formula.x > 1" }), /Filtre refusé/);
    assert.throws(() => reecrireVue(BLOC_SUIVI, 3, { tri: null }), /introuvable/);
    assert.throws(() => poserCle("a: 1\na: 2\n", [], "b", 1), /YAML invalide/);
  });

  test("POST /api/base/reecrire : nouveau YAML ou 422, rien d'écrit sur le disque", async () => {
    const page = lireDisque("Essais/Suivi.md");
    const r = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_SUIVI, vue: 0, changement: { ajouterFiltre: 'categorie == "Admin"' } } });
    assert.equal(r.statut, 200, r.texte);
    assert.ok(r.json.source.includes('categorie == "Admin"'));
    const k = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_SUIVI, vue: 0, changement: { ajouterFiltre: "eval(1)" } } });
    assert.equal(k.statut, 422);
    assert.equal(lireDisque("Essais/Suivi.md"), page);
  });
});

// ------------------------------------------------------------------------------------------------ sécurité des chemins

describe("sécurité des routes de bases", () => {
  test("chemins hors espace, cachés, masqués : refusés", async () => {
    for (const c of ["../etc/passwd.md", ".git/config.md", "Privé/Base.md", "/etc/x.md", "Essais/Suivi.txt"]) {
      const r = await b.req("GET", `/api/base?chemin=${q(c)}&bloc=0`);
      assert.ok([400, 403].includes(r.statut), `${c} : ${r.statut}`);
    }
    const p = await b.req("GET", `/api/proprietes?chemin=${q("../x.md")}`);
    assert.ok([400, 403].includes(p.statut));
    const d = await b.req("POST", "/api/base/dossier", { corps: { page: "../Dehors.md", nom: "X" } });
    assert.ok([400, 403].includes(d.statut));
    const e = await b.req("POST", "/api/base/evaluer", { corps: { chemin: ".corbeille/x.md", source: "views: []" } });
    assert.ok([400, 403].includes(e.statut));
  });

  test("mutations sans X-Carnet refusées ; bloc absent : 404", async () => {
    const r = await b.req("POST", "/api/base/reecrire", { corps: { source: "a: 1", vue: 0, changement: { tri: null } }, entetes: { "X-Carnet": undefined } });
    assert.equal(r.statut, 403);
    const n = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=3`);
    assert.equal(n.statut, 404);
  });

  test("POST /api/base/dossier : dossier unique sous la page, jamais d'écrasement", async () => {
    const r1 = await b.req("POST", "/api/base/dossier", { corps: { page: "Essais/Suivi.md", nom: "Tâches" } });
    assert.equal(r1.statut, 201, r1.texte);
    assert.equal(r1.json.dossier, "Essais/Suivi/Tâches");
    const r2 = await b.req("POST", "/api/base/dossier", { corps: { page: "Essais/Suivi.md", nom: "Tâches" } });
    assert.equal(r2.json.dossier, "Essais/Suivi/Tâches 2");
    assert.ok(fs.statSync(path.join(b.espace, "Essais/Suivi/Tâches")).isDirectory());
    const r3 = await b.req("POST", "/api/base/dossier", { corps: { page: "Essais/Suivi.md", nom: "../../x" } });
    assert.equal(r3.statut, 201);
    assert.ok(r3.json.dossier.startsWith("Essais/Suivi/"), r3.json.dossier);
    assert.equal(r3.json.dossier.split("/").length, 3, r3.json.dossier);
    assert.ok(!r3.json.dossier.split("/").some((x: string) => x === ".." || x.startsWith(".")), r3.json.dossier);
  });
});

describe("GET /api/proprietes (panneau)", () => {
  test("types déclarés par la base dont la page est une entrée ; anomalies visibles ; clés d'en-tête masquées", async () => {
    const r = await b.req("GET", `/api/proprietes?chemin=${q("Essais/Suivi/Bloqué.md")}`);
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(r.json.base, { page: "Essais/Suivi.md", titre: "Suivi", bloc: 0 });
    const p = (k: string) => r.json.proprietes.find((x: { cle: string }) => x.cle === k);
    assert.equal(p("statut").type, "statut");
    assert.equal(p("statut").horsListe, true);
    assert.equal(p("id").valeur, "00123");
    assert.equal(p("id").type, "texte");
    assert.equal(p("id").declare, false);
    assert.equal(p("inconnu").etat, "anomalie");
    assert.equal(r.json.etag, r.entetes.etag);
    const hors = await b.req("GET", `/api/proprietes?chemin=${q("Essais/Autre.md")}`);
    assert.equal(hors.json.base, null);
  });
});

// ------------------------------------------------------------------------------------------------ écritures (Ecrivain)

async function poser(chemin: string, cle: string, valeur: unknown, etag: string | undefined, extra: Record<string, unknown> = {}, requete?: string) {
  return b.req("POST", "/api/propriete", {
    corps: { chemin, cle, ...(valeur === undefined ? { retirer: true } : { valeur }), ...extra },
    entetes: { ...(etag ? { "If-Match": etag } : {}), ...(requete ? { "X-Carnet-Requete": requete } : {}) },
  });
}

const etagDe = async (chemin: string) => (await b.req("GET", `/api/page?chemin=${q(chemin)}`)).json.etag as string;

describe("édition localisée", () => {
  test("frontmatter multiligne, commentaires et champs inconnus : seule la propriété ciblée change", async () => {
    const c = "Essais/Suivi/Bloqué.md";
    const avant = lireDisque(c);
    const r = await poser(c, "statut", "En cours", await etagDe(c), { type: "statut", options: ["À faire", "En cours", "Terminé"] });
    assert.equal(r.statut, 200, r.texte);
    const apres = lireDisque(c);
    assert.equal(apres, avant.replace("statut: Bloqué\n", "statut: En cours\n"));
    assert.equal(r.json.contenu, apres);
    assert.equal(r.json.etag, await etagDe(c));
  });

  test("retirer et vider : absente ≠ null", async () => {
    const c = "Essais/Suivi/Relire le devis.md";
    let r = await poser(c, "priorite", null, await etagDe(c));
    assert.equal(r.statut, 200, r.texte);
    assert.match(lireDisque(c), /\npriorite: null\n/);
    r = await poser(c, "priorite", undefined, await etagDe(c));
    assert.equal(r.statut, 200, r.texte);
    assert.ok(!lireDisque(c).includes("priorite"));
  });
});

describe("validation de type", () => {
  test("date, nombre, statut hors liste : refus explicite, rien d'écrit ; 00123 reste une chaîne", async () => {
    const c = "Essais/Suivi/Appeler la banque.md";
    const avant = lireDisque(c);
    const etag = await etagDe(c);
    const refus: Array<[string, unknown, Record<string, unknown>]> = [
      ["echeance", "2026-13-45", { type: "date" }],
      ["echeance", "demain", {}], // type venu de la base dont la page est une entrée
      ["compte", "12", { type: "nombre" }],
      ["compte", "douze", {}],
      ["statut", "Bloqué", { type: "statut", options: ["À faire", "En cours", "Terminé"] }],
      ["statut", "Bloqué", {}],
      ["fait", "oui", {}],
    ];
    for (const [cle, v, extra] of refus) {
      const r = await poser(c, cle, v, etag, extra);
      assert.equal(r.statut, 422, `${cle}=${v} : ${r.texte}`);
      assert.ok(r.json.erreur.length > 10);
    }
    assert.equal(lireDisque(c), avant);
    const t = await poser(c, "notes", "00123", etag, { type: "texte" });
    assert.equal(t.statut, 200, t.texte);
    assert.match(lireDisque(c), /\nnotes: "00123"\n/);
    const l = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=0`);
    const ligne = l.json.lignes.find((x: { titre: string }) => x.titre === "Appeler la banque");
    assert.deepEqual(ligne.cellules.notes, { etat: "valeur", valeur: "00123" });
  });

  test("en-tête que le socle refuse (clé en double, ancre) : ligne marquée non modifiable, écriture refusée (422)", async () => {
    await fsp.writeFile(path.join(b.espace, "Essais/Suivi/Ancre.md"), "---\nstatut: À faire\nmodele: &m x\ncopie: *m\n---\n# Ancre\n");
    await b.app.espace.appliquer(await b.app.espace.traiter(["Essais/Suivi/Ancre.md"]));
    const l = await b.req("GET", `/api/base?chemin=${q("Essais/Suivi.md")}&bloc=0`);
    const ligne = l.json.lignes.find((x: { titre: string }) => x.titre === "Ancre");
    assert.ok(ligne, JSON.stringify(l.json.nonClassees));
    assert.match(ligne.nonModifiable, /ancre|alias/i);
    assert.deepEqual(ligne.cellules.statut, { etat: "valeur", valeur: "À faire" }, "lisible, mais la ligne est en lecture seule");
    const avant = lireDisque("Essais/Suivi/Ancre.md");
    const r = await poser("Essais/Suivi/Ancre.md", "priorite", "Haute", await etagDe("Essais/Suivi/Ancre.md"));
    assert.equal(r.statut, 422);
    assert.equal(lireDisque("Essais/Suivi/Ancre.md"), avant);
  });
});

describe("création et concurrence", () => {
  test("« Nouveau » : nom unique dans le dossier déclaré, valeurs initiales documentées, idempotent", async () => {
    const page = "Essais/Suivi.md";
    const r1 = await b.req("POST", "/api/base/entree", { corps: { page, source: BLOC_SUIVI, titre: "Payer le loyer" }, entetes: { "X-Carnet-Requete": "essai-entree-0001" } });
    assert.equal(r1.statut, 201, r1.texte);
    assert.equal(r1.json.chemin, "Essais/Suivi/Payer le loyer.md");
    assert.equal(lireDisque(r1.json.chemin), "---\nstatut: À faire\n---\n# Payer le loyer\n\n");
    const rejeu = await b.req("POST", "/api/base/entree", { corps: { page, source: BLOC_SUIVI, titre: "Payer le loyer" }, entetes: { "X-Carnet-Requete": "essai-entree-0001" } });
    assert.equal(rejeu.json.chemin, r1.json.chemin, "même geste rejoué : pas de seconde page");
    assert.equal(rejeu.json.rejoue, true);
    const r2 = await b.req("POST", "/api/base/entree", { corps: { page, source: BLOC_SUIVI, titre: "Payer le loyer" }, entetes: { "X-Carnet-Requete": "essai-entree-0002" } });
    assert.equal(r2.json.chemin, "Essais/Suivi/Payer le loyer (2).md");
    assert.equal(lireDisque(r1.json.chemin), "---\nstatut: À faire\n---\n# Payer le loyer\n\n", "jamais d'écrasement");
    const l = await b.req("GET", `/api/base?chemin=${q(page)}&bloc=0`);
    assert.ok(l.json.lignes.some((x: { chemin: string }) => x.chemin === r2.json.chemin), "la nouvelle entrée apparaît dans la base");
    const sansDossier = await b.req("POST", "/api/base/entree", { corps: { page, source: "views:\n  - type: table\n", titre: "X" } });
    assert.equal(sansDossier.statut, 422);
    const dehors = await b.req("POST", "/api/base/entree", { corps: { page, source: "carnet:\n  dossier: ../Dehors\n", titre: "X" } });
    assert.ok([400, 403].includes(dehors.statut), String(dehors.statut));
    const cache = await b.req("POST", "/api/base/entree", { corps: { page, source: "carnet:\n  dossier: Privé/Atelier\n", titre: "X" } });
    assert.equal(cache.statut, 403);
  });

  test("modification externe avant l'envoi : 412 + version actuelle, rien d'écrasé ; renvoi explicite à la nouvelle révision", async () => {
    const c = "Essais/Suivi/Sans statut.md";
    const vue = await etagDe(c);
    fs.writeFileSync(path.join(b.espace, c), "---\npriorite: Haute\nstatut: En cours\n---\n# Sans statut\n\nModifié par un agent.\n");
    const r = await poser(c, "priorite", "Basse", vue, { type: "selection", options: ["Haute", "Moyenne", "Basse"] }, "essai-cellule-0001");
    assert.equal(r.statut, 412);
    assert.match(r.json.contenu, /Modifié par un agent/);
    assert.match(lireDisque(c), /priorite: Haute/);
    const r2 = await poser(c, "priorite", "Basse", r.json.etag, { type: "selection", options: ["Haute", "Moyenne", "Basse"] }, "essai-cellule-0002");
    assert.equal(r2.statut, 200, r2.texte);
    assert.equal(lireDisque(c), "---\npriorite: Basse\nstatut: En cours\n---\n# Sans statut\n\nModifié par un agent.\n");
  });

  test("If-Match obligatoire ; même requête rejouée = un seul effet ; autre opération = 409", async () => {
    const c = "Essais/Suivi/Statut vide.md";
    const sans = await poser(c, "compte", 1, undefined);
    assert.equal(sans.statut, 428);
    const etag = await etagDe(c);
    const a = await poser(c, "compte", 3, etag, { type: "nombre" }, "essai-rejeu-00001");
    assert.equal(a.statut, 200, a.texte);
    const b2 = await poser(c, "compte", 3, etag, { type: "nombre" }, "essai-rejeu-00001");
    assert.equal(b2.statut, 200, b2.texte);
    assert.equal(b2.json.rejoue, true);
    const c2 = await poser(c, "compte", 4, etag, { type: "nombre" }, "essai-rejeu-00001");
    assert.equal(c2.statut, 409);
    assert.match(lireDisque(c), /\ncompte: 3\n/);
  });

  test("sécurité : chemin hors espace ou caché, clé refusée", async () => {
    for (const ch of ["../x.md", ".git/x.md", "Privé/Cachée.md"]) {
      const r = await poser(ch, "a", "b", '"0000000000000000"');
      assert.ok([400, 403].includes(r.statut), `${ch} ${r.statut}`);
    }
    const c = "Essais/Suivi/Statut vide.md";
    for (const cle of ["a: b", "<<", "-x", "x\ny", "#a"]) {
      const r = await poser(c, cle, "v", await etagDe(c));
      assert.equal(r.statut, 422, `${JSON.stringify(cle)} : ${r.texte}`);
    }
  });
});

describe("points d'intégration (lot 8 « Import Notion »)", () => {
  test("bloc généré par l'import : file.folder ==, properties.note.x.displayName, order note.x", async () => {
    const source = `filters:\n  and:\n    - file.folder == "Essais/Suivi"\nproperties:\n  file.name:\n    displayName: Tâche\n  note.statut:\n    displayName: Statut\nviews:\n  - type: table\n    name: Tableau\n    order: [file.name, note.statut, note.priorite]\ncarnet:\n  dossier: Essais/Suivi\n  proprietes:\n    statut: { type: statut, options: [À faire, En cours, Terminé] }\n    priorite: { type: selection, options: [Haute, Moyenne, Basse] }\n    projet: { type: liste }\n`;
    const r = await evaluer(source);
    assert.equal(r.statut, 200, r.texte);
    assert.ok(!r.json.lignes.some((l: { chemin: string }) => l.chemin.startsWith("Essais/Suivi/Tâches/")), "pas les sous-dossiers");
    assert.ok(r.json.lignes.some((l: { titre: string }) => l.titre === "Appeler la banque"));
    assert.deepEqual(r.json.colonnes.map((c: { libelle: string; type: string | null }) => [c.libelle, c.type]), [["Tâche", null], ["Statut", "statut"], ["priorite", "selection"]]);
    assert.deepEqual(r.json.filtresGlobaux, ["dans « Essais/Suivi » (sans sous-dossiers)"]);
    const t = reecrireVue(source, 0, { tri: [{ propriete: "note.statut", sens: "ASC" }] });
    assert.ok(t.includes("    order: [file.name, note.statut, note.priorite]\n    sort:\n      - property: note.statut\n"), t);
  });

  test("propriétés de provenance (id, notion_id, cree, type) : jamais réécrites (422), colonnes en lecture seule", async () => {
    const c = "Essais/Suivi/Relire le devis.md";
    for (const cle of ["notion_id", "id", "cree", "type"]) {
      const r = await poser(c, cle, "x", await etagDe(c));
      assert.equal(r.statut, 422, cle);
      assert.match(r.json.erreur, /provenance/);
    }
    const r = await evaluer(`${DOSSIER}views:\n  - type: table\n    order: [file.name, notion_id, statut]\n`);
    const col = (id: string) => r.json.colonnes.find((x: { id: string }) => x.id === id);
    assert.equal(col("notion_id").modifiable, false);
    assert.equal(col("statut").modifiable, true);
  });
});
