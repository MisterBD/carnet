// Carnet · lot 10 « Missions vivantes » : GET /api/missions (lecture seule).
// Valeurs absentes, inconnues, livrables cassés, dates invalides, zones masquées et cachées, fichiers techniques,
// aucune écriture par la consultation, mise à jour en direct, reconstruction après redémarrage.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { creerApplication } from "../src/app.ts";
import { calculerMissions, lireSignal } from "../src/missions.ts";
import { attendre, demarrerBanc, ouvrirSse, requete } from "./aide.ts";
import type { Banc } from "./aide.ts";

const FICHES: Record<string, string> = {
  // exemple de fiche, complet
  "Missions/Audit Atelier Nord.md": `---
type: mission
id: mis-20261010-2240-k3f9
demande_par: Camille
responsable_declare: Sacha
etat: à arbitrer
dernier_signal: 2026-10-10T22:40:00+02:00
prochain_pas: Envoyer le brouillon d'audit à Camille
blocage: ""
livrables:
  - "[[Clients/Atelier Nord/Audit v1]]"
decision: "[[Décisions/Choix de l'offre]]"
client: "[[Clients/Atelier Nord]]"
---

# Audit Atelier Nord

## Demande
Préparer l'audit **IA** de l'atelier, en [[Clients/Atelier Nord|deux]] volets.

Deuxième paragraphe ignoré.

## Journal
- 2026-10-10 21:00 · Sacha : démarrage.
- 2026-10-10 22:40 · Sacha : brouillon prêt, attend relecture.
`,
  "Clients/Atelier Nord.md": "# Atelier Nord\n\nFiche client neutre.\n",
  "Clients/Atelier Nord/Audit v1.md": "# Audit v1\n\nBrouillon.\n",
  // Intégration lot 3 : demande de décision complète (id + « ## Proposition ») pour que son statut effectif soit « en attente ».
  "Décisions/Choix de l'offre.md": "---\ntype: decision\nid: dec-20261010-2240-k3f9\nstatut: en attente\n---\n# Choix de l'offre\n\n## Proposition\n\nRetenir l'offre en deux volets.\n",
  "Missions/Livrée.md": `---
type: mission
id: mis-livree
responsable_declare: Noé
etat: Terminée déclarée
dernier_signal: 2026-10-10T20:00:00Z
livrables:
  - "[[Livrables/Rapport]]"
  - "https://exemple.test/rapport"
---
# Livrée
`,
  "Livrables/Rapport.md": "# Rapport\n\nLe résultat.\n",
  "Missions/Sans livrable.md": "---\ntype: mission\netat: terminée déclarée\nlivrables: []\n---\n# Sans livrable\n",
  "Missions/Livrable cassé.md": "---\ntype: mission\netat: terminée déclarée\nlivrables:\n  - \"[[Livrables/Inexistant]]\"\n---\n# Livrable cassé\n",
  "Missions/Externe seulement.md": "---\ntype: mission\netat: terminée déclarée\nlivrables: \"https://exemple.test/doc?x=1\"\n---\n# Externe seulement\n",
  "Missions/Liens piégés.md": `---
type: mission
etat: en cours
livrables:
  - "javascript:alert(1)"
  - 42
  - "[[Privé/Cachée]]"
  - "[[.git/config]]"
  - "[remonter](../../../etc/passwd)"
  - "[[Démo/Réunions/]]"
  - "[[inbox/Fournitures.txt]]"
  - "[page riche](../Démo/Page%20riche.md)"
  - "Démo/To-do"
  - "[[Livrables/Rapport|le rapport]]"
---
# Liens piégés
`,
  "Missions/Vide.md": "---\ntype: mission\n---\n",
  "Missions/Inconnu.md": "---\ntype: Mission\netat: terminé\ndernier_signal: hier soir\nresponsable_declare: [Sacha, Noé]\n---\n# Inconnu\n",
  "Missions/Bloquée.md": "---\ntype: mission\netat: bloquée\nblocage: Attend l'accès au dépôt\ndernier_signal: 2026-10-01 09:30\n---\n# Bloquée\n",
  "Missions/Futur.md": "---\ntype: mission\netat: en cours\ndernier_signal: 2099-01-01T00:00:00Z\n---\n# Futur\n",
  "Missions/Doublon A.md": "---\ntype: mission\nid: mis-double\netat: à faire\n---\n# Doublon A\n",
  "Missions/Doublon B.md": "---\ntype: mission\nid: mis-double\netat: abandonnée\n---\n# Doublon B\n",
  "Missions/Décision perdue.md": "---\ntype: mission\netat: à arbitrer\ndecision: \"[[Décisions/Disparue]]\"\n---\n# Décision perdue\n",
  "Missions/YAML cassé.md": "---\ntype: mission\netat: [en cours\n---\n# YAML cassé\n",
  "Notes/Pas une mission.md": "---\ntype: note\netat: en cours\n---\n# Pas une mission\n",
  // zones jamais montrées
  "Privé/Mission secrète.md": "---\ntype: mission\netat: en cours\n---\n# Mission secrète\nzorglubinterdit\n",
  ".agents/Mission cachée.md": "---\ntype: mission\netat: en cours\n---\n# Mission cachée\nzorglubinterdit\n",
  "Démo/_assets/Mission technique.md": "---\ntype: mission\netat: en cours\n---\n# Dans _assets\nzorglubinterdit\n",
  "agents/noe/Mission d'agent.md": "---\ntype: mission\netat: en cours\nresponsable_declare: Noé\n---\n# Mission d'agent\n",
};

