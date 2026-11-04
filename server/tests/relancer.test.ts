// Carnet V3 · lot 12 « À relancer » : dates relatives dans les bases (today(), now(), date(…) ± durée Obsidian),
// filtres relatifs de l'interface, horloge de recette, ligne « À relancer » de l'écran Aujourd'hui.
// Cas R1 à R5 ; R5 (non-régression) = bases.test.ts inchangé hors refus devenus acceptés.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";
import {
  analyserExpression, compilerFiltre, DateBase, decalerDate, ecrireFiltreSimple, ErreurExpression, evaluer, evaluerFiltre, jourIso,
  lireDate, lireDuree, lireFiltreSimple,
} from "../../shared/bases.ts";
import type { EntreeBase, ErreurBase, FiltreSimple, ProprieteLue } from "../../shared/bases.ts";
import { lireDefinition, reecrireVue } from "../src/bases-yaml.ts";

const F = "Europe/Paris";

function entree(nom: string, props: Record<string, unknown>): EntreeBase {
  const proprietes = new Map<string, ProprieteLue>();
  for (const [k, v] of Object.entries(props)) proprietes.set(k, { etat: "valeur", valeur: v as never });
  return { chemin: `CRM/${nom}.md`, titre: nom, icone: null, etag: "e", taille: 1, mtime: 0, ctime: 0, etiquettes: [], proprietes, yamlInvalide: null };
}

/** Noms des entrées retenues par une expression à un instant donné (horloge figée). */
function retenues(expr: string, entrees: EntreeBase[], instant: string): string[] {
  const erreurs: ErreurBase[] = [];
  const f = compilerFiltre(expr, "t", erreurs);
  assert.ok(f, `${expr} : ${JSON.stringify(erreurs)}`);
  const ctx = { maintenant: Date.parse(instant), fuseau: F };
  return entrees.filter((e) => evaluerFiltre(f!, e, ctx)).map((e) => e.titre);
}

const iso = (v: unknown) => (v instanceof DateBase ? new Date(v.ms).toISOString() : String(v));
const val = (expr: string, instant: string) => evaluer(analyserExpression(expr), entree("x", {}), { maintenant: Date.parse(instant), fuseau: F });

// ------------------------------------------------------------------------------------------------ durées

const D = (src: string, instant = "2026-10-11T09:00:00+02:00") => iso(val(src, instant));
const J = (src: string, instant = "2026-10-11T09:00:00+02:00") => { const v = val(src, instant); return v instanceof DateBase ? `${jourIso(v.ms, F)}${v.jour ? "" : " (instant)"}` : String(v); };

