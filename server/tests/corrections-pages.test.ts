// Carnet · tests du lot 4 « Corrections » (V3), côté pages : titre de page et H1 du corps (K2-01), contrat serveur
// sur lequel s'appuie l'interface pour qu'aucune saisie ne se perde pendant un renommage (K2-02).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";
import { commenceParH1, decouper } from "../../shared/page.ts";
import { nomSuitLeTitre, titreDe } from "../../shared/navigation.ts";

let b: Banc;
before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

const disque = (rel: string) => path.join(b.espace, rel);

describe("K2-01 : titre de page et « # Titre » du corps restent distincts", () => {
  test("commenceParH1 : seule une ligne « # … » en tête (après des lignes vides) compte", () => {
    assert.equal(commenceParH1("# Titre\n\nTexte"), true);
    assert.equal(commenceParH1("\n\n  # Titre"), true);
    assert.equal(commenceParH1("#etiquette en tête"), false);
    assert.equal(commenceParH1("## Sous-titre"), false);
    assert.equal(commenceParH1("Texte\n\n# Titre"), false);
    assert.equal(commenceParH1(""), false);
    assert.equal(commenceParH1("    # code indenté"), false);
  });
  test("le titre écrit par Carnet avant un H1 du corps est relu comme titre, le H1 reste dans le corps", () => {
    // forme écrite par PageVue pour une page sans titre écrit (titre = nom du fichier) dont le corps commence par un H1
    const contenu = "# Page K2\n\n# Titre du corps\n\nTexte.\n";
    const d = decouper(contenu);
    assert.equal(d.titreH1, "Page K2");
    assert.equal(d.corps, "# Titre du corps\n\nTexte.\n");
    assert.deepEqual(titreDe("Page K2.md", contenu), { titre: "Page K2", source: "h1" });
    assert.equal(nomSuitLeTitre("Page K2.md", contenu), true);
  });
  test("page à `title:` : le même titre écrit en « # » ; arbre (title:) et page (« # ») concordent", () => {
    const contenu = "---\ntitle: Titre en propriété\n---\n# Titre en propriété\n\n# Texte d'origine.\n";
    const d = decouper(contenu);
    assert.equal(d.titreH1, "Titre en propriété");
    assert.equal(d.corps, "# Texte d'origine.\n");
    assert.equal(titreDe("Propriété.md", contenu).titre, "Titre en propriété");
  });
  test("une page existante dont la première ligne est « # Titre » garde ce titre (lecture inchangée)", () => {
    for (const [c, t] of [["# Courses\n\nLait.\n", "Courses"], ["\n\n# Courses\n", "Courses"], ["---\nicon: 🧭\n---\n# Bravo\n\nx\n", "Bravo"]] as const) {
      assert.equal(decouper(c).titreH1, t);
      assert.equal(titreDe("X.md", c).titre, t);
    }
  });
});

describe("K2-02 : une écriture en retard après un renommage ne recrée jamais l'ancien fichier", () => {
  test("PUT à l'ancien chemin avec l'ancienne version : 412 « page absente » (etag et contenu null), rien de créé", async () => {
    const cree = await b.req("POST", "/api/page", { corps: { parent: "", titre: "Sans titre", contenu: "" } });
    assert.equal(cree.statut, 201);
    const ancien = cree.json.chemin as string;
    const etag = cree.json.etag as string;
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: ancien, nom: "Course lente" } });
    assert.equal(r.statut, 200);
    assert.equal(r.json.chemin, "Course lente.md");
    const tard = await b.req("PUT", "/api/page?chemin=" + q(ancien), { corps: { contenu: "Texte tapé." }, entetes: { "If-Match": etag } });
    assert.equal(tard.statut, 412);
    assert.equal(tard.json.etag, null);
    assert.equal(tard.json.contenu, null);
    assert.equal(fs.existsSync(disque(ancien)), false, "aucun « Sans titre.md » vide recréé");
    // le renommage garde le contenu : la même version (etag) vaut au nouveau chemin, où l'interface réécrit
    const bon = await b.req("PUT", "/api/page?chemin=" + q("Course lente.md"), { corps: { contenu: "Texte tapé.\n" }, entetes: { "If-Match": etag } });
    assert.equal(bon.statut, 200);
    assert.equal(bon.json.etag, sha16("Texte tapé.\n"));
    assert.equal(fs.readFileSync(disque("Course lente.md"), "utf8"), "Texte tapé.\n");
  });
  test("« Recréer la page avec mon texte » : création exclusive (If-None-Match: *) à l'adresse libérée, jamais d'écrasement", async () => {
    fs.writeFileSync(disque("Recréée.md"), "# Recréée\n");
    const sup = await b.req("POST", "/api/supprimer", { corps: { chemin: "Recréée.md" } });
    assert.equal(sup.statut, 200);
    const r = await b.req("PUT", "/api/page?chemin=" + q("Recréée.md"), { corps: { contenu: "# Recréée\n\nMon texte.\n" }, entetes: { "If-None-Match": "*" } });
    assert.equal(r.statut, 200);
    const encore = await b.req("PUT", "/api/page?chemin=" + q("Recréée.md"), { corps: { contenu: "écrasement" }, entetes: { "If-None-Match": "*" } });
    assert.equal(encore.statut, 412);
    assert.equal(fs.readFileSync(disque("Recréée.md"), "utf8"), "# Recréée\n\nMon texte.\n");
  });
  test("chemins hors de l'espace : refusés avant toute écriture", async () => {
    for (const c of ["../dehors.md", "/etc/passwd.md", "Démo/../../x.md", ".corbeille/x.md"]) {
      const r = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "x" }, entetes: { "If-None-Match": "*" } });
      assert.ok(r.statut === 400 || r.statut === 403 || r.statut === 404, `${c} : ${r.statut}`);
    }
    assert.equal(fs.existsSync(path.join(b.espace, "..", "dehors.md")), false);
  });
});