async function poserFiches(espace: string): Promise<void> {
  for (const [rel, contenu] of Object.entries(FICHES)) {
    const p = path.join(espace, rel);
    await fsp.mkdir(path.dirname(p), { recursive: true });
    await fsp.writeFile(p, contenu);
  }
}

/** Empreinte de tout un dossier (chemins, tailles, dates, contenus) : la consultation ne doit rien y changer. */
function empreinte(racine: string): string {
  const h = crypto.createHash("sha256");
  const parcourir = (d: string) => {
    let entrees: fs.Dirent[];
    try { entrees = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    entrees.sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entrees) {
      const p = path.join(d, e.name);
      const st = fs.lstatSync(p);
      h.update(`${path.relative(racine, p)}|${st.size}|${st.mtimeMs}|${st.mode}\n`);
      if (e.isDirectory()) parcourir(p);
      else if (e.isFile()) h.update(fs.readFileSync(p));
    }
  };
  parcourir(racine);
  return h.digest("hex");
}

let b: Banc;
before(async () => { b = await demarrerBanc({ surveiller: true, preparer: (_r, espace) => poserFiches(espace) }); });
after(async () => { await b.fermer(); });

async function missions(): Promise<any> {
  const r = await b.req("GET", "/api/missions");
  assert.equal(r.statut, 200, r.texte);
  return r.json;
}
const parChemin = (j: any, c: string) => j.missions.find((m: any) => m.chemin === c);

describe("Missions : route", () => {
  test("GET /api/missions : JSON, no-store, compteurs cohérents", async () => {
    const r = await b.req("GET", "/api/missions");
    assert.equal(r.statut, 200);
    assert.match(String(r.entetes["content-type"]), /^application\/json/);
    assert.equal(r.entetes["cache-control"], "no-store");
    const j = r.json;
    assert.equal(typeof j.maintenant, "number");
    assert.equal(j.fuseau, "Europe/Paris");
    assert.equal(j.tronque, false);
    const c = j.compteurs;
    assert.equal(c.total, j.missions.length);
    assert.equal(c.a_arbitrer + c.resultats + c.en_cours + c.autres, c.total);
  });

  test("identité, méthode, lecture intersite", async () => {
    assert.equal((await b.req("GET", "/api/missions", { entetes: { "Tailscale-User-Login": undefined } })).statut, 403);
    assert.equal((await b.req("GET", "/api/missions", { entetes: { "Tailscale-User-Login": "intrus@exemple.test" } })).statut, 403);
    assert.equal((await b.req("POST", "/api/missions", { corps: {} })).statut, 405);
    assert.equal((await b.req("PUT", "/api/missions", { corps: {} })).statut, 405);
    assert.equal((await b.req("GET", "/api/missions", { entetes: { "Sec-Fetch-Site": "cross-site" } })).statut, 403);
    assert.equal((await b.req("GET", "/api/missions?chemin=..%2F..%2Fetc%2Fpasswd")).statut, 200); // paramètre ignoré
  });
});