describe("durées au format d'Obsidian Bases", () => {
  test("lecture : unités courtes et longues, avec ou sans espace, singulier ou pluriel", () => {
    const ok: Array<[string, number, string]> = [
      ["7d", 7, "d"], ["7 d", 7, "d"], ["2w", 2, "w"], ["1M", 1, "M"], ["3m", 3, "m"], ["1y", 1, "y"], ["4h", 4, "h"], ["30s", 30, "s"],
      ["1 day", 1, "d"], ["7 days", 7, "d"], ["2 weeks", 2, "w"], ["1 month", 1, "M"], ["6 months", 6, "M"], ["1 year", 1, "y"],
      ["2 hours", 2, "h"], ["5 minutes", 5, "m"], ["1 second", 1, "s"], ["0d", 0, "d"], ["10DAYS", 10, "d"], ["1 months", 1, "M"],
    ];
    for (const [s, n, u] of ok) assert.deepEqual(lireDuree(s), { n, unite: u }, s);
    for (const s of ["7x", "abc", "", "d", "-7d", "1.5d", "1M4h", "7 jours", "7D", "7Y", "1e3d", "99999999999d", "7 dayz", "2000y"]) assert.equal(lireDuree(s), null, s);
  });

  test("point 1 : chaque unité avec date(), en + et en -, M = mois / m = minutes, espaces et pluriels (09:00 Paris = 07:00Z)", () => {
    const base = 'date("2026-10-11 09:00:00")';
    const cas: Array<[string, string]> = [
      ['+ "1y"', "2027-10-11T07:00:00.000Z"], ['- "1 year"', "2025-10-11T07:00:00.000Z"], ['+ "2 Years"', "2028-10-11T07:00:00.000Z"],
      ['+ "2M"', "2026-12-11T08:00:00.000Z"], ['- "1 months"', "2026-09-11T07:00:00.000Z"], ['+ "30M"', "2029-04-11T07:00:00.000Z"],
      ['+ "30m"', "2026-10-11T07:30:00.000Z"], ['- "15 minutes"', "2026-10-11T06:45:00.000Z"], ['+ "1 minute"', "2026-10-11T07:01:00.000Z"],
      ['+ "3w"', "2026-11-01T08:00:00.000Z"], ['- "2 weeks"', "2026-09-27T07:00:00.000Z"], ['+ "1 week"', "2026-10-18T07:00:00.000Z"],
      ['+ "10d"', "2026-10-21T07:00:00.000Z"], ['- "1 day"', "2026-10-10T07:00:00.000Z"], ['+ "2 Days"', "2026-10-13T07:00:00.000Z"], ['- "7 d"', "2026-10-04T07:00:00.000Z"],
      ['+ "5h"', "2026-10-11T12:00:00.000Z"], ['- "2 hours"', "2026-10-11T05:00:00.000Z"], ['+ "1 hour"', "2026-10-11T08:00:00.000Z"],
      ['+ "45s"', "2026-10-11T07:00:45.000Z"], ['- "1 second"', "2026-10-11T06:59:59.000Z"], ['+ "90 seconds"', "2026-10-11T07:01:30.000Z"],
    ];
    for (const [d, attendu] of cas) assert.equal(D(`${base} ${d}`), attendu, d);
    // M et m ne se confondent jamais
    assert.notEqual(D(`${base} + "1M"`), D(`${base} + "1m"`));
    // today() et now() acceptent les mêmes durées
    assert.equal(J('today() + "1M"'), "2026-11-11");
    assert.equal(J('today() - "1y"'), "2025-10-11");
    assert.equal(D('now() - "2w"'), "2026-09-27T07:00:00.000Z");
    assert.equal(D('now() + "1 week"'), "2026-10-18T07:00:00.000Z");
  });

  test("point 2 : fin de mois, années bissextiles, soustraction de mois (résultats exacts)", () => {
    const cas: Array<[string, string]> = [
      ['date("2026-01-31") + "1M"', "2026-02-28"], ['date("2028-01-31") + "1M"', "2028-02-29"], ['date("2026-03-31") - "1M"', "2026-02-28"],
      ['date("2024-03-31") - "1M"', "2024-02-29"], ['date("2024-02-29") + "1y"', "2025-02-28"], ['date("2024-02-29") - "1y"', "2023-02-28"],
      ['date("2024-02-29") + "4y"', "2028-02-29"], ['date("2026-05-31") + "1M"', "2026-06-30"], ['date("2026-01-31") + "2M"', "2026-03-31"],
      ['date("2026-01-15") - "13M"', "2024-12-15"], ['date("2026-03-31") - "2M"', "2026-01-31"], ['date("2026-12-31") + "1M"', "2027-01-31"],
      ['date("2026-10-31") + "4M"', "2027-02-28"], ['date("2026-01-31") - "2M"', "2025-11-30"], ['date("2025-03-29") - "1M"', "2025-02-28"],
      // pas associatif (comme Moment.js) : 31/01 + 1M + 1M = 28/03, pas 31/03
      ['date("2026-01-31") + "1M" + "1M"', "2026-03-28"],
      ['date("2026-02-28") + "1y"', "2027-02-28"], ['date("2027-02-28") + "1y"', "2028-02-28"],
    ];
    for (const [e, attendu] of cas) assert.equal(J(e), attendu, e);
    // une date « jour » reste une date « jour »
    assert.equal((val('date("2026-01-31") + "1M"', "2026-10-11T07:00:00Z") as DateBase).jour, true);
    // et via decalerDate directement
    assert.equal(jourIso(decalerDate(lireDate("2026-01-31", F)!, lireDuree("1M")!, 1, F).ms, F), "2026-02-28");
  });

  test("point 3 : 25/10/2026, les deux 02:30 de Paris (02:30+02:00 = 00:30Z, puis 02:30+01:00 = 01:30Z)", () => {
    const premier = "2026-10-25T00:30:00.000Z", second = "2026-10-25T01:30:00.000Z";
    // une heure locale ambiguë sans fuseau = la PREMIÈRE (heure d'été), règle « compatible » de Temporal
    assert.equal(new Date(lireDate("2026-10-25T02:30:00", F)!.ms).toISOString(), premier);
    assert.equal(new Date(lireDate("2026-10-25 02:30:00", F)!.ms).toISOString(), premier);
    assert.equal(new Date(lireDate("2026-10-25T02:30:00+01:00", F)!.ms).toISOString(), second);
    assert.equal(D('date("2026-10-24 02:30:00") + "1d"'), premier);
    assert.equal(D('date("2026-10-25 02:30:00") + "1h"'), second); // une heure exacte plus tard : 02:30 de nouveau
    assert.equal(D('now() - "1h"', second), premier);
    assert.equal(D('now() + "1h"', premier), second);
    // jours calendaires : même heure locale le lendemain (25 h après la première 02:30, 24 h après la seconde)
    assert.equal(D('now() + "1d"', premier), "2026-10-26T01:30:00.000Z");
    assert.equal(D('now() + "1d"', second), "2026-10-26T01:30:00.000Z");
    assert.equal(D('now() + "24h"', premier), "2026-10-26T00:30:00.000Z");
    // today() est le même aux deux 02:30, et le jour dure 25 h
    assert.equal(D("today()", premier), "2026-10-24T22:00:00.000Z");
    assert.equal(D("today()", second), "2026-10-24T22:00:00.000Z");
    assert.equal(D('today() + "1d"', second), "2026-10-25T23:00:00.000Z");
    assert.equal(D('today() - "1d"', "2026-10-25T23:30:00Z"), "2026-10-24T22:00:00.000Z"); // le 26 à 00:30 : hier = le 25
    // une vue ouverte pendant le changement d'heure
    const instants = [entree("Première 02:30", { relance: "2026-10-25T02:30:00+02:00" }), entree("Seconde 02:30", { relance: "2026-10-25T02:30:00+01:00" })];
    assert.deepEqual(retenues("relance <= now()", instants, "2026-10-25T00:45:00Z"), ["Première 02:30"]);
    assert.deepEqual(retenues("relance <= now()", instants, "2026-10-25T01:45:00Z"), ["Première 02:30", "Seconde 02:30"]);
    assert.deepEqual(retenues('relance > now() - "1h"', instants, "2026-10-25T01:45:00Z"), ["Seconde 02:30"]);
    assert.deepEqual(retenues("relance.date() == today()", instants, "2026-10-25T01:45:00Z"), ["Première 02:30", "Seconde 02:30"]);
    assert.deepEqual(retenues("relance.date() == today()", instants, "2026-10-25T23:30:00Z"), []);
    // printemps (29/03/2026) : 02:30 n'existe pas = 03:30 heure d'été ; la journée dure 23 h
    assert.equal(D('date("2026-03-29 02:30:00")'), "2026-03-29T01:30:00.000Z");
    assert.equal(D('date("2026-03-28") + "1d"'), "2026-03-28T23:00:00.000Z");
    assert.equal(D('date("2026-03-28") + "2d"'), "2026-03-29T22:00:00.000Z");
  });

  test("exemples de la documentation d'Obsidian", () => {
    assert.equal(D('date("2024-12-01") + "1M" + "4h" + "3m"'), "2025-01-01T03:03:00.000Z"); // 04:03 Paris
    const r = val('(now() + "1d")', "2026-10-11T08:00:00Z") as DateBase;
    assert.equal(r.ms - Date.parse("2026-10-11T08:00:00Z"), 86400000);
  });

  test(".date() et .format() (motifs fermés)", () => {
    assert.equal(val('date("2026-10-11 15:42:00").format("YYYY-MM-DD HH:mm")', "2026-10-11T08:00:00Z"), "2026-10-11 15:42");
    assert.equal(val('date("2027-01-01").format("GGGG-[W]WW")', "2026-10-11T08:00:00Z"), "2026-W53");
    assert.equal(val('date("2026-10-11").format("GGGG-WW")', "2026-10-11T08:00:00Z"), "2026-41");
    assert.equal(val('date("2026-10-12").format("GGGG-WW")', "2026-10-11T08:00:00Z"), "2026-42");
    assert.equal(val('date("2026-10-05").format("GGGG-WW")', "2026-10-11T08:00:00Z"), "2026-41"); // lundi de la même semaine
    assert.equal(val('date("2026-10-04").format("GGGG-WW")', "2026-10-11T08:00:00Z"), "2026-40"); // dimanche d'avant
    assert.equal(iso(val('date("2026-10-11 15:42:00").date()', "2026-10-11T08:00:00Z")), "2026-10-10T22:00:00.000Z");
    for (const m of ['x.format("dddd")', 'x.format("")', "x.format(y)", 'x.format("YYYY", "a")']) {
      assert.throws(() => analyserExpression(m), ErreurExpression, m);
    }
  });
});

