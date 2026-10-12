// Carnet · tests du socle V3 : propriétés (shared/proprietes.ts), identifiants (shared/identifiants.ts), fixtures communes.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, test } from "node:test";
import YAML from "yaml";
import "../src/analyseur-yaml.ts";
import { analyserYaml } from "../src/analyseur-yaml.ts";
import { dateDuJour, horodatageIso, nouvelIdentifiant, RE_IDENTIFIANT } from "../../shared/identifiants.ts";
import { decouper, poserChamp, poserChampLigne } from "../../shared/page.ts";
import { ErreurFormat, lireProprietes, poserPropriete } from "../../shared/proprietes.ts";
import type { ValeurPropriete } from "../../shared/proprietes.ts";

export const FIXTURES_V3 = path.resolve(import.meta.dirname, "fixtures/v3");

/** Toutes les pages .md des fixtures V3 (chemin relatif → contenu). */
export function pagesFixtures(): Map<string, string> {
  const res = new Map<string, string>();
  const parcourir = (rel: string) => {
    for (const d of fs.readdirSync(path.join(FIXTURES_V3, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${d.name}` : d.name;
      if (d.isDirectory()) parcourir(r);
      else if (d.name.endsWith(".md")) res.set(r, fs.readFileSync(path.join(FIXTURES_V3, r), "utf8"));
    }
  };
  parcourir("");
  return res;
}

/** Plage [début, fin) de la paire `cle` dans le contenu (lignes entières), via le paquet yaml directement. */
function plagePaire(contenu: string, cle: string): [number, number] | null {
  const d = decouper(contenu);
  const debutYaml = d.frontmatter.indexOf("\n") + 1;
  const doc = YAML.parseDocument(d.yaml);
  const items = (doc.contents as YAML.YAMLMap | null)?.items ?? [];
  const p = items.find((x) => (x.key as YAML.Scalar).value === cle);
  if (!p) return null;
  const k = p.key as YAML.Scalar;
  const v = p.value as YAML.Node | null;
  const debut = d.yaml.lastIndexOf("\n", k.range![0] - 1) + 1;
  let fin = v?.range ? v.range[1] : k.range![1] + 1;
  const nl = d.yaml.indexOf("\n", Math.max(fin - 1, k.range![1]));
  fin = nl === -1 ? d.yaml.length : nl + 1;
  return [debutYaml + debut, debutYaml + fin];
}

/** Ce qui a changé entre a et b : [début commun, fin dans a, fin dans b]. */
function difference(a: string, b: string): { debut: number; finA: number; finB: number } {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return { debut: i, finA: a.length - j, finB: b.length - j };
}

function valeursYaml(contenu: string): Record<string, unknown> {
  return (YAML.parse(decouper(contenu).yaml) ?? {}) as Record<string, unknown>;
}

const NOUVELLES: ValeurPropriete[] = ["nouvelle valeur", 42, true, null, ["x", "y z"], "", "00123", "ligne 1\nligne 2"];

describe("poserPropriete sur toutes les fixtures : seule la propriété ciblée change, à l'octet", () => {
  for (const [rel, contenu] of pagesFixtures()) {
    const lecture = lireProprietes(contenu);
    if (!lecture.modifiable) continue;
    test(rel, () => {
      const d = decouper(contenu);
      const cles = Object.keys(lecture.valeurs);
      for (const cle of cles) {
        const v = lecture.valeurs[cle];
        if (v && typeof v === "object" && !Array.isArray(v)) {
          // objet imbriqué ciblé : refus explicite, rien ne change
          assert.throws(() => poserPropriete(contenu, cle, "x"), (e: unknown) => e instanceof ErreurFormat && e.raison === "valeur_imbriquee");
          continue;
        }
        const plage = plagePaire(contenu, cle)!;
        assert.ok(plage, `${rel} : ${cle}`);
        for (const nv of NOUVELLES) {
          const apres = poserPropriete(contenu, cle, nv);
          const diff = difference(contenu, apres);
          if (apres !== contenu) assert.ok(diff.debut >= plage[0] && diff.finA <= plage[1], `${rel} / ${cle} = ${JSON.stringify(nv)} : changement hors de la paire`);
          assert.equal(decouper(apres).corps, d.corps);
          const avantV = valeursYaml(contenu);
          const apresV = valeursYaml(apres);
          assert.deepEqual(Object.keys(apresV), Object.keys(avantV), `${rel} / ${cle} : ordre des clés`);
          for (const k of Object.keys(avantV)) if (k !== cle) assert.deepEqual(apresV[k], avantV[k]);
          assert.deepEqual(apresV[cle], nv);
          // remettre la valeur d'origine n'est pas exigé à l'octet (style), mais poser deux fois est stable
          assert.equal(poserPropriete(apres, cle, nv), apres, `${rel} / ${cle} : idempotent`);
        }
        // retirer
        // retirer = enlever exactement les lignes de la paire (et un seul saut de ligne)
        const sans = poserPropriete(contenu, cle, undefined);
        const [p0, p1] = plage;
        const attendu = contenu[p1 - 1] === "\n" ? contenu.slice(0, p0) + contenu.slice(p1) : contenu.slice(0, p0 - 1) + contenu.slice(p1);
        assert.equal(sans, attendu, `${rel} / retirer ${cle}`);
        assert.equal(Object.hasOwn(valeursYaml(sans), cle), false);
      }
      // ajouter une clé : seul un ajout avant le délimiteur de fin
      const ajout = poserPropriete(contenu, "ajoutee_par_test", "oui");
      const diff = difference(contenu, ajout);
      assert.equal(diff.finA - diff.debut, 0, `${rel} : un ajout ne remplace rien`);
      assert.equal(valeursYaml(ajout).ajoutee_par_test, "oui");
    });
  }
});

describe("poserPropriete : cas précis", () => {
  const fm = fs.readFileSync(path.join(FIXTURES_V3, "Frontmatter difficile.md"), "utf8");
  test("absente ≠ null ≠ vide ; 0 et false sont des valeurs", () => {
    const v = lireProprietes(fm).valeurs;
    assert.equal(v.compteur, 0);
    assert.equal(v.actif, false);
    assert.equal(v.responsable, null);
    assert.equal(v.vide, null);
    assert.equal(v.texte_vide, "");
    assert.equal(Object.hasOwn(v, "absente"), false);
    assert.equal(v.reference, "00123");
    assert.equal(v.code_brut, 123); // YAML 1.2 core : 00123 sans guillemets est un nombre (d'où les guillemets à l'écriture)
  });
  test("texte « 00123 », « true », « 2026-10-12 » de type texte : entre guillemets ; date : sans", () => {
    assert.match(poserPropriete(fm, "code_brut", "00123"), /^code_brut: "00123"$/m);
    assert.match(poserPropriete(fm, "actif", "true"), /^actif: "true"$/m);
    assert.match(poserPropriete(fm, "echeance", "2026-10-13", { type: "texte" }), /^echeance: "2026-10-13"$/m);
    assert.match(poserPropriete(fm, "echeance", "2026-10-13", { type: "date" }), /^echeance: 2026-10-13$/m);
    assert.match(poserPropriete(fm, "compteur", 0), /^compteur: 0$/m);
    assert.match(poserPropriete(fm, "actif", true), /^actif: true$/m);
    assert.match(poserPropriete(fm, "vide", null), /^vide: null$/m);
    assert.match(poserPropriete(fm, "vide", ""), /^vide: ""$/m);
  });
  test("espacement, commentaire de fin de ligne et style de liste conservés", () => {
    assert.match(poserPropriete(fm, "statut", "fait"), /^statut: {4}fait {3}# espaces conservés$/m);
    assert.match(poserPropriete(fm, "liste_flux", ["a", "b,c"]), /^liste_flux: \[a, "b,c"\]$/m);
    assert.match(poserPropriete(fm, "liste_colonne0", ["z"]), /^liste_colonne0:\n- z\nresume:/m);
    assert.match(poserPropriete(fm, "tags", ["t"]), /^tags:\n {2}- t # commentaire dans la liste\nliste_flux:/m);
    assert.match(poserPropriete(fm, "clé citée", "autre"), /^"clé citée": autre$/m);
  });
  test("fins de ligne CRLF et marque d'ordre des octets conservées ; création du frontmatter", () => {
    const crlf = "\uFEFF---\r\na: 1\r\nb: 2\r\n---\r\n# T\r\n";
    assert.equal(poserPropriete(crlf, "a", ["x"]), "\uFEFF---\r\na:\r\n  - x\r\nb: 2\r\n---\r\n# T\r\n");
    assert.equal(poserPropriete("# Sans\n", "statut", "en cours"), "---\nstatut: en cours\n---\n# Sans\n");
    assert.equal(poserPropriete("# Sans\n", "statut", undefined), "# Sans\n");
    assert.equal(poserPropriete("---\n---\nx", "a", 1), "---\na: 1\n---\nx");
  });
  test("refus 422 : YAML invalide, doublons, ancres/alias, <<, étiquettes, objet ciblé, non fini, date invalide", () => {
    const refus = (c: string, cle: string, v: ValeurPropriete | undefined, raison: string, opts = {}) =>
      assert.throws(() => poserPropriete(c, cle, v, opts), (e: unknown) => e instanceof ErreurFormat && e.statut === 422 && e.raison === raison, `${raison} : ${c}`);
    refus("---\na: [\n---\n", "a", "x", "yaml_invalide");
    refus("---\n- a\n---\n", "a", "x", "yaml_invalide");
    refus("---\na: 1\na: 2\n---\n", "b", "x", "cle_en_double");
    refus("---\na: &x 1\nb: *x\n---\n", "c", "x", "syntaxe_refusee");
    refus("---\n<<: {a: 1}\nb: 2\n---\n", "b", "x", "syntaxe_refusee");
    refus("---\na: !!str 00123\n---\n", "b", "x", "syntaxe_refusee");
    refus("---\nn:\n  k: 1\n---\n", "n", "x", "valeur_imbriquee");
    refus(fm, "compteur", Number.NaN, "valeur_invalide");
    refus(fm, "compteur", Number.POSITIVE_INFINITY, "valeur_invalide");
    refus(fm, "echeance", "2026-13-45", "valeur_invalide", { type: "date" });
    refus(fm, "echeance", "2026-02-30", "valeur_invalide", { type: "date" });
    refus(fm, "mauvaise:cle", "x", "cle_invalide");
    refus(fm, "liste", [1 as unknown as string], "valeur_invalide");
    assert.equal(lireProprietes("---\na: 1\na: 2\n---\n").yamlValide, false);
    assert.equal(lireProprietes("---\na: &x 1\n---\n").modifiable, false);
  });
  test("poserChamp (V2) délègue à poserPropriete côté serveur, et garde la voie ligne à ligne si le YAML est refusé", () => {
    const d = decouper(fm);
    assert.equal(poserChamp(d.frontmatter, "statut", "fait"), decouper(poserPropriete(fm, "statut", "fait")).frontmatter);
    assert.equal(poserChamp(d.frontmatter, "statut", null), decouper(poserPropriete(fm, "statut", undefined)).frontmatter);
    const ancre = "---\na: &x 1\ntitle: Ancien\n---\n";
    assert.equal(poserChamp(ancre, "title", "Nouveau"), poserChampLigne(ancre, "title", "Nouveau"));
  });
  test("analyseur : positions exactes et syntaxes refusées repérées", () => {
    const a = analyserYaml("a: 1 # c\nb:\n  - x\n");
    assert.deepEqual(a.paires.map((p) => p.cle), ["a", "b"]);
    assert.equal(a.paires[1].valeur?.genre, "liste");
    assert.deepEqual(analyserYaml("a: &z 1\nb: *z\nc: !t x\n<<: {}\n").interdits.sort(), ["alias", "ancre", "clé de fusion", "étiquette"].sort());
  });
});

describe("identifiants et horodatages", () => {
  const d = new Date("2026-10-11T06:12:03Z");
  test("nouvelIdentifiant : préfixe, date locale Europe/Paris, 4 caractères base32", () => {
    const id = nouvelIdentifiant("cap", "Europe/Paris", d);
    assert.match(id, /^cap-20261011-0812-[0-9a-hjkmnp-tv-z]{4}$/);
    assert.match(id, RE_IDENTIFIANT);
    const ids = new Set(Array.from({ length: 200 }, () => nouvelIdentifiant("dec", "Europe/Paris", d)));
    assert.ok(ids.size > 190);
    assert.throws(() => nouvelIdentifiant("Cap!"));
  });
  test("horodatageIso avec fuseau ; dateDuJour dans le fuseau (minuit passé à Paris, pas en UTC)", () => {
    assert.equal(horodatageIso(d, "Europe/Paris"), "2026-10-11T08:12:03+02:00");
    assert.equal(horodatageIso(new Date("2026-12-01T12:00:00Z"), "Europe/Paris"), "2026-12-01T13:00:00+01:00");
    assert.equal(horodatageIso(d, "UTC"), "2026-10-11T06:12:03+00:00");
    assert.equal(dateDuJour("Europe/Paris", new Date("2026-10-10T22:30:00Z")), "2026-10-11");
    assert.equal(dateDuJour("UTC", new Date("2026-10-10T22:30:00Z")), "2026-10-10");
  });
});

describe("fixtures communes", () => {
  // Dossier à comparer aux fixtures, fourni par l'environnement : sans cette variable (cas du dépôt public), le test est sauté.
  const sourceFixtures = process.env.CARNET_FIXTURE_V3_SOURCE ? path.resolve(process.env.CARNET_FIXTURE_V3_SOURCE) : "";
  test("tests/fixtures/v3 = dossier de CARNET_FIXTURE_V3_SOURCE (copie à l'identique, quand la variable est définie)", (t) => {
    if (!sourceFixtures) return t.skip("CARNET_FIXTURE_V3_SOURCE non définie");
    if (!fs.existsSync(sourceFixtures)) return t.skip("CARNET_FIXTURE_V3_SOURCE ne désigne aucun dossier");
    const a = pagesFixtures();
    const b = new Map<string, string>();
    const parcourir = (rel: string) => {
      for (const d of fs.readdirSync(path.join(sourceFixtures, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${d.name}` : d.name;
        if (d.isDirectory()) parcourir(r);
        else if (d.name.endsWith(".md")) b.set(r, fs.readFileSync(path.join(sourceFixtures, r), "utf8"));
      }
    };
    parcourir("");
    assert.deepEqual([...a.keys()].sort(), [...b.keys()].sort());
    for (const [k, v] of a) assert.equal(b.get(k), v, k);
  });
});