describe("Missions : contenu des fiches", () => {
  test("fiche complète du contrat : déclaré, livrable, décision et client résolus, demande et journal", async () => {
    const m = parChemin(await missions(), "Missions/Audit Atelier Nord.md");
    assert.equal(m.titre, "Audit Atelier Nord");
    assert.equal(m.id, "mis-20261010-2240-k3f9");
    assert.equal(m.demande_par, "Camille");
    assert.equal(m.responsable_declare, "Sacha");
    assert.deepEqual(m.etat, { brut: "à arbitrer", code: "a_arbitrer" });
    assert.equal(m.section, "a_arbitrer");
    assert.equal(m.signal.date, Date.parse("2026-10-10T20:40:00Z"));
    assert.equal(m.signal.precision, "minute");
    assert.equal(m.signal.fuseau, true);
    assert.equal(typeof m.observe, "number");
    assert.equal(m.prochain_pas, "Envoyer le brouillon d'audit à Camille");
    assert.equal(m.blocage, null, "blocage vide = absent");
    assert.equal(m.livrables.length, 1);
    assert.deepEqual(m.livrables[0], { brut: "[[Clients/Atelier Nord/Audit v1]]", genre: "page", chemin: "Clients/Atelier Nord/Audit v1.md", titre: "Audit v1", url: null, resolu: true });
    assert.equal(m.resultat.chemin, "Clients/Atelier Nord/Audit v1.md");
    assert.equal(m.decision.chemin, "Décisions/Choix de l'offre.md");
    assert.equal(m.decision.statut, "en attente");
    // statut déclaré dans le fichier, gardé à part quand le serveur calcule le statut effectif (lot 3)
    if ("statut_declare" in m.decision) assert.equal(m.decision.statut_declare, "en attente");
    assert.equal(m.client.chemin, "Clients/Atelier Nord.md");
    assert.equal(m.demande, "Préparer l'audit IA de l'atelier, en deux volets.");
    assert.deepEqual(m.journal, { nb: 2, dernier: "2026-10-10 22:40 · Sacha : brouillon prêt, attend relecture." });
    assert.deepEqual(m.anomalies, []);
    assert.equal(m.technique, false);
    assert.match(m.etag, /^"[0-9a-f]{16}"$/);
  });

  test("terminée déclarée avec livrable qui résout : « Résultats disponibles », l'URL externe reste non vérifiée", async () => {
    const m = parChemin(await missions(), "Missions/Livrée.md");
    assert.equal(m.etat.code, "terminee_declaree");
    assert.equal(m.etat.brut, "Terminée déclarée");
    assert.equal(m.section, "resultats");
    assert.equal(m.resultat.chemin, "Livrables/Rapport.md");
    const ext = m.livrables[1];
    assert.equal(ext.genre, "externe");
    assert.equal(ext.resolu, false);
    assert.equal(ext.url, "https://exemple.test/rapport");
    assert.deepEqual(m.anomalies, []);
  });

  test("terminée déclarée sans livrable, livrable cassé, externe seulement : jamais « Résultats », anomalie explicite", async () => {
    const j = await missions();
    const sans = parChemin(j, "Missions/Sans livrable.md");
    assert.equal(sans.section, "a_arbitrer");
    assert.equal(sans.resultat, null);
    assert.deepEqual(sans.anomalies.map((a: any) => a.code), ["livrable_absent"]);
    assert.equal(sans.anomalies[0].texte, "terminée déclarée · livrable absent");
    const casse = parChemin(j, "Missions/Livrable cassé.md");
    assert.equal(casse.section, "a_arbitrer");
    assert.equal(casse.livrables[0].genre, "introuvable");
    assert.equal(casse.livrables[0].resolu, false);
    assert.deepEqual(casse.anomalies.map((a: any) => a.code), ["livrable_absent", "livrable_introuvable"]);
    const ext = parChemin(j, "Missions/Externe seulement.md");
    assert.equal(ext.section, "a_arbitrer");
    assert.equal(ext.livrables[0].url, "https://exemple.test/doc?x=1");
    assert.deepEqual(ext.anomalies.map((a: any) => a.code), ["livrable_non_verifie"]);
    assert.ok(!j.missions.some((m: any) => m.section === "resultats" && !m.resultat?.resolu));
  });

  test("liens piégés : schéma interdit, nombre, zones masquées et cachées, remontée hors de l'espace", async () => {
    const m = parChemin(await missions(), "Missions/Liens piégés.md");
    const l = m.livrables;
    assert.equal(l.length, 10);
    assert.deepEqual([l[0].genre, l[0].url, l[0].resolu], ["invalide", null, false]);
    assert.deepEqual([l[1].genre, l[1].brut], ["invalide", "42"]);
    // une zone masquée ou cachée répond exactement comme une page qui n'existe pas
    assert.deepEqual(l[2], { brut: "[[Privé/Cachée]]", genre: "introuvable", chemin: null, titre: "Privé/Cachée", url: null, resolu: false });
    assert.deepEqual([l[3].genre, l[3].chemin], ["introuvable", null]);
    assert.deepEqual([l[4].genre, l[4].chemin], ["introuvable", null]);
    assert.equal(l[5].resolu, true);
    assert.deepEqual([l[6].genre, l[6].chemin, l[6].resolu], ["fichier", "inbox/Fournitures.txt", true]);
    assert.deepEqual([l[7].genre, l[7].chemin], ["page", "Démo/Page riche.md"]);
    assert.deepEqual([l[8].genre, l[8].chemin], ["page", "Démo/To-do.md"]);
    assert.deepEqual([l[9].genre, l[9].chemin, l[9].titre], ["page", "Livrables/Rapport.md", "Rapport"]);
    assert.deepEqual(m.anomalies.map((a: any) => a.code), ["livrable_invalide", "livrable_invalide"]);
    const texteJson = JSON.stringify(m);
    assert.ok(!texteJson.includes("zorglubinterdit"));
    assert.ok(!texteJson.includes("secret"));
  });

  test("un dossier demandé avec « / » final est un dossier", async () => {
    const m = parChemin(await missions(), "Missions/Liens piégés.md");
    // « [[Démo/Réunions/]] » : le dossier, pas la page homonyme
    assert.equal(m.livrables[5].genre, "dossier");
    assert.equal(m.livrables[5].chemin, "Démo/Réunions");
  });

  test("valeurs absentes : fiche réduite à « type: mission »", async () => {
    const m = parChemin(await missions(), "Missions/Vide.md");
    assert.equal(m.titre, "Vide");
    assert.equal(m.id, null);
    assert.deepEqual(m.etat, { brut: null, code: null });
    assert.equal(m.section, "autres");
    assert.deepEqual(m.signal, { brut: null, date: null, precision: null, fuseau: false });
    assert.equal(m.demande, null);
    assert.equal(m.responsable_declare, null);
    assert.equal(m.prochain_pas, null);
    assert.deepEqual(m.livrables, []);
    assert.equal(m.resultat, null);
    assert.equal(m.decision, null);
    assert.equal(m.client, null);
    assert.deepEqual(m.journal, { nb: 0, dernier: null });
    assert.deepEqual(m.anomalies.map((a: any) => a.code), ["etat_absent"]);
  });

  test("valeurs inconnues : état montré tel quel dans « Autres », signal illisible, responsable en liste", async () => {
    const m = parChemin(await missions(), "Missions/Inconnu.md");
    assert.deepEqual(m.etat, { brut: "terminé", code: null }, "« terminé » n'est pas réinterprété en « terminée déclarée »");
    assert.equal(m.section, "autres");
    assert.equal(m.responsable_declare, "Sacha, Noé");
    assert.deepEqual(m.signal, { brut: "hier soir", date: null, precision: null, fuseau: false });
    assert.deepEqual(m.anomalies.map((a: any) => a.code), ["etat_inconnu", "signal_illisible"]);
    assert.equal(m.anomalies[0].texte, "état inconnu : « terminé »");
  });

  test("bloquée : section « En cours », en tête, blocage gardé ; heure sans fuseau lue à Paris", async () => {
    const j = await missions();
    const m = parChemin(j, "Missions/Bloquée.md");
    assert.equal(m.section, "en_cours");
    assert.equal(m.blocage, "Attend l'accès au dépôt");
    assert.equal(m.signal.date, Date.parse("2026-10-01T07:30:00Z"));
    assert.equal(m.signal.fuseau, false);
    const enCours = j.missions.filter((x: any) => x.section === "en_cours");
    assert.equal(enCours[0].chemin, "Missions/Bloquée.md");
    assert.equal(j.compteurs.bloquees, 1);
  });

  test("signal dans le futur, décision introuvable, identifiants en double", async () => {
    const j = await missions();
    assert.deepEqual(parChemin(j, "Missions/Futur.md").anomalies.map((a: any) => a.code), ["signal_futur"]);
    const d = parChemin(j, "Missions/Décision perdue.md");
    assert.equal(d.decision.resolu, false);
    assert.equal(d.decision.statut, null);
    assert.deepEqual(d.anomalies.map((a: any) => a.code), ["decision_introuvable"]);
    const a = parChemin(j, "Missions/Doublon A.md");
    const bb = parChemin(j, "Missions/Doublon B.md");
    assert.match(a.anomalies.find((x: any) => x.code === "id_double").texte, /Doublon B/);
    assert.match(bb.anomalies.find((x: any) => x.code === "id_double").texte, /Doublon A/);
    assert.equal(bb.section, "autres");
  });

  test("seules les pages `type: mission` comptent ; YAML illisible = pas une mission", async () => {
    const j = await missions();
    assert.equal(parChemin(j, "Notes/Pas une mission.md"), undefined);
    assert.equal(parChemin(j, "Missions/YAML cassé.md"), undefined);
    assert.ok(parChemin(j, "Missions/Inconnu.md"), "« type: Mission » (casse) reconnu");
  });

  test("mission dans un dossier masqué, caché ou _assets : jamais listée ; dossier d'agent : listée", async () => {
    const j = await missions();
    const t = JSON.stringify(j);
    assert.ok(!t.includes("secrète") && !t.includes("cachée") && !t.includes("Dans _assets") && !t.includes("zorglubinterdit"));
    assert.ok(parChemin(j, "agents/noe/Mission d'agent.md"));
    // règle « fichier technique » du lot 3 branchée : la fiche reste montrée, signalée
    const r = calculerMissions(b.app.espace, { estTechnique: (c) => c.startsWith("agents/") });
    const m = r.missions.find((x) => x.chemin === "agents/noe/Mission d'agent.md")!;
    assert.equal(m.technique, true);
    assert.equal(r.missions.find((x) => x.chemin === "Missions/Livrée.md")!.technique, false);
  });
});