// ------------------------------------------------------------------------------------------------ CRM (point 10) : R1, R3

/** Fiches du CRM d'essai (mêmes que tests/v3-relancer.py) : bornes, dates avec heure, statuts fermés, absentes, texte. */
const CRM = [
  entree("Alpha", { statut: "Ouvert", relance: "2026-10-09", derniere: "2026-09-01" }),
  entree("Bravo", { statut: "Ouvert", relance: "2026-10-11", derniere: "2026-09-28" }),
  entree("Charlie", { statut: "Ouvert", relance: "2026-10-12", derniere: "2026-09-29" }),
  entree("Delta", { statut: "Gagné", relance: "2026-10-01", derniere: "2026-08-01" }),
  entree("Écho", { statut: "Ouvert", relance: "2026-10-20", derniere: "2026-10-05" }),
  entree("Foxtrot", { statut: "Ouvert", relance: "2026-10-26", derniere: "2026-10-08" }),
  entree("Golf", { statut: "Ouvert", relance: "2026-10-11T15:00:00+02:00", derniere: "2026-09-11" }),
  entree("Hotel", { statut: "Ouvert", relance: "2026-10-18T10:00:00+02:00", derniere: "2026-09-10T23:30:00+02:00" }),
  entree("India", { statut: "Ouvert", relance: "2026-10-05", derniere: "2026-09-10" }),
  entree("Juliet", { statut: "Perdu", relance: "2026-10-04" }),
  entree("Kilo", { statut: "Ouvert" }),
  entree("Lima", { statut: "Ouvert", relance: "bientôt", derniere: "2026-10-01" }),
];
const ONZE = "2026-10-11T09:00:00+02:00";
const ouvert = (expr: string) => `${expr} && statut != "Gagné" && statut != "Perdu"`;

