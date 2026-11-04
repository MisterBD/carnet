// Carnet · tests du socle V3 : tâches au format Obsidian Tasks (shared/taches.ts).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import { ErreurFormat } from "../../shared/proprietes.ts";
import { analyserTache, listerTaches, marquerCode, modifierTache } from "../../shared/taches.ts";

const FIXTURE = fs.readFileSync(path.resolve(import.meta.dirname, "fixtures/v3/Tâches datées.md"), "utf8");
const CASSEUR = "- [/] Appeler ✅ 2026-10-09 📅 2026-13-45 📅 2026-10-12 🔁 every week ^t1";

describe("analyserTache", () => {
  test("fixture : chaque catégorie lue comme attendu ; tâche dans le code ignorée par listerTaches", () => {
    const t = listerTaches(FIXTURE);
    const par = (debut: string) => t.find((x) => x.tache.texte.startsWith(debut))!.tache;
    assert.equal(par("Envoyer").echeance, "2026-10-08");
    assert.deepEqual([par("Préparer").echeance, par("Préparer").priorite], ["2026-10-11", "haute"]);
    assert.equal(par("Relire").priorite, "moyenne");
    assert.deepEqual(par("Ranger").marqueurs, []);
    assert.deepEqual([par("Payer").coche, par("Payer").faite], ["x", "2026-10-04"]);
    assert.deepEqual([par("Appeler le fournisseur").priorite, par("Appeler le fournisseur").echeance], ["plus-haute", "2026-10-12"]);
    assert.deepEqual([par("Arroser").recurrence, par("Arroser").echeance], ["every week", "2026-10-13"]);
    assert.equal(par("Commander").echeance, undefined);
    assert.deepEqual(par("Commander").anomalies, ["date invalide après 📅 : 2026-13-45"]);
    assert.deepEqual([par("Classer").debut, par("Classer").prevue, par("Classer").creee], ["2026-10-10", "2026-10-14", "2026-10-01"]);
    assert.equal(par("Vérifier").texte, "Vérifier la sauvegarde #admin");
    assert.match(par("Marqueur inconnu").texte, /🦄 2026-10-12$/);
    assert.deepEqual([par("Atelier").coche, par("Atelier").annulee], ["-", "2026-10-09"]);
    assert.deepEqual([par("Puce").prefixe, par("Puce").priorite], ["* ", "plus-basse"]);
    assert.deepEqual([par("Sous-tâche").prefixe, par("Sous-tâche").priorite], ["  - ", "basse"]);
    assert.ok(!t.some((x) => x.tache.texte.includes("bloc de code")));
    assert.equal(t.length, 15);
  });
  test("ligne casseuse : marqueurs lus depuis la fin, doublon et date invalide signalés, rien d'inventé", () => {
    const a = analyserTache(CASSEUR)!;
    assert.equal(a.coche, "/");
    assert.equal(a.texte, "Appeler");
    assert.equal(a.blocId, "t1");
    assert.equal(a.echeance, undefined);
    assert.equal(a.faite, "2026-10-09");
    assert.equal(a.recurrence, "every week");
    assert.ok(a.anomalies.some((x) => x.includes("📅 en double")));
    assert.ok(a.anomalies.some((x) => x.includes("2026-13-45")));
  });
  test("marqueur au milieu du texte : non interprété, signalé", () => {
    const a = analyserTache("- [ ] Réunion 📅 demain avec l'équipe")!;
    assert.equal(a.echeance, undefined);
    assert.equal(a.marqueurs.length, 0);
    assert.equal(a.anomalies.length, 1);
  });
  test("pas une tâche : null", () => {
    assert.equal(analyserTache("- texte"), null);
    assert.equal(analyserTache("[ ] sans puce"), null);
    assert.equal(analyserTache("-[ ] collé"), null);
  });
});