describe("Missions : dates déclarées", () => {
  test("formats acceptés et refusés", () => {
    const d = (v: unknown) => lireSignal(v).date;
    assert.equal(d("2026-10-10T22:40:00+02:00"), Date.parse("2026-10-10T20:40:00Z"));
    assert.equal(d("2026-10-10T22:40+0200"), Date.parse("2026-10-10T20:40:00Z"));
    assert.equal(d("2026-10-10T20:40:00.123Z"), Date.parse("2026-10-10T20:40:00Z"));
    assert.equal(d("2026-10-10 22:40"), Date.parse("2026-10-10T20:40:00Z"), "été : UTC+2");
    assert.equal(d("2026-01-15 10:00"), Date.parse("2026-01-15T09:00:00Z"), "hiver : UTC+1");
    assert.equal(lireSignal("2026-10-10").precision, "jour");
    assert.equal(d("2026-10-10"), Date.parse("2026-10-09T22:00:00Z"));
    assert.equal(d(new Date("2026-10-10T20:40:00Z")), Date.parse("2026-10-10T20:40:00Z"));
    for (const faux of ["hier soir", "2026-02-31", "2026-13-01", "2026-10-10T25:00", "2026-10-10T22:61", "10/10/2026", "2026-10-10T22:40:00+15:00", 1728590400, true, [], {}]) {
      const s = lireSignal(faux);
      assert.equal(s.date, null, String(faux));
      assert.notEqual(s.brut, null, String(faux));
    }
    assert.deepEqual(lireSignal(""), { brut: null, date: null, precision: null, fuseau: false });
    assert.deepEqual(lireSignal(null), { brut: null, date: null, precision: null, fuseau: false });
  });
});