describe("R1 et point 10 : le CRM d'essai le 11/10/2026 puis la semaine suivante (horloge figée)", () => {
  test("« À relancer » (aujourd'hui ou avant, statuts fermés exclus) jour après jour", () => {
    const vue = ouvert("relance.date() <= today()");
    assert.deepEqual(retenues(vue, CRM, ONZE), ["Alpha", "Bravo", "Golf", "India"]); // Golf : due à 15 h aujourd'hui
    assert.deepEqual(retenues(vue, CRM, "2026-10-11T23:59:59+02:00"), ["Alpha", "Bravo", "Golf", "India"]);
    assert.deepEqual(retenues(vue, CRM, "2026-10-12T00:00:00+02:00"), ["Alpha", "Bravo", "Charlie", "Golf", "India"]);
    assert.deepEqual(retenues(vue, CRM, "2026-10-18T09:00:00+02:00"), ["Alpha", "Bravo", "Charlie", "Golf", "Hotel", "India"]);
    assert.deepEqual(retenues(vue, CRM, "2026-10-20T09:00:00+02:00"), ["Alpha", "Bravo", "Charlie", "Écho", "Golf", "Hotel", "India"]);
    // Delta (Gagné) et Juliet (Perdu) jamais ; Kilo (sans date) et Lima (« bientôt ») jamais
    for (const t of ["2026-10-11T09:00:00+02:00", "2026-10-30T09:00:00+01:00"]) {
      for (const n of ["Delta", "Juliet", "Kilo", "Lima"]) assert.ok(!retenues(vue, CRM, t).includes(n), `${n} ${t}`);
    }
  });

  test("today() + \"7d\" et now() - \"2w\" le 11/10 à 9 h", () => {
    assert.deepEqual(retenues('relance <= today() + "7d"', CRM, ONZE), ["Alpha", "Bravo", "Charlie", "Delta", "Golf", "India", "Juliet"]);
    // la forme écrite à la main SANS .date() exclut Hotel (18/10 à 10 h > minuit du 18) : c'est pourquoi l'interface écrit .date()
    assert.ok(!retenues('relance <= today() + "7d"', CRM, ONZE).includes("Hotel"));
    assert.ok(retenues('relance.date() <= today() + "7d"', CRM, ONZE).includes("Hotel"));
    // now() - "2w" = 27/09 à 9 h
    assert.deepEqual(retenues('derniere < now() - "2w"', CRM, ONZE), ["Alpha", "Delta", "Golf", "Hotel", "India"]);
  });

  test("absente, null, texte : jamais retenues, jamais d'erreur (contrat de valeurs du lot 2)", () => {
    for (const e of ['relance <= today() + "7d"', 'relance > today() - "1y"', 'relance + "1d" > today()', "relance.date() <= today()"]) {
      const r = retenues(e, CRM, ONZE);
      for (const n of ["Kilo", "Lima"]) assert.ok(!r.includes(n), `${e} : ${n}`);
    }
  });

  test("CARNET_FUSEAU respecté (autre fuseau, autre « aujourd'hui »)", () => {
    const f = compilerFiltre("relance.date() == today()", "t", [])!;
    const e = CRM[1]; // 2026-10-11
    // 10/10 23:30 à New York = 11/10 05:30 Paris
    assert.equal(evaluerFiltre(f, e, { maintenant: Date.parse("2026-10-11T03:30:00Z"), fuseau: "Europe/Paris" }), true);
    assert.equal(evaluerFiltre(f, e, { maintenant: Date.parse("2026-10-11T03:30:00Z"), fuseau: "America/New_York" }), false);
  });
});

describe("R2 (point 4) : durée mal formée, unité inconnue, date invalide, propriété absente : quatre cas distincts", () => {
  const refus = (src: string, re: RegExp, pos: number) =>
    assert.throws(() => analyserExpression(src), (x: unknown) => x instanceof ErreurExpression && re.test(x.message) && x.position === pos, `${src} → ${pos}`);
  test("durée mal formée (position : la durée)", () => {
    refus('today() - "abc" > relance', /Durée mal formée "abc"/, 10);
    refus('relance < now() + "1M4h"', /Durée mal formée "1M4h".*\+ "1M" \+ "4h"/, 18);
    refus('relance < today() - "-7d"', /Durée mal formée/, 20);
    refus('relance < today() - "1.5d"', /Durée mal formée/, 20);
    refus('relance < today() - ""', /Durée mal formée/, 20);
    refus('relance < today() - "2000y"', /Durée trop grande/, 20);
  });
  test("unité inconnue (position : l'unité elle-même)", () => {
    refus('relance <= today() + "7x"', /Unité de durée inconnue « x »/, 23);
    refus('relance <= today() + "7 jours"', /Unité de durée inconnue « jours »/, 24);
    refus('relance <= today() + "7D"', /Unité de durée inconnue « D »/, 23);
  });
  test("date invalide et calcul hors durée", () => {
    refus('relance < date("2026-02-30") + "1d"', /date\(…\) attend/, 15);
    refus("relance + 7 > today()", /durée entre guillemets/, 10);
    assert.throws(() => analyserExpression('statut + "7d" == "x" && "a" + "b"'), (x: unknown) => x instanceof ErreurExpression && /calcul/.test(x.message));
  });
  // propriété absente : pas une erreur de syntaxe ; la route le DIT (exclusions), voir « routes » plus bas
});

