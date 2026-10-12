// Carnet · tests du lot 1 « Aujourd'hui » : dates dans le fuseau, relevé et classement des tâches, captures (contenu
// hostile mais littéral), configuration (CARNET_INBOX, CARNET_FUSEAU), routes /api/aujourdhui et /api/boite.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  baseNomCapture, classer, contenuCapture, lienValide, plusJours, tachesOuvertes, titreUneLigne,
} from "../src/aujourdhui.ts";
import { dateDuJour, horodatageIso } from "../../shared/identifiants.ts";
import { lireFrontmatter } from "../src/espace.ts";
import { lireConfig, lireInbox } from "../src/config.ts";
import { creerApplication } from "../src/app.ts";
import crypto from "node:crypto";
import { decouper } from "../../shared/page.ts";
import { demarrerBanc, LOGIN, requete, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

describe("dates dans le fuseau", () => {
  test("date du jour et horodatage Europe/Paris (heure d'été, heure d'hiver, changement de jour)", () => {
    const ete = new Date("2026-10-10T22:30:00Z"); // 00:30 le 11 à Paris (UTC+2)
    assert.equal(dateDuJour("Europe/Paris", ete), "2026-10-11");
    assert.equal(dateDuJour("UTC", ete), "2026-10-10");
    assert.equal(horodatageIso(ete, "Europe/Paris"), "2026-10-11T00:30:00+02:00");
    const hiver = new Date("2026-12-31T23:15:09Z");
    assert.equal(horodatageIso(hiver, "Europe/Paris"), "2027-01-01T00:15:09+01:00");
    assert.equal(horodatageIso(hiver, "America/New_York"), "2026-12-31T18:15:09-05:00");
    assert.equal(plusJours("2026-10-31", 1), "2026-11-01");
    assert.equal(plusJours("2026-03-28", 7), "2026-04-04");
  });
});

describe("relevé des tâches", () => {
  const page = (contenu: string) => ({ chemin: "P.md", titre: "P", icone: null, mtime: 1, contenu });

  test("ouvertes seulement, hors frontmatter et hors code, statuts personnalisés conservés", () => {
    const t = tachesOuvertes(page([
      "---", "x: - [ ] dans le frontmatter", "---", "# P", "",
      "- [ ] À faire 📅 2026-10-12 ⏫",
      "- [x] Faite 📅 2026-10-01 ✅ 2026-10-02",
      "- [X] Faite aussi",
      "- [-] Annulée",
      "- [ ] Annulée par la date ❌ 2026-10-03",
      "- [/] En cours 🔁 every week",
      "- [?] Statut personnalisé",
      "```", "- [ ] Dans le code 📅 2026-10-12", "```",
      "~~~md", "- [ ] Dans le code aussi", "~~~",
      "  - [ ] Imbriquée 📅 2026-13-45",
      "1. [ ] Numérotée\r",
      "- [ ]",
    ].join("\n")));
    assert.equal(t.length, 6, JSON.stringify(t.map((x) => x.texte)));
    assert.deepEqual([t[0], t[1], t[2], t[4], t[5]].map((x) => x.libelle), ["À faire", "En cours", "Statut personnalisé", "Numérotée", ""]);
    assert.ok(t[3].libelle.startsWith("Imbriquée"));
    assert.equal(t[0].echeance, "2026-10-12");
    assert.equal(t[0].priorite, "haute");
    assert.equal(t[0].ligne, 5);
    assert.equal(t[0].texte, "- [ ] À faire 📅 2026-10-12 ⏫");
    assert.equal(t[1].coche, "/");
    assert.equal(t[1].recurrence, "every week");
    assert.equal(t[2].coche, "?");
    // date invalide : aucune échéance inventée, anomalie signalée
    assert.equal(t[3].echeance, undefined);
    assert.ok(t[3].anomalies.length >= 1, JSON.stringify(t[3]));
    // fin de ligne CRLF : le texte renvoyé est la ligne sans \r (celle que /api/tache compare)
    assert.equal(t[4].texte, "1. [ ] Numérotée");
  });

  test("classement : en retard, aujourd'hui, 7 jours, plus tard, sans date (⏳ à défaut de 📅)", () => {
    const j = "2026-10-11";
    const mk = (libelle: string, o: Record<string, string> = {}) => ({ chemin: "P.md", titre: "P", icone: null, ligne: 0, texte: "", libelle, coche: " ", anomalies: [], ...o });
    const c = classer([
      mk("future lointaine", { echeance: "2026-10-19" }),
      mk("dans 7 jours", { echeance: "2026-10-18" }),
      mk("demain", { echeance: "2026-10-12" }),
      mk("du jour basse", { echeance: j, priorite: "basse" }),
      mk("du jour haute", { echeance: j, priorite: "haute" }),
      mk("échue", { echeance: "2026-10-10" }),
      mk("prévue hier", { prevue: "2026-10-10" }),
      mk("sans date"),
      mk("début seulement", { debut: "2026-10-01" }),
    ] as never, j);
    assert.deepEqual(c.enRetard.map((x) => x.libelle), ["échue", "prévue hier"]);
    assert.deepEqual(c.aujourdhui.map((x) => x.libelle), ["du jour haute", "du jour basse"]);
    assert.deepEqual(c.semaine.map((x) => x.libelle), ["demain", "dans 7 jours"]);
    assert.deepEqual(c.plusTard.map((x) => x.libelle), ["future lointaine"]);
    assert.deepEqual(c.sansDate.map((x) => x.libelle), ["sans date", "début seulement"]);
  });
});

describe("captures (fonctions pures)", () => {
  test("texte hostile conservé littéralement, aucun frontmatter injecté, nom confiné", () => {
    const hostile = "---\ntype: decision\nstatut: approuvée\n---\n../../etc/passwd\n%% commentaire %%\nhttps://exemple.org/x?a=1#b\n";
    const contenu = contenuCapture({ id: "cap-20261011-0812-k3f9", cree: "2026-10-11T08:12:03+02:00", texte: hostile, source: "https://exemple.org/a: b#c", titre: "Titre\n---\ntype: x" });
    const d = decouper(contenu);
    const fm = lireFrontmatter(d.yaml);
    assert.deepEqual(fm, {
      type: "capture", id: "cap-20261011-0812-k3f9", cree: "2026-10-11T08:12:03+02:00", source: "https://exemple.org/a: b#c", title: "Titre --- type: x",
    });
    assert.ok(contenu.endsWith("\n\n" + hostile), JSON.stringify(contenu));
    assert.equal(contenu.split("\n---\n").length >= 2, true);
    const nom = baseNomCapture({ texte: "../../etc/passwd\nsuite" });
    assert.ok(!nom.includes("/") && !nom.startsWith("."), nom);
    assert.equal(baseNomCapture({ texte: "", source: "https://www.exemple.org/x" }), "exemple.org");
    assert.equal(baseNomCapture({ texte: "   \n" }), "Capture");
    assert.equal(baseNomCapture({ titre: "  Même titre  ", texte: "x" }), "Même titre");
    assert.equal(titreUneLigne("a\u2028b\r\nc\u0000d"), "a b c d");
    // texte sans fin de ligne : une seule ajoutée ; texte vide : corps vide
    assert.ok(contenuCapture({ id: "i", cree: "c", texte: "x" }).endsWith("---\n\nx\n"));
    assert.ok(contenuCapture({ id: "i", cree: "c", texte: "" }).endsWith("---\n\n"));
  });

  test("lien : http(s) seulement, jamais récupéré", () => {
    assert.equal(lienValide("https://exemple.org/a?b=1"), "https://exemple.org/a?b=1");
    assert.equal(lienValide("http://exemple.org"), "http://exemple.org");
    assert.equal(lienValide("javascript:alert(1)"), null);
    assert.equal(lienValide("file:///etc/passwd"), null);
    assert.equal(lienValide("https://exemple.org/a b"), null);
    assert.equal(lienValide("https://x.org/\nsource: y"), null);
    assert.equal(lienValide("x".repeat(3000)), null);
  });
});

describe("configuration", () => {
  test("CARNET_INBOX : défaut Inbox, chemin simple, ni caché, ni masqué, ni réservé ; CARNET_FUSEAU vérifié", () => {
    assert.deepEqual(lireInbox(undefined, new Set()), ["Inbox"]);
    assert.deepEqual(lireInbox("Notes/Boîte/", new Set()), ["Notes", "Boîte"]);
    for (const x of ["../x", ".cache", "a/../b", "artefacts", "Privé/x", "a\\b"]) {
      assert.throws(() => lireInbox(x, new Set(["Privé"])), /CARNET_INBOX/, x);
    }
    const base = { CARNET_ESPACE: fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "carnet-cfg-")), CARNET_DEV: "1" };
    try {
      assert.equal(lireConfig(base).fuseau, "Europe/Paris");
      assert.equal(lireConfig({ ...base, CARNET_FUSEAU: "UTC" }).fuseau, "UTC");
      assert.throws(() => lireConfig({ ...base, CARNET_FUSEAU: "Mars/Olympus" }), /CARNET_FUSEAU/);
    } finally {
      fs.rmSync(base.CARNET_ESPACE, { recursive: true, force: true });
    }
  });
});

