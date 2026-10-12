// Carnet · tests de l'intégration V3 (nuit du 10/10/2026) : les points où deux lots se rencontrent.
// - lots 1 + 3 : la boîte de capture n'est jamais un « fichier des agents », même sous un autre nom qu'« Inbox » ;
//   l'écran Aujourd'hui n'affiche pas les fichiers des agents ;
// - lots 2 + 3 : le statut d'une demande de décision ne s'écrit pas par le panneau Propriétés ;
// - lots 0 + 4 : les versions automatiques (« -seance ») passent par la porte d'écriture du socle ;
// - lots 3 + 10 : une mission montre le statut EFFECTIF de sa décision liée, le statut écrit restant à part.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { lireConfig } from "../src/config.ts";
import { estTechnique } from "../../shared/techniques.ts";
import { dateDuJour } from "../../shared/identifiants.ts";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

describe("intégration lots 1 + 3 : boîte de capture et fichiers des agents", () => {
  test("CARNET_INBOX d'un autre nom, visé par une règle : la boîte reste visible (et c'est signalé)", async () => {
    const espace = await fsp.mkdtemp(path.join(os.tmpdir(), "carnet-int-"));
    try {
      const cfg = lireConfig({
        CARNET_ESPACE: espace, CARNET_UTILISATEURS_AUTORISES: "a@b.c", CARNET_INBOX: "Notes/Boîte", CARNET_TECHNIQUES: "défaut;Boîte/",
      });
      assert.deepEqual(cfg.inbox, ["Notes", "Boîte"]);
      assert.equal(estTechnique(cfg.techniques, "Notes/Boîte/Une capture.md"), false);
      assert.equal(estTechnique(cfg.techniques, "Notes/Boîte.md"), false);
      // la règle garde son effet ailleurs
      assert.equal(estTechnique(cfg.techniques, "Archives/Boîte/x.md"), true);
      assert.equal(estTechnique(cfg.techniques, "Projet/CLAUDE.md"), true);
      // sans règle qui la vise : rien n'est ajouté
      const cfg2 = lireConfig({ CARNET_ESPACE: espace, CARNET_UTILISATEURS_AUTORISES: "a@b.c", CARNET_INBOX: "Notes/Boîte" });
      assert.equal(cfg2.techniques.regles.some((r) => r.exception), false);
    } finally {
      await fsp.rm(espace, { recursive: true, force: true });
    }
  });
});