// ------------------------------------------------------------------------------------------------ filtres de l'interface (R3, points 5, 6, 7)

describe("R3 : filtres relatifs de l'interface", () => {
  const cas: Array<[FiltreSimple, string, string[]]> = [
    // [choix, expression écrite, lignes du CRM d'essai le 11/10 à 9 h]
    [{ propriete: "relance", operateur: "jusqu_aujourdhui", valeur: null }, "relance.date() <= today()", ["Alpha", "Bravo", "Delta", "Golf", "India", "Juliet"]],
    [{ propriete: "relance", operateur: "avant_aujourdhui", valeur: null }, "relance < today()", ["Alpha", "Delta", "India", "Juliet"]],
    [{ propriete: "relance", operateur: "aujourdhui", valeur: null }, "relance.date() == today()", ["Bravo", "Golf"]],
    [{ propriete: "relance", operateur: "prochains_jours", valeur: 7 }, 'relance.date() >= today() && relance.date() <= today() + "7d"', ["Bravo", "Charlie", "Golf", "Hotel"]],
    [{ propriete: "relance", operateur: "au_plus_tard", valeur: 7 }, 'relance.date() <= today() + "7d"', ["Alpha", "Bravo", "Charlie", "Delta", "Golf", "Hotel", "India", "Juliet"]],
    [{ propriete: "derniere", operateur: "plus_de_jours", valeur: 30 }, 'derniere < today() - "30d"', ["Alpha", "Delta", "Hotel", "India"]],
    [{ propriete: "relance", operateur: "cette_semaine", valeur: null }, 'relance.format("GGGG-WW") == today().format("GGGG-WW")', ["Alpha", "Bravo", "Golf", "India"]],
  ];
  test("écriture exacte, relecture à l'identique, lignes attendues (bornes, dates avec heure)", () => {
    for (const [f, attendu, lignes] of cas) {
      assert.equal(ecrireFiltreSimple(f), attendu);
      assert.deepEqual(lireFiltreSimple(attendu), f, attendu);
      assert.deepEqual(retenues(attendu, CRM, ONZE), lignes, attendu);
    }
    const nom = { propriete: "Prochaine relance", operateur: "prochains_jours" as const, valeur: 3 };
    assert.equal(ecrireFiltreSimple(nom), 'note["Prochaine relance"].date() >= today() && note["Prochaine relance"].date() <= today() + "3d"');
    assert.deepEqual(lireFiltreSimple(ecrireFiltreSimple(nom)), nom);
  });
  test("point 5 : « dans les N prochains jours » = d'aujourd'hui (inclus) à J+N (inclus), jamais le passé", () => {
    const e = ecrireFiltreSimple({ propriete: "relance", operateur: "prochains_jours", valeur: 7 });
    const jours = ["2026-10-10", "2026-10-11", "2026-10-11T00:00:00+02:00", "2026-10-11T23:59:00+02:00", "2026-10-18", "2026-10-18T23:59:00+02:00", "2026-10-19"]
      .map((d, i) => entree(`${i} ${d}`, { relance: d }));
    assert.deepEqual(retenues(e, jours, ONZE).map((t) => t.split(" ")[1]), ["2026-10-11", "2026-10-11T00:00:00+02:00", "2026-10-11T23:59:00+02:00", "2026-10-18", "2026-10-18T23:59:00+02:00"]);
    // N = 0 : aujourd'hui seulement
    assert.deepEqual(retenues(ecrireFiltreSimple({ propriete: "relance", operateur: "prochains_jours", valeur: 0 }), jours, ONZE).length, 3);
  });
  test("point 6 : « cette semaine » = lundi → dimanche ; « il y a plus de N jours » = frontière stricte", () => {
    const sem = ecrireFiltreSimple({ propriete: "relance", operateur: "cette_semaine", valeur: null });
    const semaine = ["2026-10-04", "2026-10-05", "2026-10-08T12:00:00+02:00", "2026-10-11T23:59:00+02:00", "2026-10-12"].map((d) => entree(d, { relance: d }));
    assert.deepEqual(retenues(sem, semaine, ONZE), ["2026-10-05", "2026-10-08T12:00:00+02:00", "2026-10-11T23:59:00+02:00"]);
    assert.deepEqual(retenues(sem, semaine, "2026-10-12T00:00:00+02:00"), ["2026-10-12"]); // le lundi, nouvelle semaine
    const plus = ecrireFiltreSimple({ propriete: "derniere", operateur: "plus_de_jours", valeur: 30 });
    const vieux = ["2026-09-10", "2026-09-10T23:59:00+02:00", "2026-09-11", "2026-09-11T00:00:00+02:00", "2026-09-12"].map((d) => entree(d, { derniere: d }));
    assert.deepEqual(retenues(plus, vieux, ONZE), ["2026-09-10", "2026-09-10T23:59:00+02:00"]); // 30 jours pile : non
  });
  test("point 7 : dates avec heure : « aujourd'hui ou avant » garde la relance due à 15 h, « avant aujourd'hui » non", () => {
    const golf = [CRM[6]];
    assert.deepEqual(retenues(ecrireFiltreSimple({ propriete: "relance", operateur: "jusqu_aujourdhui", valeur: null }), golf, ONZE), ["Golf"]);
    assert.deepEqual(retenues(ecrireFiltreSimple({ propriete: "relance", operateur: "aujourdhui", valeur: null }), golf, ONZE), ["Golf"]);
    assert.deepEqual(retenues(ecrireFiltreSimple({ propriete: "relance", operateur: "avant_aujourdhui", valeur: null }), golf, ONZE), []);
    assert.deepEqual(retenues(ecrireFiltreSimple({ propriete: "relance", operateur: "avant_aujourdhui", valeur: null }), golf, "2026-10-12T00:00:01+02:00"), ["Golf"]);
    // la forme sans .date() (écrite à la main) l'exclurait : documenté
    assert.deepEqual(retenues("relance <= today()", golf, ONZE), []);
  });
  test("une expression écrite à la main n'est pas prise pour un filtre simple (reste du texte)", () => {
    for (const e of ['relance <= today() + "1w"', 'relance.date() <= today() + "7 days"', 'relance <= now() + "7d"', 'relance >= today() && autre <= today() + "7d"',
      'relance.format("YYYY-WW") == today().format("YYYY-WW")', "relance <= today()", 'relance <= today() + "7d"']) {
      assert.equal(lireFiltreSimple(e), null, e);
    }
  });
  test("nombre de jours invalide refusé", () => {
    assert.throws(() => ecrireFiltreSimple({ propriete: "r", operateur: "prochains_jours", valeur: -1 }));
    assert.throws(() => ecrireFiltreSimple({ propriete: "r", operateur: "prochains_jours", valeur: 2.5 }));
  });
  test("point 9 : ajouter « dans les 7 prochains jours » ne touche qu'à la liste de filtres ; le retirer rend le bloc à l'octet", () => {
    const src = [
      "# CRM",
      "filters:",
      "  and:",
      '    - file.inFolder("CRM")   # dossier',
      "views:",
      "  - type: table",
      "    name: À relancer   # vue principale",
      "    filters:",
      "      and:",
      "        - 'statut != \"Gagné\"'",
      "    order:",
      "      - file.name",
      "      - relance",
      "inconnue: { garder: oui }",
      "carnet:",
      "  proprietes:",
      "    relance: { type: date }",
    ].join("\n");
    for (const [f] of cas) {
      const expr = ecrireFiltreSimple(f);
      const apres = reecrireVue(src, 0, { ajouterFiltre: expr });
      const lignesAvant = src.split("\n"), lignesApres = apres.split("\n");
      assert.equal(lignesApres.length, lignesAvant.length + 1, expr);
      const ajout = lignesApres.filter((l) => !lignesAvant.includes(l));
      assert.equal(ajout.length, 1);
      assert.match(ajout[0], /^ {8}- /);
      const { def } = lireDefinition(apres);
      const fl = def!.vues[0].filtreBrut as { and: string[] };
      assert.equal(fl.and[1], expr);
      assert.deepEqual(lireFiltreSimple(fl.and[1]), f);
      assert.equal(reecrireVue(apres, 0, { retirerFiltre: 1 }), src, expr);
    }
  });
  test("réécriture refusée avec position si l'expression est invalide", () => {
    assert.throws(() => reecrireVue("views:\n  - type: table\n", 0, { ajouterFiltre: 'relance <= today() + "7x"' }), (x: unknown) => {
      const e = x as { statut: number; message: string };
      return e.statut === 422 && /Unité de durée inconnue/.test(e.message) && /position 24/.test(e.message);
    });
  });
});