describe("routes Aujourd'hui et Boîte", () => {
  let b: Banc;
  const jour = dateDuJour("Europe/Paris");
  const fichiers: Record<string, string> = {};
  before(async () => {
    b = await demarrerBanc();
    const ecrire = (rel: string, txt: string) => {
      fs.mkdirSync(path.dirname(path.join(b.espace, rel)), { recursive: true });
      fs.writeFileSync(path.join(b.espace, rel), txt);
      fichiers[rel] = txt;
    };
    ecrire("Jour/Tâches.md", [
      "# Tâches", "",
      `- [ ] Échue 📅 ${plusJours(jour, -2)}`,
      `- [ ] Du jour 📅 ${jour} 🔺`,
      `- [ ] Dans trois jours 📅 ${plusJours(jour, 3)}`,
      `- [ ] Le mois prochain 📅 ${plusJours(jour, 30)}`,
      "- [ ] Sans date",
      `- [x] Terminée 📅 ${jour} ✅ ${jour}`,
      "- [ ] Date invalide 📅 2026-13-45",
      "```", `- [ ] Dans le code 📅 ${jour}`, "```", "",
    ].join("\n"));
    ecrire("Inbox/Une capture.md", "---\ntype: capture\nid: cap-1\ncree: 2026-10-11T08:12:03+02:00\nsource: \"javascript:alert(1)\"\n---\n\nTexte de la capture.\n");
    ecrire("Inbox/Autre.md", "---\ntype: capture\ncree: 2026-10-11T09:00:00+02:00\nsource: https://exemple.org/a\n---\n\nPlus récente.\n");
    ecrire("Inbox/Sous/Profonde.md", "# Profonde\n");
    ecrire("inbox/Minuscule.md", "# Pas une capture de la boîte\n");
    await b.app.espace.traiter(["Jour", "Inbox", "inbox"]);
  });
  after(async () => { await b.fermer(); });

  test("GET /api/aujourdhui classe selon le fuseau, exclut terminées et code, ne réécrit rien", async () => {
    const avant = Object.fromEntries(Object.keys(fichiers).map((k) => [k, sha16(fs.readFileSync(path.join(b.espace, k)))]));
    const r = await b.req("GET", "/api/aujourdhui");
    assert.equal(r.statut, 200, r.texte);
    const j = r.json;
    assert.equal(j.date, jour);
    assert.equal(j.fuseau, "Europe/Paris");
    const de = (l: any[]) => l.filter((t) => t.chemin === "Jour/Tâches.md").map((t) => t.libelle);
    assert.deepEqual(de(j.enRetard), ["Échue"]);
    assert.deepEqual(de(j.aujourdhui), ["Du jour"]);
    assert.deepEqual(de(j.semaine), ["Dans trois jours"]);
    assert.deepEqual(de(j.plusTard), ["Le mois prochain"]);
    assert.ok(de(j.sansDate).includes("Sans date"));
    const invalide = j.sansDate.find((t: any) => t.chemin === "Jour/Tâches.md" && t.texte.includes("2026-13-45"));
    assert.ok(invalide && invalide.anomalies.length && !invalide.echeance, JSON.stringify(invalide));
    const toutes = [...j.enRetard, ...j.aujourdhui, ...j.semaine, ...j.plusTard, ...j.sansDate].map((t: any) => t.texte);
    assert.ok(!toutes.some((t: string) => t.includes("Terminée") || t.includes("Dans le code")));
    assert.equal(j.aujourdhui.find((t: any) => t.libelle === "Du jour").priorite, "plus-haute");
    assert.deepEqual(j.aRelire.critere, { statut: "à relire", mentions: ["@camille"] });
    assert.equal(j.boite, 2);
    for (const [k, h] of Object.entries(avant)) assert.equal(sha16(fs.readFileSync(path.join(b.espace, k))), h, k);
  });

  test("GET /api/boite : enfants directs de Inbox/ (casse respectée), plus récentes d'abord, lien non http filtré", async () => {
    const r = await b.req("GET", "/api/boite");
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.dossier, "Inbox");
    assert.deepEqual(r.json.captures.map((c: any) => c.chemin), ["Inbox/Autre.md", "Inbox/Une capture.md"]);
    const une = r.json.captures[1];
    assert.equal(une.source, null);
    assert.equal(une.id, "cap-1");
    assert.equal(une.extrait, "Texte de la capture.");
    assert.equal(r.json.captures[0].source, "https://exemple.org/a");
  });

  test("/api/config annonce le dossier des captures et le fuseau", async () => {
    const r = await b.req("GET", "/api/config");
    assert.equal(r.json.inbox, "Inbox");
    assert.equal(r.json.fuseau, "Europe/Paris");
  });
});

