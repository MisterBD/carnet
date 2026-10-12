// Carnet · lot 3 : fichiers des agents (règles par chemins explicites, exceptions, boîte de capture jamais masquée).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { analyserRegle, ErreurRegle, estTechnique, lireTechniques, texteTechniques } from "../../shared/techniques.ts";
import { lireConfig } from "../src/config.ts";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

describe("règles (shared/techniques.ts)", () => {
  const def = lireTechniques(undefined);
  test("défaut : fichiers d'agents à toute profondeur, dossier raw/ et sa page", () => {
    for (const c of ["AGENTS.md", "AGENTS-lite.md", "CLAUDE.md", "CONFIG.md", "log.md", "Projets/Alpha/CLAUDE.md", "raw.md", "raw/session.md", "raw/a/b.md", "Projets/raw/x.md", "raw/image.png"]) {
      assert.equal(estTechnique(def, c), true, c);
    }
    for (const c of ["Accueil.md", "Notes/agents.md", "claude.md", "Raw/x.md", "rawdata/x.md", "Projets/CLAUDE.md.bak", "Journal/log.md.txt", "Démo/To-do.md"]) {
      assert.equal(estTechnique(def, c), false, c);
    }
  });
  test("Inbox/ et inbox/ jamais masqués, quelle que soit la casse ou la règle", () => {
    for (const c of ["Inbox/CLAUDE.md", "inbox/log.md", "INBOX/raw/x.md", "Inbox.md", "inbox.md", "raw/inbox/x.md"]) assert.equal(estTechnique(def, c), false, c);
    const t = lireTechniques("inbox/; Inbox/; /INBOX/; défaut");
    assert.deepEqual(t.ignorees, ["inbox/", "Inbox/", "/INBOX/"]);
    assert.equal(estTechnique(t, "inbox/a.md"), false);
    assert.equal(estTechnique(t, "Inbox/a.md"), false);
    assert.equal(estTechnique(t, "AGENTS.md"), true);
  });
  test("ancrage : barre en tête ou au milieu ; exceptions « ! » ; « défaut »", () => {
    const t = lireTechniques("défaut; /journal/; Équipe/notes-agent.md; !raw/LISEZ-MOI.md; !Projets/Beta/CLAUDE.md");
    assert.equal(estTechnique(t, "journal/2026.md"), true);
    assert.equal(estTechnique(t, "journal.md"), true);
    assert.equal(estTechnique(t, "Projets/journal/2026.md"), false, "ancré : pas en profondeur");
    assert.equal(estTechnique(t, "Équipe/notes-agent.md"), true);
    assert.equal(estTechnique(t, "Autre/Équipe/notes-agent.md"), false);
    assert.equal(estTechnique(t, "raw/LISEZ-MOI.md"), false, "exception");
    assert.equal(estTechnique(t, "raw/autre.md"), true);
    assert.equal(estTechnique(t, "Projets/Beta/CLAUDE.md"), false);
    assert.equal(estTechnique(t, "Projets/Alpha/CLAUDE.md"), true);
    // aller-retour par le texte servi à l'interface
    const t2 = lireTechniques(texteTechniques(t));
    for (const c of ["journal/2026.md", "Projets/journal/2026.md", "raw/LISEZ-MOI.md", "AGENTS.md", "Équipe/notes-agent.md"]) assert.equal(estTechnique(t2, c), estTechnique(t, c), c);
  });
  test("vide = aucune règle ; grammaire fermée (jokers, .., caché refusés)", () => {
    assert.equal(lireTechniques("").regles.length, 0);
    assert.equal(estTechnique(lireTechniques(""), "AGENTS.md"), false);
    for (const r of ["*.md", "raw/*", "a/../b.md", "../x.md", ".git/", "a\\b.md", "!", "/", "a//b.md", "fichier?.md"]) {
      assert.throws(() => analyserRegle(r), ErreurRegle, r);
    }
  });
  test("configuration : règle invalide = démarrage refusé ; règle sur inbox = avertissement", () => {
    const racine = fs.mkdtempSync(path.join(process.env.TMPDIR || "/tmp", "carnet-tech-"));
    try {
      const base = { CARNET_ESPACE: racine, CARNET_DEV: "1", CARNET_ETAT: path.join(racine, "..", path.basename(racine) + "-etat") };
      assert.throws(() => lireConfig({ ...base, CARNET_TECHNIQUES: "raw/*" }), /CARNET_TECHNIQUES/);
      const c = lireConfig({ ...base, CARNET_TECHNIQUES: "défaut; inbox/" });
      assert.ok(c.avertissements.some((a) => a.includes("inbox/")));
      assert.equal(lireConfig(base).techniques.regles.length, 6);
    } finally {
      fs.rmSync(racine, { recursive: true, force: true });
    }
  });
});

describe("routes", () => {
  let b: Banc;
  before(async () => {
    b = await demarrerBanc({ env: { CARNET_TECHNIQUES: "défaut; !raw/LISEZ-MOI.md" } });
    const ecrire = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(b.espace, rel)), { recursive: true }); fs.writeFileSync(path.join(b.espace, rel), t); };
    ecrire("AGENTS.md", "# Consignes des agents\n\n- [ ] tâche technique zorglubtech\n\nmotunique zorglubtech\n");
    ecrire("raw/session.md", "# Session brute\n\nzorglubtech @camille\n");
    ecrire("raw/LISEZ-MOI.md", "# Lisez-moi\n\nvisible\n");
    ecrire("Inbox/Idée.md", "# Idée capturée\n\ncontenu\n");
    ecrire("inbox/log.md", "# Journal de la boîte\n\ncontenu\n");
    await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.balayerTout()));
  });
  after(async () => { await b.fermer(); });

  test("GET /api/techniques : règles servies à l'interface", async () => {
    const r = await b.req("GET", "/api/techniques");
    assert.equal(r.statut, 200);
    assert.match(r.json.regles, /AGENTS\.md/);
    assert.match(r.json.regles, /!raw\/LISEZ-MOI\.md/);
    const t = lireTechniques(r.json.regles);
    assert.equal(estTechnique(t, "raw/session.md"), true);
    assert.equal(estTechnique(t, "raw/LISEZ-MOI.md"), false);
  });
  test("accueil : fichiers des agents exclus des récents, de « À relire » et des tâches ; Inbox présente", async () => {
    const r = await b.req("GET", "/api/accueil");
    assert.equal(r.statut, 200);
    const chemins = [...r.json.recents, ...r.json.aRelire, ...r.json.taches].map((x: { chemin: string }) => x.chemin);
    assert.ok(!chemins.includes("AGENTS.md"));
    assert.ok(!chemins.includes("raw/session.md"));
    assert.ok(r.json.recents.some((x: { chemin: string }) => x.chemin === "Inbox/Idée.md"));
    assert.ok(r.json.recents.some((x: { chemin: string }) => x.chemin === "inbox/log.md"), "inbox/log.md n'est jamais technique");
  });
  test("toujours accessibles (arbre, lecture) et trouvables par une recherche explicite", async () => {
    const arbre = await b.req("GET", "/api/arbre");
    assert.ok(arbre.json.racine.some((n: { chemin: string }) => n.chemin === "AGENTS.md"));
    assert.equal((await b.req("GET", "/api/page?chemin=" + q("raw/session.md"))).statut, 200);
    const s = await b.req("GET", "/api/recherche?q=zorglubtech");
    const trouves = s.json.resultats.map((x: { chemin: string }) => x.chemin);
    assert.ok(trouves.includes("AGENTS.md") && trouves.includes("raw/session.md"));
  });
});