// ------------------------------------------------------------------------------------------------ routes : R2, R4, Aujourd'hui

const BLOC_CRM = `filters:
  and:
    - file.inFolder("CRM")
views:
  - type: table
    name: À relancer
    filters:
      and:
        - prochaine_relance <= today()
        - 'statut != "Gagné"'
    order:
      - file.name
      - prochaine_relance
  - type: table
    name: Sans nouvelles depuis 30 jours
    filters:
      and:
        - 'derniere_relance < today() - "30d"'
carnet:
  dossier: CRM
  proprietes:
    prochaine_relance: { type: date }
    derniere_relance: { type: date }
    statut: { type: statut, options: [Ouvert, Gagné] }`;

const FICHES: Record<string, string> = {
  "CRM/Alpha.md": "---\nstatut: Ouvert\nprochaine_relance: 2026-10-09\nderniere_relance: 2026-09-01\n---\n# Alpha\n",
  "CRM/Bravo.md": "---\nstatut: Ouvert\nprochaine_relance: 2026-10-11\nderniere_relance: 2026-09-20\n---\n# Bravo\n",
  "CRM/Charlie.md": "---\nstatut: Ouvert\nprochaine_relance: 2026-10-12\nderniere_relance: 2026-09-11\n---\n# Charlie\n",
  "CRM/Delta.md": "---\nstatut: Gagné\nprochaine_relance: 2026-10-01\nderniere_relance: 2026-08-01\n---\n# Delta\n",
  "CRM/Écho.md": "---\nstatut: Ouvert\nprochaine_relance: 2026-10-20\nderniere_relance: 2026-10-05\n---\n# Écho\n",
};