describe("POST /api/capture", () => {
  let b: Banc;
  const uuid = () => crypto.randomUUID();
  const inbox = () => (fs.existsSync(path.join(b.espace, "Inbox")) ? fs.readdirSync(path.join(b.espace, "Inbox")).sort() : []);
  const hors = () => {
    const out: string[] = [];
    const parcourir = (d: string) => {
      for (const e of fs.readdirSync(path.join(b.espace, d), { withFileTypes: true })) {
        const r = d ? `${d}/${e.name}` : e.name;
        if (r === "Inbox" || r.startsWith(".")) continue;
        if (e.isDirectory() && !e.isSymbolicLink()) parcourir(r); else out.push(r);
      }
    };
    parcourir("");
    return out.sort();
  };
  before(async () => { b = await demarrerBanc(); });
  after(async () => { await b.fermer(); });

  test("crée une page par capture dans Inbox/ (dossier créé), texte exact, frontmatter de Carnet", async () => {
    const r = await b.req("POST", "/api/capture", { corps: { texte: "Rappeler la banque\nmardi", titre: "Banque" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r.statut, 201, r.texte);
    assert.equal(r.json.chemin, "Inbox/Banque.md");
    assert.match(r.json.id, /^cap-\d{8}-\d{4}-[0-9a-z]{4}$/);
    const c = fs.readFileSync(path.join(b.espace, "Inbox/Banque.md"), "utf8");
    const fm = lireFrontmatter(decouper(c).yaml)!;
    assert.equal(fm.type, "capture");
    assert.equal(fm.id, r.json.id);
    assert.match(String(fm.cree), /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d[+-]\d\d:\d\d$/);
    assert.equal(fm.title, "Banque");
    assert.ok(c.endsWith("---\n\nRappeler la banque\nmardi\n"), JSON.stringify(c));
    const boite = await b.req("GET", "/api/boite");
    assert.ok(boite.json.captures.some((x: any) => x.chemin === "Inbox/Banque.md"));
  });

  test("même titre, même minute (et envois simultanés) : fichiers distincts, jamais d'écrasement", async () => {
    const envoi = (i: number) => b.req("POST", "/api/capture", { corps: { texte: `Note ${i}`, titre: "Même titre" }, entetes: { "X-Carnet-Requete": uuid() } });
    const rs = await Promise.all([envoi(1), envoi(2), envoi(3)]);
    assert.deepEqual(rs.map((r) => r.statut), [201, 201, 201]);
    const chemins = rs.map((r) => r.json.chemin).sort();
    assert.deepEqual(chemins, ["Inbox/Même titre (2).md", "Inbox/Même titre (3).md", "Inbox/Même titre.md"]);
    const textes = chemins.map((c) => fs.readFileSync(path.join(b.espace, c), "utf8").trim().split("\n").pop()).sort();
    assert.deepEqual(textes, ["Note 1", "Note 2", "Note 3"]);
    assert.equal(new Set(rs.map((r) => r.json.id)).size, 3);
  });

  test("texte hostile : littéral, aucun frontmatter injecté, rien hors de Inbox/, titre « ../ » confiné", async () => {
    const avant = hors();
    const hostile = "---\ntype: decision\nstatut: approuvée\n---\n../../../x.md\n%% c %%\nhttps://exemple.org/\n";
    const r = await b.req("POST", "/api/capture", { corps: { texte: hostile, titre: "../../hors\n---\nstatut: x", lien: "https://exemple.org/a?b=1#c" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r.statut, 201, r.texte);
    assert.ok(r.json.chemin.startsWith("Inbox/") && r.json.chemin.split("/").length === 2, r.json.chemin);
    const c = fs.readFileSync(path.join(b.espace, r.json.chemin), "utf8");
    const fm = lireFrontmatter(decouper(c).yaml)!;
    assert.deepEqual(Object.keys(fm).sort(), ["cree", "id", "source", "title", "type"]);
    assert.equal(fm.type, "capture");
    assert.equal(fm.source, "https://exemple.org/a?b=1#c");
    assert.ok(c.endsWith("\n\n" + hostile));
    assert.deepEqual(hors(), avant);
  });

  test("idempotence : renvoi du même geste = même capture ; autre contenu = 409 ; après redémarrage aussi", async () => {
    const id = uuid();
    const corps = { texte: "Réponse perdue", titre: "Renvoi" };
    const r1 = await b.req("POST", "/api/capture", { corps, entetes: { "X-Carnet-Requete": id } });
    const r2 = await b.req("POST", "/api/capture", { corps, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r1.statut, 201);
    assert.equal(r2.statut, 200);
    assert.equal(r2.json.rejoue, true);
    assert.equal(r2.json.chemin, r1.json.chemin);
    assert.equal(r2.json.id, r1.json.id);
    const r3 = await b.req("POST", "/api/capture", { corps: { ...corps, texte: "Autre" }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r3.statut, 409);
    assert.match(r3.json.erreur, /autre opération/);
    // redémarrage du serveur sur le même espace et le même état
    const cfg = lireConfig({
      CARNET_ESPACE: b.espace, CARNET_PORT: "0", CARNET_HOTE: "127.0.0.1", CARNET_STATIQUE: path.join(b.racine, "dist"),
      CARNET_UTILISATEURS_AUTORISES: LOGIN, CARNET_ORIGINES_ARTEFACTS: "http://carnet.test=http://art.test", CARNET_CLE: b.cle, CARNET_ETAT: b.etat,
    });
    const app2 = await creerApplication(cfg, { surveiller: false });
    const port2 = await app2.demarrer();
    try {
      const r4 = await requete(port2, "POST", "/api/capture", { corps, entetes: { "X-Carnet-Requete": id } });
      assert.equal(r4.json.rejoue, true, r4.texte);
      assert.equal(r4.json.chemin, r1.json.chemin);
    } finally {
      await app2.arreter();
    }
    assert.deepEqual(inbox().filter((n) => n.startsWith("Renvoi")), ["Renvoi.md"]);
  });

  test("refus : lien non http(s), capture vide, sans X-Carnet, origine étrangère, identifiant de requête invalide", async () => {
    const n = inbox().length;
    const r1 = await b.req("POST", "/api/capture", { corps: { texte: "x", lien: "javascript:alert(1)" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r1.statut, 400);
    assert.match(r1.json.erreur, /Lien refusé/);
    const r2 = await b.req("POST", "/api/capture", { corps: { texte: "  \n ", lien: "" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r2.statut, 400);
    assert.match(r2.json.erreur, /Capture vide/);
    const r3 = await b.req("POST", "/api/capture", { corps: { texte: "x" }, entetes: { "X-Carnet": undefined } });
    assert.equal(r3.statut, 403);
    const r4 = await b.req("POST", "/api/capture", { corps: { texte: "x" }, entetes: { Origin: "https://pirate.exemple" } });
    assert.equal(r4.statut, 403);
    const r5 = await b.req("POST", "/api/capture", { corps: { texte: "x" }, entetes: { "X-Carnet-Requete": "../../x" } });
    assert.equal(r5.statut, 400);
    const r6 = await b.req("POST", "/api/capture", { corps: { texte: 42 } });
    assert.equal(r6.statut, 400);
    assert.equal(inbox().length, n);
  });

  test("lien seul : capture nommée d'après l'hôte, URL enregistrée telle quelle", async () => {
    const r = await b.req("POST", "/api/capture", { corps: { lien: "https://www.exemple.org/article" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r.statut, 201, r.texte);
    assert.equal(r.json.chemin, "Inbox/exemple.org.md");
    const fm = lireFrontmatter(decouper(fs.readFileSync(path.join(b.espace, r.json.chemin), "utf8")).yaml)!;
    assert.equal(fm.source, "https://www.exemple.org/article");
  });

  test("tâche (route du socle) : cocher avec ✅ du jour, rejoué sans effet, décocher explicitement", async () => {
    const jour = dateDuJour("Europe/Paris");
    fs.mkdirSync(path.join(b.espace, "T"), { recursive: true });
    fs.writeFileSync(path.join(b.espace, "T/x.md"), "# x\n\n- [ ] Faire 📅 2026-10-12 ⏫ 🔁 every week ^t1\n");
    await b.app.espace.traiter(["T"]);
    const id = uuid();
    const corps = { chemin: "T/x.md", ligne: 2, texte: "- [ ] Faire 📅 2026-10-12 ⏫ 🔁 every week ^t1", coche: true, faite: true };
    const r1 = await b.req("POST", "/api/tache", { corps, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r1.statut, 200, r1.texte);
    const attendu = `- [x] Faire 📅 2026-10-12 ⏫ 🔁 every week ✅ ${jour} ^t1`;
    assert.equal(r1.json.texte, attendu);
    const r2 = await b.req("POST", "/api/tache", { corps, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r2.json.rejoue, true);
    assert.equal(fs.readFileSync(path.join(b.espace, "T/x.md"), "utf8"), `# x\n\n${attendu}\n`);
    const r3 = await b.req("POST", "/api/tache", { corps: { chemin: "T/x.md", ligne: 2, texte: attendu, coche: false, faite: null }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r3.statut, 200, r3.texte);
    assert.equal(fs.readFileSync(path.join(b.espace, "T/x.md"), "utf8"), "# x\n\n- [ ] Faire 📅 2026-10-12 ⏫ 🔁 every week ^t1\n");
  });
});
