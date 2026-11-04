// Carnet · tests K14-01 « Vues sans YAML » : nouvelle vue, dupliquer, renommer, supprimer, « Enregistrer comme
// nouvelle vue » (vue de départ remise comme avant). Réécriture chirurgicale : tout le reste à l'octet, ou refus.
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import YAML from "yaml";
import { demarrerBanc } from "./aide.ts";
import type { Banc } from "./aide.ts";
import { changerVues, etatVue, lireDefinition, reecrireVue, retablirVue } from "../src/bases-yaml.ts";

const BLOC = `filters:
  and:
    - file.inFolder("Démo/CRM")   # seulement les fiches
# une clé inconnue de Carnet, conservée
inconnue: gardée
views:
  - type: table
    name: À relancer   # la vue d'Aujourd'hui
    filters:
      and:
        - prochaine_relance.date() <= today()
    order:
      - file.name
      - statut
  - type: table
    name: Tous
    order: [file.name, statut, prochaine_relance]
    largeurs:
      statut: 140
carnet:
  dossier: Démo/CRM
  proprietes:
    statut: { type: statut, options: [Ouvert, Gagné, Perdu] }
`;

const js = (s: string) => YAML.parse(s);
const noms = (s: string) => lireDefinition(s).def!.vues.map((v) => v.nom);

