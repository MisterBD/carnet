// Carnet · finale V3 (nuit du 11/10/2026) : corrections de dernière minute, côté serveur.
// - une copie de conflit d'un fichier de « Modèles/ » n'est pas proposée comme modèle (elle reste une page visible).
import "../src/analyseur-yaml.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
const rq = () => crypto.randomUUID();
const disque = (rel: string) => path.join(b.espace, rel);
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));

before(async () => {
  b = await demarrerBanc({
    preparer: (_r, espace) => {
      const w = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(espace, rel)), { recursive: true }); fs.writeFileSync(path.join(espace, rel), t); };
      w("Modèles/Compte rendu.md", "---\ntitle: \"{{titre}}\"\ncree: {{date}}\n---\n# {{titre}}\n\nLe {{date}}.\n");
      w("Modèles/Réunion.md", "# {{titre}}\n\nOrdre du jour.\n");
    },
  });
});
after(async () => { await b.fermer(); });

describe("modèles × copies de conflit", () => {
  test("la copie de conflit d'un modèle reste une page du dossier, mais n'est pas proposée comme modèle", async () => {
    const avant = await b.req("GET", "/api/modeles");
    assert.equal(avant.statut, 200, avant.texte);
    assert.deepEqual(avant.json.modeles.map((m: { chemin: string }) => m.chemin), ["Modèles/Compte rendu.md", "Modèles/Réunion.md"]);
    const mien = "---\ntitle: \"{{titre}}\"\ncree: {{date}}\n---\n# {{titre}}\n\nLe {{date}}. Ma retouche du modèle.\n";
    const copie = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Modèles/Compte rendu.md", contenu: mien }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(copie.statut, 201, copie.texte);
    const rel = copie.json.chemin as string;
    assert.match(rel, /^Modèles\/Compte rendu \(conflit \d{4}-\d\d-\d\d \d\dh\d\d\)\.md$/);
    // En-tête de modèle (`cree: {{date}}` = table YAML) : la copie est gardée telle quelle, sans `conflit_de` ; c'est
    // son NOM de copie de conflit qui la retire de la liste des modèles.
    assert.match(fs.readFileSync(disque(rel), "utf8"), /Ma retouche du modèle\./);
    const apres = await b.req("GET", "/api/modeles");
    assert.deepEqual(apres.json.modeles.map((m: { chemin: string }) => m.chemin), ["Modèles/Compte rendu.md", "Modèles/Réunion.md"]);
    // toujours visible et lisible comme page
    const page = await b.req("GET", "/api/page?chemin=" + q(rel));
    assert.equal(page.statut, 200, page.texte);
    assert.equal(JSON.stringify((await b.req("GET", "/api/arbre")).json).includes(path.basename(rel, ".md")), true);
  });

  test("copie de conflit d'un modèle à l'en-tête simple : marquée `conflit_de`, absente des modèles", async () => {
    const copie = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Modèles/Réunion.md", contenu: "# {{titre}}\n\nOrdre du jour retouché.\n" }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(copie.statut, 201, copie.texte);
    assert.match(fs.readFileSync(disque(copie.json.chemin), "utf8"), /conflit_de: (["']?)Modèles\/Réunion\.md\1/);
    const r = await b.req("GET", "/api/modeles");
    assert.deepEqual(r.json.modeles.map((m: { chemin: string }) => m.chemin), ["Modèles/Compte rendu.md", "Modèles/Réunion.md"]);
  });

  test("un modèle dont la provenance `conflit_de` est retirée redevient un modèle (le fichier fait foi)", async () => {
    const rel = "Modèles/Ancienne copie.md";
    fs.writeFileSync(disque(rel), "---\nconflit_de: \"Modèles/Réunion.md\"\n---\n# Ancienne copie\n");
    await indexer(["Modèles"]);
    let r = await b.req("GET", "/api/modeles");
    assert.equal(r.json.modeles.some((m: { chemin: string }) => m.chemin === rel), false);
    fs.writeFileSync(disque(rel), "# Ancienne copie\n");
    await indexer(["Modèles"]);
    r = await b.req("GET", "/api/modeles");
    assert.equal(r.json.modeles.some((m: { chemin: string }) => m.chemin === rel), true);
  });
});

describe("K10-04 : proposition non renseignée", () => {
  const vide = (id: string) => `---\ntype: decision\nid: ${id}\nstatut: en attente\ndemandee_par: Sacha\n---\n\n# Achat vide\n\n## Proposition\n\n- Objet : \n- Action demandée : \n- Périmètre : \n- Annexes : aucune\n`;
  const decider = (corps: Record<string, unknown>) => b.req("POST", "/api/decision", { corps, entetes: { "X-Carnet-Requete": rq() } });
  async function poser(rel: string, contenu: string) {
    fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
    fs.writeFileSync(disque(rel), contenu);
    await indexer([rel.split("/")[0]]);
    return (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
  }

  test("objet et action vides : pas approuvable (422 explicite, rien d'écrit, aucune attestation) ; correction possible", async () => {
    const rel = "K10/Vide.md";
    const v = await poser(rel, vide("dec-k10-vide"));
    assert.equal(v.decidable, true);
    assert.equal(v.approuvable, false);
    assert.deepEqual(v.vides, ["objet", "action demandée"]);
    assert.match(v.raison_approbation.replace(/\u00a0/g, " "), /« objet » et « action demandée » sont vides/);
    const avant = fs.readFileSync(disque(rel), "utf8");
    const r = await decider({ chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id });
    assert.equal(r.statut, 422, r.texte);
    assert.equal(r.json.raison, "proposition_incomplete");
    assert.deepEqual(r.json.vides, ["objet", "action demandée"]);
    assert.equal(fs.readFileSync(disque(rel), "utf8"), avant);
    assert.equal((await b.req("GET", "/api/attestations?chemin=" + q(rel))).json.attestations.length, 0);
    // pas de défi de clé d'accès non plus
    const d = await b.req("POST", "/api/decision/defi", { corps: { chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id } });
    assert.equal(d.statut, 422, d.texte);
    // « à corriger » reste possible (et attesté)
    const c = await decider({ chemin: rel, resultat: "à corriger", empreinte: v.empreinte, demande: v.id, commentaire: "Remplis l'objet et l'action." });
    assert.equal(c.statut, 200, c.texte);
    assert.match(fs.readFileSync(disque(rel), "utf8"), /statut: à corriger/);
  });

  test("objet rempli, action vide : toujours refusé ; les deux remplis : approuvée", async () => {
    const rel = "K10/Moitié.md";
    const base = vide("dec-k10-moitie").replace("- Objet : \n", "- Objet : acheter un écran\n");
    let v = await poser(rel, base);
    assert.deepEqual(v.vides, ["action demandée"]);
    assert.equal((await decider({ chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id })).statut, 422);
    v = await poser(rel, base.replace("- Action demandée : \n", "- Action demandée : commander l'écran (300 €)\n"));
    assert.equal(v.approuvable, true);
    assert.deepEqual(v.vides, []);
    const r = await decider({ chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id });
    assert.equal(r.statut, 200, r.texte);
    assert.match(fs.readFileSync(disque(rel), "utf8"), /statut: approuvée/);
  });

  test("proposition en texte libre (sans rubriques) : approuvable, les rubriques manquantes restent un avertissement", async () => {
    const rel = "K10/Libre.md";
    const v = await poser(rel, vide("dec-k10-libre").replace(/## Proposition\n\n[\s\S]*$/, "## Proposition\n\nCommander l'écran de 27 pouces à 300 € TTC.\n"));
    assert.equal(v.approuvable, true);
    assert.ok(v.manques.includes("objet"));
  });
});
