// Carnet · lot 5 « Fiabilité » (V3) : intégrité d'écriture démontrable, côté serveur.
// Cas couverts : 2 (réponse perdue puis renvoi), 3 (copie de conflit, sans écrasement),
// 4 (arrêt brutal pendant l'enregistrement : processus tué entre le temporaire et le rename, et juste après),
// 5 (retour à la version marquée vue : aperçu, révision, attribution, version annulée conservée, barrière d'attestation).
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { creerApplication } from "../src/app.ts";
import type { Application } from "../src/app.ts";
import { lireConfig, lirePanneEssai } from "../src/config.ts";
import { contenuDeConflit, dateHeureConflit } from "../src/fiabilite.ts";
import { attendre, demarrerBanc, HOTE, LOGIN, lsTmp, q, requete, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

const AUTRE = "autre@exemple.test";
const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");

function lignesJournal(etat: string): any[] {
  const f = path.join(etat, "journal", "espace", "ecritures.jsonl");
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

const DECISION = (id: string, perimetre: string) => `---
type: decision
id: ${id}
statut: en attente
demandee_par: Lina
echeance: 2026-10-20
---

# Choisir le prestataire ${id.slice(-4)}

## Proposition

- Objet : choisir le prestataire
- Action demandée : signer le devis
- Périmètre : ${perimetre}
- Exclusions : aucune
- Conditions : livraison en novembre
- Annexes : aucune

## Notes

Texte libre.
`;

let b: Banc;
const disque = (rel: string) => path.join(b.espace, rel);
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
async function externe(rel: string, contenu: string): Promise<void> {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
  await indexer([rel.split("/")[0]]);
}
const rq = () => crypto.randomUUID();

before(async () => {
  b = await demarrerBanc({ env: { CARNET_UTILISATEURS_AUTORISES: `${LOGIN} ${AUTRE}` } });
  await externe("Fiab/Perdue.md", "# Perdue\n\nV0\n");
  await externe("Fiab/Note.md", "---\nid: note-1\n---\n# Note\n\nTexte du serveur.\n");
  await externe("Fiab/Décision.md", DECISION("dec-20261011-0901-fzaa", "5 pages"));
  await externe("Retour/Page.md", "# Page\n\nVersion vue.\n");
  await externe("Retour/Humaine.md", "# Humaine\n\nVersion vue.\n");
  await externe("Retour/Dec.md", DECISION("dec-20261011-0902-fzab", "5 pages"));
  await externe("Retour/Dec2.md", DECISION("dec-20261011-0903-fzac", "5 pages"));
  // premier lancement des nouveautés : toutes les pages actuelles sont « vues »
  assert.equal((await b.req("GET", "/api/nouveautes")).statut, 200);
});
after(async () => { await b.fermer(); });

describe("réponse perdue puis renvoi = une seule mutation", () => {
  test("même X-Carnet-Requete : rejoue, même etag, une seule entrée de journal, aussi après redémarrage", async () => {
    const r1 = "perdue-" + rq();
    const v1 = "# Perdue\n\nV1 tapée hors ligne.\n";
    const a = await b.req("PUT", "/api/page?chemin=" + q("Fiab/Perdue.md"), { corps: { contenu: v1 }, entetes: { "If-Match": sha16("# Perdue\n\nV0\n"), "X-Carnet-Requete": r1 } });
    assert.equal(a.statut, 200);
    assert.equal(a.json.rejoue, undefined);
    // la réponse est « perdue » : le client renvoie EXACTEMENT la même requête (même etag de base, même identifiant)
    const c = await b.req("PUT", "/api/page?chemin=" + q("Fiab/Perdue.md"), { corps: { contenu: v1 }, entetes: { "If-Match": sha16("# Perdue\n\nV0\n"), "X-Carnet-Requete": r1 } });
    assert.equal(c.statut, 200);
    assert.equal(c.json.rejoue, true);
    assert.equal(c.json.etag, a.json.etag);
    assert.equal(fs.readFileSync(disque("Fiab/Perdue.md"), "utf8"), v1);
    assert.equal(lignesJournal(b.etat).filter((l) => l.requete === r1).length, 1);
    // redémarrage sur le même CARNET_ETAT : le registre des requêtes est relu
    const app2 = await creerApplication(b.app.cfg, { surveiller: false });
    const port2 = await app2.demarrer();
    try {
      const d = await requete(port2, "PUT", "/api/page?chemin=" + q("Fiab/Perdue.md"), { corps: { contenu: v1 }, entetes: { "If-Match": sha16("# Perdue\n\nV0\n"), "X-Carnet-Requete": r1 } });
      assert.equal(d.statut, 200);
      assert.equal(d.json.rejoue, true);
      // même identifiant pour une autre opération : refusé, rien d'écrit
      const e = await requete(port2, "PUT", "/api/page?chemin=" + q("Fiab/Perdue.md"), { corps: { contenu: "autre" }, entetes: { "If-Match": a.json.etag, "X-Carnet-Requete": r1 } });
      assert.equal(e.statut, 409);
      assert.equal(e.json.erreur.includes("déjà servi"), true);
    } finally {
      await app2.arreter();
    }
    assert.equal(lignesJournal(b.etat).filter((l) => l.requete === r1).length, 1);
    assert.equal(fs.readFileSync(disque("Fiab/Perdue.md"), "utf8"), v1);
  });
});

describe("copie de conflit à nom unique, original intact", () => {
  test("nom « <Page> (conflit AAAA-MM-JJ HHhMM).md », deux copies la même minute → « (2) », conflit_de posé", async () => {
    const original = fs.readFileSync(disque("Fiab/Note.md"));
    const mienne = "---\nid: note-1\n---\n# Note\n\nTexte du serveur.\n\nMa ligne tapée pendant que l'agent écrivait.\n";
    const r1 = rq();
    const a = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md", contenu: mienne }, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(a.statut, 201, JSON.stringify(a.json));
    assert.match(a.json.chemin, /^Fiab\/Note \(conflit \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.md$/);
    const copie = fs.readFileSync(disque(a.json.chemin), "utf8");
    assert.match(copie, /^---\nid: note-1\nconflit_de: Fiab\/Note\.md\ntitle: Note \(conflit \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\n---\n/);
    assert.ok(copie.endsWith("Ma ligne tapée pendant que l'agent écrivait.\n"), "texte humain intégral");
    assert.equal(a.json.etag, sha16(copie));
    // renvoi (réponse perdue) : la même copie, pas une seconde
    const a2 = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md", contenu: mienne }, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(a2.json.chemin, a.json.chemin);
    assert.equal(a2.json.rejoue, true);
    // second geste dans la même minute : nom suivant, jamais d'écrasement
    const b2 = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md", contenu: mienne + "Encore.\n" }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(b2.statut, 201);
    if (b2.json.chemin.slice(0, 40) === a.json.chemin.slice(0, 40)) assert.match(b2.json.chemin, /\) \(2\)\.md$/);
    assert.notEqual(b2.json.chemin, a.json.chemin);
    assert.deepEqual(fs.readFileSync(disque("Fiab/Note.md")), original, "original intact octet pour octet");
    const j = lignesJournal(b.etat).filter((l) => l.action === "conflit");
    assert.equal(j.length, 2);
    assert.equal(j[0].avant, null);
  });
  test("demande de décision : la copie n'est jamais une seconde demande (type: decision-conflit)", async () => {
    const c = fs.readFileSync(disque("Fiab/Décision.md"), "utf8").replace("Texte libre.", "Texte libre et ma note.");
    const r = await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Décision.md", contenu: c }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 201);
    const copie = fs.readFileSync(disque(r.json.chemin), "utf8");
    assert.match(copie, /\ntype: decision-conflit\n/);
    assert.match(copie, /\nconflit_de: Fiab\/Décision\.md\n/);
    const decisions = (await b.req("GET", "/api/decisions")).json.decisions.map((d: { chemin: string }) => d.chemin);
    assert.ok(!decisions.includes(r.json.chemin));
  });
  test("chemins traversants, zone interdite, contenu manquant ou trop gros : refusés, rien de créé", async () => {
    const avant = fs.readdirSync(b.racine).sort();
    for (const chemin of ["../evade.md", "Fiab/../../evade.md", "/etc/passwd.md", ".git/x.md", "Privé/Cachée.md"]) {
      const r = await b.req("POST", "/api/page/conflit", { corps: { chemin, contenu: "x" } });
      assert.ok([400, 403, 404].includes(r.statut), `${chemin} : ${r.statut}`);
    }
    assert.equal((await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md" } })).statut, 400);
    assert.equal((await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md", contenu: "x".repeat(2 * 1024 * 1024 + 10) } })).statut, 413);
    assert.equal((await b.req("POST", "/api/page/conflit", { corps: { chemin: "Fiab/Note.md", contenu: "x" }, entetes: { "X-Carnet": undefined } })).statut, 403);
    assert.deepEqual(fs.readdirSync(b.racine).sort(), avant);
    assert.equal(fs.readdirSync(path.join(b.espace, "Privé")).some((n) => n.includes("conflit")), false);
  });
  test("forme du nom et du contenu (fonctions pures)", () => {
    assert.equal(dateHeureConflit("Europe/Paris", new Date("2026-10-11T00:14:03Z")), "2026-10-11 02h14");
    assert.equal(contenuDeConflit("# T\n\nx\n", "A/T.md"), "---\nconflit_de: A/T.md\n---\n# T\n\nx\n");
    // titre distinct dans l'arbre (title:), corps et « # T » intacts
    assert.equal(contenuDeConflit("# T\n\nx\n", "A/T.md", "conflit 2026-10-11 02h14"),
      "---\nconflit_de: A/T.md\ntitle: T (conflit 2026-10-11 02h14)\n---\n# T\n\nx\n");
    assert.equal(contenuDeConflit("x\n", "A/T.md", "conflit 2026-10-11 02h14"), "---\nconflit_de: A/T.md\n---\nx\n");
    // en-tête exotique refusé par la porte des propriétés : texte gardé tel quel
    const exotique = "---\na: &x 1\nb: *x\n---\n# T\n";
    assert.equal(contenuDeConflit(exotique, "A/T.md"), exotique);
  });
});

describe("revenir à la version marquée vue", () => {
  test("aperçu : différence, portée, écritures depuis, provenance externe ; 412 si la révision change, rien d'écrit", async () => {
    await externe("Retour/Page.md", "# Page\n\nVersion de l'agent.\nLigne ajoutée.\n");
    const ap = await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Page.md"));
    assert.equal(ap.statut, 200, JSON.stringify(ap.json));
    assert.equal(ap.json.vu.contenu, "# Page\n\nVersion vue.\n");
    assert.equal(ap.json.actuel.contenu, "# Page\n\nVersion de l'agent.\nLigne ajoutée.\n");
    assert.equal(ap.json.actuel.etag, sha16(ap.json.actuel.contenu));
    assert.ok(ap.json.bilan.ajouts > 0 && ap.json.bilan.retraits > 0, JSON.stringify(ap.json.bilan));
    assert.equal(ap.json.externe, true);
    assert.deepEqual(ap.json.humaines, []);
    assert.deepEqual(ap.json.decision, { estDecision: false, attestationNeutralisee: false });
    // l'agent écrit encore entre l'aperçu et la confirmation : rien n'est écrit
    const v3 = "# Page\n\nVersion de l'agent, encore modifiée.\n";
    await externe("Retour/Page.md", v3);
    const refuse = await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: "Retour/Page.md", etag: ap.json.actuel.etag, vu: ap.json.vu.etag }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(refuse.statut, 412);
    assert.equal(fs.readFileSync(disque("Retour/Page.md"), "utf8"), v3);
    assert.equal(lignesJournal(b.etat).filter((l) => l.chemin === "Retour/Page.md").length, 0);
    // sans identifiant de requête : refusé
    assert.equal((await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: "Retour/Page.md", etag: sha16(v3), vu: ap.json.vu.etag } })).statut, 400);
    // référence changée depuis l'aperçu : refusé
    const ref = await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: "Retour/Page.md", etag: sha16(v3), vu: sha16("autre") }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(ref.statut, 409);
    assert.equal(ref.json.vu, ap.json.vu.etag);
  });
  test("confirmation : nouvelle révision attribuée, version annulée conservée (instantané), rejeu sans doublon, page à jour", async () => {
    const v3 = fs.readFileSync(disque("Retour/Page.md"), "utf8");
    const ap = (await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Page.md"))).json;
    const r1 = rq();
    const corps = { chemin: "Retour/Page.md", etag: ap.actuel.etag, vu: ap.vu.etag };
    const r = await b.req("POST", "/api/nouveautes/retour", { corps, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(r.statut, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(disque("Retour/Page.md"), "utf8"), "# Page\n\nVersion vue.\n");
    assert.equal(r.json.etag, sha16("# Page\n\nVersion vue.\n"));
    assert.match(r.json.instantane, /^inst:\d{8}-\d{6}-\d{3}-retour$/);
    const v = await b.req("GET", `/api/version?chemin=${q("Retour/Page.md")}&id=${q(r.json.instantane)}`);
    assert.equal(v.json.contenu, v3, "la version annulée est conservée");
    const h = (await b.req("GET", "/api/historique?chemin=" + q("Retour/Page.md"))).json;
    assert.equal(h.versions.find((x: { id: string }) => x.id === r.json.instantane).genre, "avant-retour");
    const j = lignesJournal(b.etat).filter((l) => l.chemin === "Retour/Page.md");
    assert.equal(j.length, 1);
    assert.equal(j[0].action, "retour-vue");
    assert.equal(j[0].principal, LOGIN);
    assert.equal(j[0].avant, sha16(v3));
    assert.equal(j[0].requete, r1);
    const rejeu = await b.req("POST", "/api/nouveautes/retour", { corps, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(rejeu.statut, 200);
    assert.equal(rejeu.json.rejoue, true);
    assert.equal(rejeu.json.instantane, r.json.instantane);
    assert.equal(lignesJournal(b.etat).filter((l) => l.chemin === "Retour/Page.md").length, 1);
    assert.equal((await b.req("GET", "/api/nouveaute?chemin=" + q("Retour/Page.md"))).json.etat, "a-jour");
    assert.equal((await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Page.md"))).statut, 409);
  });
  test("modifications faites dans Carnet depuis : pas de retour en un clic, choix explicite exigé", async () => {
    const vue = "# Humaine\n\nVersion vue.\n";
    const humaine = "# Humaine\n\nVersion vue.\n\nAjout de Jade dans Carnet.\n";
    const w = await b.req("PUT", "/api/page?chemin=" + q("Retour/Humaine.md"), { corps: { contenu: humaine }, entetes: { "If-Match": sha16(vue), "X-Carnet-Requete": rq(), "Tailscale-User-Login": AUTRE } });
    assert.equal(w.statut, 200);
    await attendre(1100); // l'écriture de l'agent arrive une seconde plus tard
    await externe("Retour/Humaine.md", humaine + "Ligne de l'agent.\n");
    const ap = (await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Humaine.md"))).json;
    assert.equal(ap.humaines.length, 1);
    assert.equal(ap.humaines[0].principal, AUTRE);
    assert.equal(ap.humaines[0].action, "page");
    assert.equal(ap.externe, true);
    const corps = { chemin: "Retour/Humaine.md", etag: ap.actuel.etag, vu: ap.vu.etag };
    const refuse = await b.req("POST", "/api/nouveautes/retour", { corps, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(refuse.statut, 409);
    assert.equal(refuse.json.humaines.length, 1);
    assert.equal(fs.readFileSync(disque("Retour/Humaine.md"), "utf8"), humaine + "Ligne de l'agent.\n");
    const ok = await b.req("POST", "/api/nouveautes/retour", { corps: { ...corps, humaines: true }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(ok.statut, 200);
    assert.equal(fs.readFileSync(disque("Retour/Humaine.md"), "utf8"), vue);
  });
  test("page jamais vue ou chemin hors zone : refusé", async () => {
    await externe("Retour/Neuve.md", "# Neuve\n");
    assert.equal((await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Neuve.md"))).statut, 404);
    assert.ok([400, 403].includes((await b.req("GET", "/api/nouveautes/retour?chemin=" + q("../x.md"))).statut));
    assert.ok([403, 404].includes((await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Privé/Cachée.md"))).statut));
  });
});

describe("une ancienne attestation de décision ne redevient JAMAIS valide par une restauration", () => {
  const decider = async (rel: string, resultat: string) => {
    const v = (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
    const r = await b.req("POST", "/api/decision", { corps: { chemin: rel, resultat, empreinte: v.empreinte, demande: v.id }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 200, JSON.stringify(r.json));
  };
  const preuve = async (rel: string) => (await b.req("GET", "/api/page?chemin=" + q(rel))).json.preuveDecision;

  test("approuvée sur A → l'agent change en B → retour à la version vue (A) : preuve « remplacée », pas « valide »", async () => {
    await decider("Retour/Dec.md", "approuvée");
    const approuvee = fs.readFileSync(disque("Retour/Dec.md"), "utf8");
    assert.equal((await preuve("Retour/Dec.md")).etat, "valide");
    // La personne marque la version décidée comme vue (version présentée)
    const m = await b.req("POST", "/api/nouveautes/vu", { corps: { pages: [{ chemin: "Retour/Dec.md", etag: sha16(approuvee) }] } });
    assert.deepEqual(m.json.marquees, ["Retour/Dec.md"]);
    await attendre(1100);
    await externe("Retour/Dec.md", approuvee.replace("Périmètre : 5 pages", "Périmètre : 9 pages"));
    assert.equal((await preuve("Retour/Dec.md")).etat, "perimee");
    const ap = (await b.req("GET", "/api/nouveautes/retour?chemin=" + q("Retour/Dec.md"))).json;
    assert.deepEqual(ap.decision, { estDecision: true, attestationNeutralisee: true });
    assert.deepEqual(ap.humaines, []);
    const r = await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: "Retour/Dec.md", etag: ap.actuel.etag, vu: ap.vu.etag }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(disque("Retour/Dec.md"), "utf8"), approuvee, "le fichier est bien revenu à la version approuvée");
    const p = await preuve("Retour/Dec.md");
    assert.notEqual(p.etat, "valide");
    assert.equal(p.etat, "remplacee");
    assert.equal(p.resultat, "restauration");
    const d = (await b.req("GET", "/api/decision?chemin=" + q("Retour/Dec.md"))).json;
    assert.equal(d.enregistrements.length, 1);
    assert.equal(d.enregistrements[0].verification, "remplacee");
    assert.equal(d.decidable, false, "même proposition : une nouvelle proposition impose une nouvelle décision");
    const att = (await b.req("GET", "/api/attestations?chemin=" + q("Retour/Dec.md"))).json;
    assert.equal(att.journal.coupures, 0, "la barrière est chaînée : aucune coupure");
    const derniere = att.attestations[att.attestations.length - 1];
    assert.equal(derniere.resultat, "restauration");
    assert.match(derniere.portee, /^restauration-v1 action=retour-vue n-autorise-rien precedente=sha256:[0-9a-f]{64}$/);
    assert.equal((await b.req("GET", "/api/decisions?statut=" + q("approuvée"))).json.decisions.some((x: { chemin: string }) => x.chemin === "Retour/Dec.md"), false);
  });
  test("même chose par l'Historique (restaurer-version) : la preuve ne redevient pas valide", async () => {
    await decider("Retour/Dec2.md", "approuvée");
    const approuvee = fs.readFileSync(disque("Retour/Dec2.md"), "utf8");
    const inst = await b.req("POST", "/api/instantane", { corps: { chemin: "Retour/Dec2.md" } });
    assert.equal(inst.statut, 201);
    await externe("Retour/Dec2.md", approuvee.replace("Périmètre : 5 pages", "Périmètre : 7 pages"));
    const r = await b.req("POST", "/api/restaurer-version", { corps: { chemin: "Retour/Dec2.md", id: inst.json.id } });
    assert.equal(r.statut, 200, JSON.stringify(r.json));
    assert.equal(fs.readFileSync(disque("Retour/Dec2.md"), "utf8"), approuvee);
    const p = await preuve("Retour/Dec2.md");
    assert.equal(p.etat, "remplacee");
    const att = (await b.req("GET", "/api/attestations?chemin=" + q("Retour/Dec2.md"))).json;
    assert.equal(att.journal.coupures, 0);
    assert.match(att.attestations[att.attestations.length - 1].portee, /^restauration-v1 action=restauration /);
  });
  test("restauration d'une page sans attestation : aucune barrière inutile", async () => {
    const n = (await b.app.api.ecrivain.attestations.lister()).length;
    const inst = await b.req("POST", "/api/instantane", { corps: { chemin: "Fiab/Décision.md" } });
    await externe("Fiab/Décision.md", fs.readFileSync(disque("Fiab/Décision.md"), "utf8").replace("5 pages", "6 pages"));
    assert.equal((await b.req("POST", "/api/restaurer-version", { corps: { chemin: "Fiab/Décision.md", id: inst.json.id } })).statut, 200);
    assert.equal((await b.app.api.ecrivain.attestations.lister()).length, n);
  });
});

describe("restes du socle par la porte : dupliquer, restaurer depuis la corbeille", () => {
  test("dupliquer : la copie est créée par la porte (journal « dupliquer »), sous-pages copiées, original intact", async () => {
    await externe("Dup/Source.md", "# Source\n\nTexte.\n");
    await externe("Dup/Source/Enfant.md", "# Enfant\n");
    const r = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Dup/Source.md" } });
    assert.equal(r.statut, 201, r.texte);
    assert.equal(r.json.chemin, "Dup/Source (copie).md");
    assert.ok(fs.existsSync(disque("Dup/Source (copie)/Enfant.md")));
    const j = lignesJournal(b.etat).filter((l) => l.chemin === "Dup/Source (copie).md");
    assert.equal(j.length, 1);
    assert.equal(j[0].action, "dupliquer");
    assert.equal(j[0].avant, null);
    assert.equal(j[0].apres, sha16(fs.readFileSync(disque("Dup/Source (copie).md"))));
    assert.equal(fs.readFileSync(disque("Dup/Source.md"), "utf8"), "# Source\n\nTexte.\n");
    const r2 = await b.req("POST", "/api/dupliquer", { corps: { chemin: "Dup/Source.md" } });
    assert.equal(r2.json.chemin, "Dup/Source (copie 2).md");
  });
  test("restaurer depuis la corbeille : mouvement « restaurer » journalisé, renvoi idempotent", async () => {
    await externe("Dup/Jetée.md", "# Jetée\n");
    const s = await b.req("POST", "/api/supprimer", { corps: { chemin: "Dup/Jetée.md" } });
    assert.equal(s.statut, 200);
    const r1 = rq();
    const r = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s.json.id }, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(r.json, { chemin: "Dup/Jetée.md", renomme: false });
    assert.equal(fs.readFileSync(disque("Dup/Jetée.md"), "utf8"), "# Jetée\n");
    const j = lignesJournal(b.etat).filter((l) => l.action === "restaurer");
    assert.equal(j.length, 1);
    assert.equal(j[0].chemin, ".corbeille/" + s.json.id);
    assert.equal(j[0].vers, "Dup/Jetée.md");
    assert.equal(j[0].requete, r1);
    const encore = await b.req("POST", "/api/corbeille/restaurer", { corps: { id: s.json.id }, entetes: { "X-Carnet-Requete": r1 } });
    assert.equal(encore.statut, 200, "réponse perdue puis renvoi : même résultat, pas de 404");
    assert.equal(encore.json.chemin, "Dup/Jetée.md");
    assert.equal(lignesJournal(b.etat).filter((l) => l.action === "restaurer").length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Arrêt brutal pendant l'enregistrement (processus tué, CARNET_PANNE_ESSAI)
// ---------------------------------------------------------------------------------------------

describe("serveur tué pendant l'enregistrement", () => {
  let racine: string;
  let env: Record<string, string>;
  let espace: string;
  let etat: string;
  const page = "Panne/Note.md";
  const fichier = () => path.join(espace, page);

  before(async () => {
    const banc = await demarrerBanc();
    await banc.app.arreter(); // seul l'espace et l'état préparés servent ; les serveurs sont lancés ci-dessous
    racine = banc.racine;
    espace = banc.espace;
    etat = banc.etat;
    fs.mkdirSync(path.join(espace, "Panne"), { recursive: true });
    fs.writeFileSync(fichier(), "# Note\n\nV0 complète.\n");
    env = {
      CARNET_ESPACE: espace, CARNET_ETAT: etat, CARNET_PORT: "0", CARNET_HOTE: "127.0.0.1", CARNET_STATIQUE: path.join(racine, "dist"),
      CARNET_UTILISATEURS_AUTORISES: LOGIN, CARNET_ORIGINES_ARTEFACTS: `http://${HOTE}=http://art.test`, CARNET_MASQUES: "Privé bruts",
      CARNET_CLE: banc.cle, CARNET_REGROUPEMENT_MS: "60",
    };
  });
  after(async () => { await fsp.rm(racine, { recursive: true, force: true }); });

  /** Lance main.ts dans un processus à part, avec le point de panne ; renvoie son port et sa fin. */
  async function enfant(panne: string): Promise<{ port: number; fin: Promise<NodeJS.Signals | null>; sortie: () => string }> {
    const p = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH ?? "", HOME: racine, CARNET_JOURNAL: "1", ...env, CARNET_PANNE_ESSAI: panne }, stdio: ["ignore", "pipe", "pipe"] });
    let sortie = "";
    p.stdout.on("data", (m: Buffer) => { sortie += m.toString("utf8"); });
    p.stderr.on("data", (m: Buffer) => { sortie += m.toString("utf8"); });
    const fin = new Promise<NodeJS.Signals | null>((ok) => p.on("exit", (_c, s) => ok(s)));
    const limite = Date.now() + 15_000;
    while (!sortie.includes('"quoi":"demarrage"') && Date.now() < limite) await attendre(50);
    const l = sortie.split("\n").find((x) => x.includes('"quoi":"demarrage"'));
    assert.ok(l, `pas de démarrage : ${sortie}`);
    assert.match(sortie, /CARNET_PANNE_ESSAI/, "avertissement au démarrage");
    const port = Number(JSON.parse(l!).ecoute.split(":").pop());
    return { port, fin, sortie: () => sortie };
  }
  async function enProcessus(): Promise<{ app: Application; port: number }> {
    const app = await creerApplication(lireConfig(env), { surveiller: false });
    return { app, port: await app.demarrer() };
  }
  const ecrire = (port: number, contenu: string, etagBase: string, requeteId: string) =>
    requete(port, "PUT", "/api/page?chemin=" + q(page), { corps: { contenu }, entetes: { "If-Match": etagBase, "X-Carnet-Requete": requeteId } });

  test("tué entre le temporaire et le rename : ancienne version complète, reprise « abandonnée », renvoi = une écriture", async () => {
    const v0 = fs.readFileSync(fichier());
    const v1 = "# Note\n\nV1 : " + "texte long ".repeat(5000) + "\nfin.\n";
    const r1 = "panne-avant-" + rq();
    const e = await enfant("avant-rename:Panne/Note");
    await assert.rejects(ecrire(e.port, v1, sha16(v0), r1), "réponse jamais reçue (serveur tué)");
    assert.equal(await e.fin, "SIGKILL");
    assert.deepEqual(fs.readFileSync(fichier()), v0, "ancienne version complète, octet pour octet");
    assert.equal(lsTmp(path.dirname(fichier())).length, 1, "le temporaire caché reste après l'arrêt brutal");
    assert.ok(fs.existsSync(path.join(etat, "panne-essai-avant-rename.faite")));
    const s = await enProcessus();
    try {
      assert.equal(lsTmp(path.dirname(fichier())).length, 0, "temporaire orphelin retiré à la reprise");
      assert.equal(s.app.api.ecrivain.indeterminees.length, 0);
      // l'opération en attente côté client est renvoyée telle quelle : écrite une seule fois
      const r = await ecrire(s.port, v1, sha16(v0), r1);
      assert.equal(r.statut, 200, r.texte);
      assert.equal(r.json.rejoue, undefined);
      assert.equal(fs.readFileSync(fichier(), "utf8"), v1);
      const again = await ecrire(s.port, v1, sha16(v0), r1);
      assert.equal(again.json.rejoue, true);
    } finally {
      await s.app.arreter();
    }
    assert.equal(lignesJournal(etat).filter((l) => l.requete === r1).length, 1);
  });

  test("tué juste après le rename : nouvelle version complète, reprise « faite » (journal reprise: true), renvoi = rejoue", async () => {
    const v1 = fs.readFileSync(fichier(), "utf8");
    const v2 = "# Note\n\nV2 : " + "autre texte ".repeat(5000) + "\nfin.\n";
    const r2 = "panne-apres-" + rq();
    const e = await enfant("apres-rename:Panne/Note");
    await assert.rejects(ecrire(e.port, v2, sha16(v1), r2));
    assert.equal(await e.fin, "SIGKILL");
    assert.equal(fs.readFileSync(fichier(), "utf8"), v2, "nouvelle version complète");
    assert.equal(lignesJournal(etat).filter((l) => l.requete === r2).length, 0, "journal pas encore écrit au moment de l'arrêt");
    const s = await enProcessus();
    try {
      const j = lignesJournal(etat).filter((l) => l.requete === r2);
      assert.equal(j.length, 1);
      assert.equal(j[0].reprise, true);
      const r = await ecrire(s.port, v2, sha16(v1), r2);
      assert.equal(r.statut, 200);
      assert.equal(r.json.rejoue, true, "le résultat de l'écriture interrompue est retrouvé : pas de 412, pas de doublon");
      assert.equal(r.json.etag, sha16(v2));
    } finally {
      await s.app.arreter();
    }
    assert.equal(lignesJournal(etat).filter((l) => l.requete === r2).length, 1);
  });

  test("reprise d'une écriture dont le CONTENU a déjà été écrit plus tôt : journalisée quand même (renvoi retrouvé)", async () => {
    // Avant le lot 5, la reprise sautait l'entrée de journal dès qu'un contenu identique figurait au journal de ce chemin.
    const v2 = fs.readFileSync(fichier(), "utf8");
    const v1 = "# Note\n\nRetour à un texte court.\n";
    const s0 = await enProcessus();
    try {
      const r = await ecrire(s0.port, v1, sha16(v2), "retour-court-" + rq());
      assert.equal(r.statut, 200, r.texte);
    } finally {
      await s0.app.arreter();
    }
    fs.rmSync(path.join(etat, "panne-essai-apres-rename.faite"));
    const rB = "meme-contenu-" + rq();
    const e = await enfant("apres-rename:Panne/Note");
    await assert.rejects(ecrire(e.port, v2, sha16(v1), rB));
    assert.equal(await e.fin, "SIGKILL");
    assert.equal(fs.readFileSync(fichier(), "utf8"), v2);
    const s = await enProcessus();
    try {
      const j = lignesJournal(etat).filter((l) => l.requete === rB);
      assert.equal(j.length, 1, "écriture reprise journalisée, même si ce contenu avait déjà été écrit");
      assert.equal(j[0].reprise, true);
      const r = await ecrire(s.port, v2, sha16(v1), rB);
      assert.equal(r.json.rejoue, true);
    } finally {
      await s.app.arreter();
    }
  });

  test("modifiée ailleurs pendant l'arrêt : écriture « indéterminée » listée, gardée au redémarrage, retirée à la main", async () => {
    fs.rmSync(path.join(etat, "panne-essai-avant-rename.faite"));
    const v2 = fs.readFileSync(fichier(), "utf8");
    const e = await enfant("avant-rename:Panne/Note");
    await assert.rejects(ecrire(e.port, "# Note\n\nV3 jamais écrite.\n", sha16(v2), "panne-ind-" + rq()));
    assert.equal(await e.fin, "SIGKILL");
    const agent = "# Note\n\nVersion écrite par un agent pendant l'arrêt.\n";
    fs.writeFileSync(fichier(), agent);
    let s = await enProcessus();
    let id: string;
    try {
      const l = await requete(s.port, "GET", "/api/ecritures/indeterminees");
      assert.equal(l.statut, 200);
      assert.equal(l.json.elements.length, 1);
      const x = l.json.elements[0];
      id = x.id;
      assert.equal(x.chemin, page);
      assert.equal(x.action, "page");
      assert.equal(x.avant, sha16(v2));
      assert.equal(x.apres, sha16("# Note\n\nV3 jamais écrite.\n"));
      assert.equal(x.actuel, sha16(agent));
      assert.equal(x.existe, true);
      assert.equal(x.vers, null);
      assert.equal(fs.readFileSync(fichier(), "utf8"), agent, "jamais « réparée » : la version de l'agent reste");
      const f = path.join(etat, "journal", "espace", "indeterminees.json");
      assert.equal(fs.statSync(f).mode & 0o777, 0o600);
    } finally {
      await s.app.arreter();
    }
    s = await enProcessus();
    try {
      const l = await requete(s.port, "GET", "/api/ecritures/indeterminees");
      assert.equal(l.json.elements.length, 1, "toujours là après un redémarrage");
      assert.equal((await requete(s.port, "POST", "/api/ecritures/indeterminees/traiter", { corps: { id: "inconnue" } })).statut, 404);
      const t = await requete(s.port, "POST", "/api/ecritures/indeterminees/traiter", { corps: { id } });
      assert.equal(t.statut, 200);
      assert.equal(t.json.restantes, 0);
      assert.equal((await requete(s.port, "GET", "/api/ecritures/indeterminees")).json.elements.length, 0);
    } finally {
      await s.app.arreter();
    }
    s = await enProcessus();
    try {
      assert.equal((await requete(s.port, "GET", "/api/ecritures/indeterminees")).json.elements.length, 0);
    } finally {
      await s.app.arreter();
    }
  });

  test("CARNET_PANNE_ESSAI : forme stricte, inactif par défaut", () => {
    const av: string[] = [];
    assert.equal(lirePanneEssai(undefined, av), null);
    assert.equal(lirePanneEssai("", av), null);
    assert.deepEqual(lirePanneEssai("avant-rename:Démo/X", av), [{ point: "avant-rename", motif: "Démo/X" }]);
    assert.equal(av.length, 1);
    assert.deepEqual(lirePanneEssai("avant-rename:Fiabilité/Panne avant,apres-rename:Fiabilité/Panne après", av), [
      { point: "avant-rename", motif: "Fiabilité/Panne avant" }, { point: "apres-rename", motif: "Fiabilité/Panne après" },
    ]);
    assert.throws(() => lirePanneEssai("pendant:x", []), /CARNET_PANNE_ESSAI/);
    assert.throws(() => lirePanneEssai("avant-rename:", []), /CARNET_PANNE_ESSAI/);
    assert.equal(lireConfig(env).panneEssai, null);
  });
});