describe("routes (horloge de recette CARNET_HORLOGE_ESSAI)", () => {
  let b: Banc;
  let horloge: string;
  let dossierHorloge: string;
  before(async () => {
    dossierHorloge = await fsp.mkdtemp(path.join(os.tmpdir(), "carnet-horloge-"));
    horloge = path.join(dossierHorloge, "maintenant");
    await fsp.writeFile(horloge, "2026-10-11T09:00:00+02:00\n");
    b = await demarrerBanc({
      env: { CARNET_HORLOGE_ESSAI: horloge },
      preparer: async (_r, espace) => {
        for (const [rel, contenu] of Object.entries({ ...FICHES, "CRM.md": "# CRM\n\n```base\n" + BLOC_CRM + "\n```\n" })) {
          await fsp.mkdir(path.dirname(path.join(espace, rel)), { recursive: true });
          await fsp.writeFile(path.join(espace, rel), contenu);
        }
      },
    });
  });
  after(async () => {
    await b.fermer();
    await fsp.rm(dossierHorloge, { recursive: true, force: true });
  });

  const titres = (r: { json: { lignes: Array<{ titre: string }> } }) => r.json.lignes.map((l) => l.titre);

  test("R4 : le lendemain, la vue « À relancer » change seule, sans réécriture du fichier", async () => {
    const avant = fs.readFileSync(path.join(b.espace, "CRM.md"), "utf8");
    const mtime = fs.statSync(path.join(b.espace, "CRM.md")).mtimeMs;
    const r1 = await b.req("GET", `/api/base?chemin=${q("CRM.md")}&bloc=0&vue=0`);
    assert.equal(r1.statut, 200);
    assert.deepEqual(titres(r1), ["Alpha", "Bravo"]);
    const s1 = await b.req("GET", `/api/base?chemin=${q("CRM.md")}&bloc=0&vue=1`);
    assert.deepEqual(titres(s1), ["Alpha", "Delta"]); // < 11/09
    await fsp.writeFile(horloge, "2026-10-12T09:00:00+02:00\n");
    const r2 = await b.req("GET", `/api/base?chemin=${q("CRM.md")}&bloc=0&vue=0`);
    assert.deepEqual(titres(r2), ["Alpha", "Bravo", "Charlie"]);
    const s2 = await b.req("GET", `/api/base?chemin=${q("CRM.md")}&bloc=0&vue=1`);
    assert.deepEqual(titres(s2), ["Alpha", "Charlie", "Delta"]); // < 12/09
    // l'éditeur (YAML affiché) suit la même horloge
    const e2 = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: BLOC_CRM, vue: 0 } });
    assert.deepEqual(titres(e2), ["Alpha", "Bravo", "Charlie"]);
    assert.equal(fs.readFileSync(path.join(b.espace, "CRM.md"), "utf8"), avant);
    assert.equal(fs.statSync(path.join(b.espace, "CRM.md")).mtimeMs, mtime);
    await fsp.writeFile(horloge, "2026-10-11T09:00:00+02:00\n");
  });

  test("R2 : durée invalide = 422 explicite avec position (jamais un tableau vide)", async () => {
    const source = BLOC_CRM.replace('today() - "30d"', 'today() - "30x"');
    const r = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source, vue: 1 } });
    assert.equal(r.statut, 422);
    assert.equal(r.json.raison, "base_invalide");
    const e = (r.json.erreurs as ErreurBase[])[0];
    assert.match(e.message, /Unité de durée inconnue « x » dans "30x"/);
    assert.equal(e.expression, 'derniere_relance < today() - "30x"');
    assert.equal(e.position, 32); // sous le « x »
    assert.equal(e.ou, "views[1].filters.and[0]");
    assert.equal(r.json.lignes, undefined);
    const w = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_CRM, vue: 0, changement: { ajouterFiltre: 'prochaine_relance <= today() + "abc"' } } });
    assert.equal(w.statut, 422);
    assert.match(w.json.erreur as string, /Durée mal formée "abc".*position 32/);
    assert.equal((w.json.erreurs as ErreurBase[])[0].position, 31);
  });

  test("R3 (serveur) : la réécriture renvoie le YAML avec l'expression exacte, relue en pastille", async () => {
    const expr = 'prochaine_relance.date() >= today() && prochaine_relance.date() <= today() + "7d"';
    const w = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_CRM, vue: 0, changement: { ajouterFiltre: expr } } });
    assert.equal(w.statut, 200);
    const nouvelle = w.json.source as string;
    const r = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: nouvelle, vue: 0 } });
    assert.equal(r.statut, 200);
    const filtres = r.json.filtres as Array<{ expression: string; simple: FiltreSimple | null }>;
    assert.equal(filtres[2].expression, expr);
    assert.deepEqual(filtres[2].simple, { propriete: "prochaine_relance", operateur: "prochains_jours", valeur: 7 });
    assert.deepEqual(titres(r), ["Bravo"]);
  });

  test("Aujourd'hui : « À relancer : N » quand une base a une vue de ce nom, selon l'horloge", async () => {
    const r = await b.req("GET", "/api/aujourdhui");
    assert.equal(r.statut, 200);
    assert.deepEqual(r.json.aRelancer, [{ chemin: "CRM.md", titre: "CRM", bloc: 0, vue: 0, nom: "À relancer", total: 2 }]);
    await fsp.writeFile(horloge, "2026-10-12T09:00:00+02:00\n");
    const r2 = await b.req("GET", "/api/aujourdhui");
    assert.equal((r2.json.aRelancer as Array<{ total: number }>)[0].total, 3);
    await fsp.writeFile(horloge, "2026-10-11T09:00:00+02:00\n");
  });

  test("point 8 : la vue ouverte passe minuit sans aucun événement de fichier (23:59:30 → 00:00:30)", async () => {
    const mtime = fs.statSync(path.join(b.espace, "CRM.md")).mtimeMs;
    await fsp.writeFile(horloge, "2026-10-11T23:59:30+02:00\n");
    const r1 = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: BLOC_CRM, vue: 0 } });
    assert.deepEqual(titres(r1), ["Alpha", "Bravo"]);
    await fsp.writeFile(horloge, "2026-10-12T00:00:30+02:00\n");
    const r2 = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: BLOC_CRM, vue: 0 } });
    assert.deepEqual(titres(r2), ["Alpha", "Bravo", "Charlie"]);
    assert.equal(fs.statSync(path.join(b.espace, "CRM.md")).mtimeMs, mtime);
    await fsp.writeFile(horloge, "2026-10-11T09:00:00+02:00\n");
  });

  test("point 4 : propriété absente partout, valeur vide, valeur qui n'est pas une date : la vue le DIT (exclusions)", async () => {
    // faute de frappe : aucune page n'a « prochaine_relanse »
    const faute = BLOC_CRM.replace("- prochaine_relance <= today()", "- prochaine_relanse <= today()");
    const r = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: faute, vue: 0 } });
    assert.equal(r.statut, 200);
    assert.deepEqual(titres(r), []);
    assert.deepEqual(r.json.exclusions, ["Aucune page de la base n'a de « prochaine_relanse » : vérifie le nom de la propriété dans le filtre."]);
    // une fiche sans date et une fiche « bientôt »
    await fsp.writeFile(path.join(b.espace, "CRM/Foxtrot.md"), "---\nstatut: Ouvert\n---\n# Foxtrot\n");
    await fsp.writeFile(path.join(b.espace, "CRM/Golf.md"), "---\nstatut: Ouvert\nprochaine_relance: bientôt\n---\n# Golf\n");
    await b.app.espace.appliquer(await b.app.espace.traiter(["CRM/Foxtrot.md", "CRM/Golf.md"]));
    const r2 = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: BLOC_CRM, vue: 0 } });
    assert.deepEqual(titres(r2), ["Alpha", "Bravo"]);
    assert.deepEqual(r2.json.exclusions, [
      "1 page sans « prochaine_relance » n'est pas retenue.",
      "1 page dont « prochaine_relance » n'est pas une date (« bientôt ») n'est pas retenue.",
    ]);
    // une vue sans comparaison de dates ne dit rien
    const tous = await b.req("POST", "/api/base/evaluer", { corps: { chemin: "CRM.md", source: "filters:\n  and:\n    - file.inFolder(\"CRM\")\nviews:\n  - type: table\n", vue: 0 } });
    assert.equal(tous.json.exclusions, undefined);
    await fsp.rm(path.join(b.espace, "CRM/Foxtrot.md"));
    await fsp.rm(path.join(b.espace, "CRM/Golf.md"));
    await b.app.espace.appliquer(await b.app.espace.traiter(["CRM/Foxtrot.md", "CRM/Golf.md"]));
  });

  test("horloge illisible : horloge réelle (pas de panne)", async () => {
    await fsp.writeFile(horloge, "pas une date\n");
    const r = await b.req("GET", `/api/base?chemin=${q("CRM.md")}&bloc=0&vue=0`);
    assert.equal(r.statut, 200);
    await fsp.writeFile(horloge, "2026-10-11T09:00:00+02:00\n");
  });

  test("sécurité des chemins inchangée sur les routes des bases", async () => {
    for (const c of ["../x.md", ".corbeille/x.md", "%2e%2e/x.md"]) {
      const r = await b.req("GET", `/api/base?chemin=${q(c)}&bloc=0`);
      assert.ok([400, 403, 404].includes(r.statut), `${c} : ${r.statut}`);
    }
    const s = await b.req("POST", "/api/base/reecrire", { corps: { source: BLOC_CRM, vue: 0, changement: { tri: null } }, entetes: { "X-Carnet": undefined } });
    assert.equal(s.statut, 403);
  });
});

describe("Aujourd'hui sans vue « À relancer » : rien de nouveau dans la réponse", () => {
  test("aucune clé aRelancer", async () => {
    const b = await demarrerBanc();
    try {
      const r = await b.req("GET", "/api/aujourdhui");
      assert.equal(r.statut, 200);
      assert.equal("aRelancer" in r.json, false);
    } finally {
      await b.fermer();
    }
  });
});