describe("modifierTache", () => {
  test("aller-retour à l'octet : aucune demande = ligne identique, pour toutes les lignes de la fixture", () => {
    for (const l of FIXTURE.split("\n")) {
      if (analyserTache(l)) assert.equal(modifierTache(l, {}), l);
    }
    assert.equal(modifierTache(CASSEUR + "\r", {}), CASSEUR + "\r");
  });
  test("ligne casseuse : changer seulement la priorité ; cocher puis décocher sans « réparer »", () => {
    assert.equal(modifierTache(CASSEUR, { priorite: "haute" }), "- [/] Appeler ✅ 2026-10-09 📅 2026-13-45 📅 2026-10-12 🔁 every week ⏫ ^t1");
    const cochee = modifierTache(CASSEUR, { coche: true, faite: "2026-10-11" });
    assert.equal(cochee, "- [x] Appeler ✅ 2026-10-11 📅 2026-13-45 📅 2026-10-12 🔁 every week ^t1");
    assert.equal(modifierTache(cochee, { coche: false, faite: null }), "- [ ] Appeler 📅 2026-13-45 📅 2026-10-12 🔁 every week ^t1");
    // l'échéance (doublon) : refus ciblé, la ligne n'est pas touchée
    for (const echeance of ["2026-10-20", null]) {
      assert.throws(() => modifierTache(CASSEUR, { echeance }), (e: unknown) => e instanceof ErreurFormat && e.raison === "marqueur_en_double");
    }
  });
  test("cocher est idempotent : pas de seconde date ✅ ; décocher ne retire rien implicitement", () => {
    const l = "- [ ] Payer 📅 2026-10-12";
    const une = modifierTache(l, { coche: true, faite: "2026-10-11" });
    assert.equal(une, "- [x] Payer 📅 2026-10-12 ✅ 2026-10-11");
    assert.equal(modifierTache(une, { coche: true, faite: "2026-10-12" }), une);
    assert.equal((modifierTache(une, { coche: true, faite: "2026-10-12" }).match(/✅/g) ?? []).length, 1);
    assert.equal(modifierTache(une, { coche: false }), "- [ ] Payer 📅 2026-10-12 ✅ 2026-10-11");
    assert.equal(modifierTache("- [x] V2", { coche: true }), "- [x] V2");
    assert.equal(modifierTache("* [ ] V2", { coche: true }), "* [x] V2");
  });
  test("échéance et priorité : seul le marqueur visé change, ajout en fin de ligne avant ^id, ordre Tasks entre ajouts", () => {
    const l = "  * [ ] Rappeler la banque #admin 📅 2026-10-12 ⏫\u{FE0F} #urgent";
    assert.equal(modifierTache(l, { echeance: "2026-10-13" }), "  * [ ] Rappeler la banque #admin 📅 2026-10-13 ⏫\u{FE0F} #urgent");
    assert.equal(modifierTache(l, { priorite: "basse" }), "  * [ ] Rappeler la banque #admin 📅 2026-10-12 🔽 #urgent");
    assert.equal(modifierTache(l, { priorite: null }), "  * [ ] Rappeler la banque #admin 📅 2026-10-12 #urgent");
    assert.equal(modifierTache("- [ ] a ^b1", { echeance: "2026-10-12", priorite: "haute" }), "- [ ] a ⏫ 📅 2026-10-12 ^b1");
    assert.equal(modifierTache("- [ ] a   ", { echeance: "2026-10-12" }), "- [ ] a 📅 2026-10-12   ");
    assert.equal(modifierTache("- [ ] a 📆 2026-10-12", { echeance: "2026-10-14" }), "- [ ] a 📆 2026-10-14");
  });
  test("refus ciblés : date invalide demandée, date actuelle invalide, marqueur non reconnu dans le texte ; autres marqueurs modifiables", () => {
    const refus = (l: string, c: Parameters<typeof modifierTache>[1], raison: string) =>
      assert.throws(() => modifierTache(l, c), (e: unknown) => e instanceof ErreurFormat && e.statut === 422 && e.raison === raison);
    refus("- [ ] a", { echeance: "2026-02-30" }, "valeur_invalide");
    refus("- [ ] Commander du papier 📅 2026-13-45", { echeance: "2026-10-12" }, "marqueur_invalide");
    refus("- [ ] Réunion 📅 demain", { echeance: "2026-10-12" }, "marqueur_ambigu");
    refus("- texte", { coche: true }, "pas_une_tache");
    assert.equal(modifierTache("- [ ] Commander du papier 📅 2026-13-45", { priorite: "haute" }), "- [ ] Commander du papier 📅 2026-13-45 ⏫");
  });
  test("modifier une tâche d'une page : toutes les autres lignes identiques à l'octet", () => {
    const lignes = FIXTURE.split("\n");
    const t = listerTaches(FIXTURE).find((x) => x.tache.texte.startsWith("Relire"))!;
    const copie = [...lignes];
    copie[t.ligne] = modifierTache(lignes[t.ligne], { coche: true, faite: "2026-10-11", echeance: "2026-10-16" });
    assert.deepEqual(copie.map((l, i) => (l === lignes[i] ? null : i)).filter((x) => x !== null), [t.ligne]);
    assert.equal(copie[t.ligne], "- [x] Relire le devis 📅 2026-10-16 🔼 ✅ 2026-10-11");
  });
  test("marquerCode : clôtures ``` et ~~~", () => {
    assert.deepEqual(marquerCode(["a", "```js", "- [ ] x", "```", "~~~", "b", "~~~", "c"]), [false, true, true, true, true, true, true, false]);
  });
});