describe("Missions : lecture seule, direct, redémarrage", () => {
  test("consulter n'écrit aucun fichier (espace et état) et n'émet aucun événement", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(200);
      const avantEspace = empreinte(b.espace);
      const avantEtat = empreinte(b.etat);
      const n0 = s.evenements.length;
      for (let i = 0; i < 5; i++) await missions();
      await attendre(400);
      assert.equal(empreinte(b.espace), avantEspace);
      assert.equal(empreinte(b.etat), avantEtat);
      assert.equal(s.evenements.length, n0, JSON.stringify(s.evenements.slice(n0)));
    } finally {
      s.fermer();
    }
  });

  test("une fiche modifiée sur disque : événement « modif » puis la route rend le nouvel état", async () => {
    const rel = "Missions/Bloquée.md";
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      const tmp = path.join(b.espace, "Missions/.Bloquée.md.agent.tmp");
      fs.writeFileSync(tmp, "---\ntype: mission\netat: en cours\nprochain_pas: Relancer les tests\ndernier_signal: 2026-10-10T23:05:00+02:00\n---\n# Bloquée\n");
      fs.renameSync(tmp, path.join(b.espace, rel));
      await s.attendre((e) => e.type === "modif" && e.chemin === rel, 2000);
      const m = parChemin(await missions(), rel);
      assert.equal(m.etat.code, "en_cours");
      assert.equal(m.prochain_pas, "Relancer les tests");
      assert.equal(m.blocage, null);
      assert.equal(m.signal.date, Date.parse("2026-10-10T21:05:00Z"));
    } finally {
      s.fermer();
    }
  });

  test("le livrable qui apparaît fait passer la fiche dans « Résultats disponibles »", async () => {
    const s = await ouvrirSse(b.port);
    try {
      await attendre(50);
      assert.equal(parChemin(await missions(), "Missions/Livrable cassé.md").section, "a_arbitrer");
      fs.mkdirSync(path.join(b.espace, "Livrables"), { recursive: true });
      fs.writeFileSync(path.join(b.espace, "Livrables/Inexistant.md"), "# Inexistant\n\nFinalement livré.\n");
      await s.attendre((e) => e.type === "arbre", 2000);
      const m = parChemin(await missions(), "Missions/Livrable cassé.md");
      assert.equal(m.section, "resultats");
      assert.deepEqual(m.anomalies, []);
    } finally {
      s.fermer();
    }
  });

  test("redémarrage : un nouveau serveur sur le même espace reconstruit les mêmes missions depuis les .md", async () => {
    const avant = await missions();
    const app2 = await creerApplication(b.app.cfg, { surveiller: false });
    const port2 = await app2.demarrer();
    try {
      const r = await requete(port2, "GET", "/api/missions");
      assert.equal(r.statut, 200);
      const sans = (j: any) => ({ ...j, maintenant: 0 });
      assert.deepEqual(sans(r.json), sans(avant));
    } finally {
      await app2.arreter();
    }
  });
});