describe("K14-01 · vues depuis l'interface (réécriture du bloc)", () => {
  test("nouvelle vue : copie de la vue courante (filtres, tri, colonnes, clés inconnues), ajoutée à la fin", () => {
    const r = changerVues(BLOC, 1, { nouvelleVue: { nom: "  Mes   prospects " } });
    assert.equal(r.vue, 2);
    assert.equal(r.nom, "Mes prospects");
    assert.deepEqual(noms(r.source), ["À relancer", "Tous", "Mes prospects"]);
    const v = js(r.source).views[2];
    assert.deepEqual(v, { type: "table", name: "Mes prospects", order: ["file.name", "statut", "prochaine_relance"], largeurs: { statut: 140 } });
    // tout le texte d'avant est là, à l'octet, et la nouvelle vue est insérée juste avant « carnet: »
    const i = BLOC.indexOf("carnet:");
    assert.ok(r.source.startsWith(BLOC.slice(0, i)));
    assert.ok(r.source.endsWith(BLOC.slice(i)));
  });

  test("dupliquer : « (copie) », puis « (copie 2) » ; le nom n'est jamais un doublon", () => {
    const a = changerVues(BLOC, 0, { dupliquerVue: true });
    assert.equal(a.nom, "À relancer (copie)");
    const b2 = changerVues(a.source, 0, { dupliquerVue: true });
    assert.equal(b2.nom, "À relancer (copie 2)");
    const c = changerVues(b2.source, 2, { dupliquerVue: true });
    assert.equal(c.nom, "À relancer (copie 3)");
    assert.deepEqual(js(c.source).views[4].filters, js(BLOC).views[0].filters);
  });

  test("renommer : seule la valeur change, commentaire de fin de ligne gardé ; même nom = inchangé", () => {
    const r = changerVues(BLOC, 0, { renommerVue: "À relancer bis" });
    assert.equal(r.source, BLOC.replace("name: À relancer   #", "name: À relancer bis   #"));
    assert.equal(changerVues(BLOC, 0, { renommerVue: "À relancer" }).source, BLOC);
    // casse seule changée : permis (ce n'est pas un doublon d'une AUTRE vue)
    assert.equal(changerVues(BLOC, 1, { renommerVue: "TOUS" }).source, BLOC.replace("name: Tous", "name: TOUS"));
    // nom qui demande des guillemets en YAML : écrit proprement, relu à l'identique
    const g = changerVues(BLOC, 1, { renommerVue: "Tous: #1" });
    assert.equal(js(g.source).views[1].name, "Tous: #1");
    // vue sans name : la clé est ajoutée
    const sans = "views:\n  - type: table\n    order:\n      - file.name\n";
    assert.equal(js(changerVues(sans, 0, { renommerVue: "Liste" }).source).views[0].name, "Liste");
  });

  test("noms vides, trop longs ou en double : refus lisible (casse et accents ignorés)", () => {
    assert.throws(() => changerVues(BLOC, 1, { nouvelleVue: { nom: "   " } }), /Nom vide/);
    assert.throws(() => changerVues(BLOC, 1, { nouvelleVue: { nom: "x".repeat(81) } }), /trop long/);
    assert.throws(() => changerVues(BLOC, 1, { nouvelleVue: { nom: "a relancer" } }), /s'appelle déjà « À relancer »/);
    assert.throws(() => changerVues(BLOC, 1, { renommerVue: "À RELANCER" }), /s'appelle déjà/);
    assert.throws(() => changerVues(BLOC, 1, { renommerVue: "" }), /Nom vide/);
    // « Vue 2 » est le nom affiché d'une vue sans name
    assert.throws(() => changerVues("views:\n  - type: table\n    name: A\n  - type: table\n", 0, { renommerVue: "vue 2" }), /déjà/);
  });

  test("supprimer : la vue disparaît (ses commentaires avec elle), le reste à l'octet ; jamais la dernière", () => {
    const r = changerVues(BLOC, 0, { supprimerVue: true });
    assert.equal(r.vue, 0);
    const debut = BLOC.indexOf("  - type: table\n    name: À relancer");
    const fin = BLOC.indexOf("  - type: table\n    name: Tous");
    assert.equal(r.source, BLOC.slice(0, debut) + BLOC.slice(fin));
    const r2 = changerVues(BLOC, 1, { supprimerVue: true });
    assert.equal(r2.vue, 0);
    assert.deepEqual(noms(r2.source), ["À relancer"]);
    assert.throws(() => changerVues(r2.source, 0, { supprimerVue: true }), /dernière vue/);
    assert.throws(() => changerVues("filters: a == 1\n", 0, { supprimerVue: true }), /dernière vue/);
  });

  test("créer puis supprimer redonne le bloc à l'octet", () => {
    const a = changerVues(BLOC, 1, { nouvelleVue: { nom: "Essai" } });
    assert.equal(changerVues(a.source, a.vue, { supprimerVue: true }).source, BLOC);
    const d = changerVues(BLOC, 0, { dupliquerVue: true });
    assert.equal(changerVues(d.source, d.vue, { supprimerVue: true }).source, BLOC);
  });

  test("« Enregistrer comme nouvelle vue » : la vue filtrée est copiée, la vue de départ revient à l'octet", () => {
    // parcours réel : filtrer « Tous » (3 filtres), puis enregistrer comme « À relancer bis »
    const avant = etatVue(BLOC, 1)!;
    assert.deepEqual(avant, {});
    let s = BLOC;
    for (const f of ["prochaine_relance.date() <= today()", "statut != \"Gagné\"", "statut != \"Perdu\""]) s = reecrireVue(s, 1, { ajouterFiltre: f });
    s = reecrireVue(s, 1, { tri: [{ propriete: "prochaine_relance", sens: "ASC" }] });
    const r = changerVues(s, 1, { nouvelleVue: { nom: "À relancer bis", retablir: avant } });
    assert.equal(r.retablie, true);
    assert.equal(r.vue, 2);
    const v = js(r.source).views;
    assert.deepEqual(v[2].filters, { and: ["prochaine_relance.date() <= today()", "statut != \"Gagné\"", "statut != \"Perdu\""] });
    assert.deepEqual(v[2].sort, [{ property: "prochaine_relance", direction: "ASC" }]);
    // « Tous » exactement comme avant : le bloc = l'original + la nouvelle vue insérée avant « carnet: »
    const i = BLOC.indexOf("carnet:");
    assert.ok(r.source.startsWith(BLOC.slice(0, i)), r.source);
    assert.ok(r.source.endsWith(BLOC.slice(i)));
    // sans « retablir » : la vue de départ garde ses filtres
    const r2 = changerVues(s, 1, { nouvelleVue: { nom: "Autre" } });
    assert.equal(r2.retablie, undefined);
    assert.equal(js(r2.source).views[1].filters.and.length, 3);
  });

  test("retablirVue : filtres d'origine ajoutés à la fin retirés à l'octet ; sinon réécrits ou refus sans perte", () => {
    const avant = etatVue(BLOC, 0)!;
    const plus = reecrireVue(reecrireVue(BLOC, 0, { ajouterFiltre: "a == 1" }), 0, { ajouterFiltre: "b == 2" });
    assert.equal(retablirVue(plus, 0, avant), BLOC);
    // un filtre d'origine retiré puis remis : la liste est réécrite (sens identique)
    const moins = reecrireVue(BLOC, 0, { retirerFiltre: 0 });
    assert.deepEqual(js(retablirVue(moins, 0, avant)).views[0], js(BLOC).views[0]);
  });

  test("refus : vues sur une ligne, vue introuvable, 20 vues au plus ; rien d'autre ne change", () => {
    assert.throws(() => changerVues("views: [{type: table, name: A}]", 0, { dupliquerVue: true }), /une ligne/);
    assert.throws(() => changerVues(BLOC, 5, { renommerVue: "X" }), /introuvable/);
    let s = "views:\n  - type: table\n    name: V\n";
    for (let k = 0; k < 19; k++) s = changerVues(s, 0, { dupliquerVue: true }).source;
    assert.equal(lireDefinition(s).def!.vues.length, 20);
    assert.throws(() => changerVues(s, 0, { dupliquerVue: true }), /au plus 20 vues/);
  });

  test("raccourci « À relancer » : filtres et tri imposés à la copie (colonnes gardées), expressions vérifiées", () => {
    const r = changerVues(BLOC, 1, { nouvelleVue: { nom: "À relancer 2", filtres: ["prochaine_relance.date() <= today()", 'statut != "Gagné"'], tri: [{ propriete: "prochaine_relance", sens: "ASC" }] } });
    const v = js(r.source).views[2];
    assert.deepEqual(v.filters, { and: ["prochaine_relance.date() <= today()", 'statut != "Gagné"'] });
    assert.deepEqual(v.sort, [{ property: "prochaine_relance", direction: "ASC" }]);
    assert.deepEqual(v.order, ["file.name", "statut", "prochaine_relance"]);
    // filtres vides : la copie d'une vue filtrée n'en garde aucun
    assert.equal(js(changerVues(BLOC, 0, { nouvelleVue: { nom: "Sans filtre", filtres: [] } }).source).views[2].filters, undefined);
    assert.throws(() => changerVues(BLOC, 1, { nouvelleVue: { nom: "X", filtres: ["eval(1)"] } }), /Filtre refusé/);
    assert.throws(() => changerVues(BLOC, 1, { nouvelleVue: { nom: "X", tri: [{ propriete: "formula.x", sens: "ASC" }] } }), /Tri/);
  });

  test("bloc sans « views » : la vue implicite « Tableau » devient explicite puis est copiée", () => {
    const r = changerVues("filters: a == 1\n", 0, { nouvelleVue: { nom: "Ouvertes" } });
    assert.deepEqual(js(r.source).views, [{ type: "table", name: "Tableau" }, { type: "table", name: "Ouvertes" }]);
    assert.equal(r.vue, 1);
  });
});

// ------------------------------------------------------------------------------------------------ route

let b: Banc;
before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

describe("K14-01 · POST /api/base/reecrire (vues)", () => {
  test("nouvelle vue, renommer, supprimer : 200 avec la vue à montrer ; rien n'est écrit sur le disque", async () => {
    const r = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 1, changement: { nouvelleVue: { nom: "Neuve" } } } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.vue, 2);
    assert.equal(r.json.nom, "Neuve");
    assert.equal(r.json.inchange, false);
    assert.deepEqual(r.json.avant, {});
    const f = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 0, changement: { ajouterFiltre: "a == 1" } } });
    assert.equal(f.statut, 200, f.texte);
    assert.deepEqual(f.json.avant, { filters: { and: ["prochaine_relance.date() <= today()"] } });
    assert.deepEqual(f.json.apres, { filters: { and: ["prochaine_relance.date() <= today()", "a == 1"] } });
    const s = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 1, changement: { supprimerVue: true } } });
    assert.equal(s.statut, 200, s.texte);
    assert.equal(s.json.vue, 0);
  });

  test("refus lisibles (422) et requêtes mal formées (400)", async () => {
    const d = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 1, changement: { renommerVue: "à relancer" } } });
    assert.equal(d.statut, 422);
    assert.match(d.json.message ?? d.texte, /s'appelle déjà/);
    for (const changement of [
      { supprimerVue: "oui" }, { dupliquerVue: 1 }, { nouvelleVue: "x" }, { nouvelleVue: { nom: 3 } },
      { renommerVue: "A", supprimerVue: true }, { renommerVue: "A", ajouterFiltre: "a == 1" },
      { nouvelleVue: { nom: "A", retablir: { autre: 1 } } },
    ]) {
      const r = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 0, changement } });
      assert.equal(r.statut, 400, JSON.stringify(changement));
    }
    const sans = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC, vue: 0, changement: { dupliquerVue: true } }, entetes: { "X-Carnet": undefined } });
    assert.equal(sans.statut, 403);
  });
});