describe("intégration : routes croisées", () => {
  let b: Banc;
  const jour = dateDuJour("Europe/Paris");
  before(async () => {
    b = await demarrerBanc({
      env: { CARNET_PAUSE_VERSIONS: "1" },
      preparer: async (_racine, espace) => {
        const ecrire = (rel: string, contenu: string) => {
          fs.mkdirSync(path.dirname(path.join(espace, rel)), { recursive: true });
          fs.writeFileSync(path.join(espace, rel), contenu);
        };
        ecrire("Int/Suivi.md", `# Suivi\n\n- [ ] Tâche visible 📅 ${jour}\n`);
        ecrire("Int/AGENTS.md", `# Consignes\n\n- [ ] Tâche d'agent 📅 ${jour}\n`);
        ecrire("Int/Décision.md", "---\ntype: decision\nid: dec-20261010-2300-k3f9\nstatut: en attente\nmontant: 3\n---\n# Choisir\n\n## Proposition\n\nRetenir A.\n");
        ecrire("Int/Incomplète.md", "---\ntype: decision\nstatut: en attente\n---\n# Sans proposition\n");
        ecrire("Int/Mission.md", "---\ntype: mission\nid: mis-int\netat: à arbitrer\ndecision: \"[[Int/Incomplète]]\"\n---\n# Mission\n");
        ecrire("Int/Vieille.md", "---\nstatut: brouillon\n---\n# Vieille\n\nTexte.\n");
        const vieux = new Date(Date.now() - 3600_000);
        fs.utimesSync(path.join(espace, "Int/Vieille.md"), vieux, vieux);
      },
    });
  });
  after(async () => { await b?.fermer(); });

  test("Aujourd'hui : les tâches des fichiers des agents n'apparaissent pas", async () => {
    const r = await b.req("GET", "/api/aujourdhui");
    assert.equal(r.statut, 200);
    const chemins = r.json.aujourdhui.map((t: { chemin: string }) => t.chemin);
    assert.ok(chemins.includes("Int/Suivi.md"), JSON.stringify(chemins));
    assert.ok(!chemins.includes("Int/AGENTS.md"), JSON.stringify(chemins));
    assert.ok(!r.json.recents.some((p: { chemin: string }) => p.chemin === "Int/AGENTS.md"));
    assert.deepEqual(r.json.modules, { decisions: true, nouveautes: true });
  });

  test("Propriétés : « statut » et « engage » d'une décision refusés (422), les autres propriétés passent", async () => {
    const etag = (await b.req("GET", `/api/page?chemin=${q("Int/Décision.md")}`)).json.etag as string;
    for (const cle of ["statut", "engage"]) {
      const r = await b.req("POST", "/api/propriete", { corps: { chemin: "Int/Décision.md", cle, valeur: "approuvée" }, entetes: { "If-Match": etag } });
      assert.equal(r.statut, 422, r.texte);
      assert.equal(r.json.raison, "decision");
    }
    const ok = await b.req("POST", "/api/propriete", { corps: { chemin: "Int/Décision.md", cle: "montant", valeur: 4, type: "nombre" }, entetes: { "If-Match": etag } });
    assert.equal(ok.statut, 200, ok.texte);
    assert.match(fs.readFileSync(path.join(b.espace, "Int/Décision.md"), "utf8"), /statut: en attente\nmontant: 4\n/);
  });

  test("versions automatiques par la porte du socle : propriété posée après une pause → instantané « seance »", async () => {
    const avant = fs.readFileSync(path.join(b.espace, "Int/Vieille.md"), "utf8");
    const etag = (await b.req("GET", `/api/page?chemin=${q("Int/Vieille.md")}`)).json.etag as string;
    const r = await b.req("POST", "/api/propriete", { corps: { chemin: "Int/Vieille.md", cle: "statut", valeur: "à relire" }, entetes: { "If-Match": etag } });
    assert.equal(r.statut, 200, r.texte);
    const h = await b.req("GET", `/api/historique?chemin=${q("Int/Vieille.md")}`);
    const seances = h.json.versions.filter((v: { genre?: string }) => v.genre === "seance");
    assert.equal(seances.length, 1, JSON.stringify(h.json.versions));
    const v = await b.req("GET", `/api/version?chemin=${q("Int/Vieille.md")}&id=${encodeURIComponent(seances[0].id)}`);
    assert.equal(v.json.contenu, avant);
    // seconde écriture tout de suite après : pas de nouvelle séance
    const etag2 = (await b.req("GET", `/api/page?chemin=${q("Int/Vieille.md")}`)).json.etag as string;
    await b.req("POST", "/api/propriete", { corps: { chemin: "Int/Vieille.md", cle: "statut", valeur: "fait" }, entetes: { "If-Match": etag2 } });
    const h2 = await b.req("GET", `/api/historique?chemin=${q("Int/Vieille.md")}`);
    assert.equal(h2.json.versions.filter((x: { genre?: string }) => x.genre === "seance").length, 1);
  });

  test("Missions : statut effectif de la décision liée, statut écrit à part", async () => {
    const r = await b.req("GET", "/api/missions");
    assert.equal(r.statut, 200);
    const m = r.json.missions.find((x: { chemin: string }) => x.chemin === "Int/Mission.md");
    assert.ok(m, JSON.stringify(r.json.missions.map((x: { chemin: string }) => x.chemin)));
    assert.equal(m.decision.chemin, "Int/Incomplète.md");
    assert.equal(m.decision.statut, "incomplète");
    assert.equal(m.decision.statut_declare, "en attente");
  });
});
