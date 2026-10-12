// Carnet · tests du socle V3 : porte d'écriture (server/src/ecriture.ts), journal, idempotence, forçage, attestations,
// reprise après panne, routes V3 (/api/meta « proprietes », /api/tache échéance/priorité, /api/attestations).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { creerApplication } from "../src/app.ts";
import { lireConfig } from "../src/config.ts";
import { REVISION_EXISTANTE } from "../src/ecriture.ts";
import { dossierJournal } from "../src/journal-ecritures.ts";
import { ErreurHttp } from "../src/http.ts";
import { ErreurFormat } from "../../shared/proprietes.ts";
import { demarrerBanc, LOGIN, lsTmp, q, requete, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

const FIXTURES_V3 = path.resolve(import.meta.dirname, "fixtures/v3");

let b: Banc;
before(async () => {
  b = await demarrerBanc({
    preparer: async (_r, espace) => { await fsp.cp(FIXTURES_V3, path.join(espace, "Démo/V3"), { recursive: true }); },
  });
});
after(async () => { await b.fermer(); });

const lireDisque = (rel: string) => fs.readFileSync(path.join(b.espace, rel), "utf8");
const ecrireDisque = (rel: string, txt: string) => { fs.mkdirSync(path.dirname(path.join(b.espace, rel)), { recursive: true }); fs.writeFileSync(path.join(b.espace, rel), txt); };
const ecrivain = () => b.app.api.ecrivain;
const lignesJournal = (fichier = "ecritures.jsonl") => {
  const f = path.join(dossierJournal(b.app.cfg), fichier);
  return fs.existsSync(f) ? fs.readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
};
const uuid = () => crypto.randomUUID();

describe("porte d'écriture : révision, création, transformation", () => {
  test("révision discordante : 412 {etag, contenu} actuels, rien n'est écrit ni journalisé", async () => {
    const c = "Démo/V3/Frontmatter difficile.md";
    const avant = lireDisque(c);
    const n = lignesJournal().length;
    await assert.rejects(
      ecrivain().ecrire({ chemin: c.split("/"), revision: '"0000000000000000"', action: "meta", transformer: (x) => x + "\nX" }, LOGIN),
      (e: unknown) => e instanceof ErreurHttp && e.statut === 412 && e.raison === "etag_discordant" && e.extra?.contenu === avant && e.extra?.etag === sha16(avant),
    );
    assert.equal(lireDisque(c), avant);
    assert.equal(lignesJournal().length, n);
  });
  test("création concurrente : une seule réussit (412 existe pour l'autre) ; creerUnique donne deux fichiers distincts", async () => {
    const segs = ["Démo", "V3", "Concurrente.md"];
    const r = await Promise.allSettled([1, 2].map((i) => ecrivain().ecrire({ chemin: segs, revision: null, action: "creation", transformer: () => `# Version ${i}\n` }, LOGIN)));
    assert.equal(r.filter((x) => x.status === "fulfilled").length, 1);
    const ko = r.find((x) => x.status === "rejected") as PromiseRejectedResult;
    assert.ok(ko.reason instanceof ErreurHttp && ko.reason.statut === 412 && ko.reason.raison === "existe");
    const deux = await Promise.all([1, 2].map(() => ecrivain().creerUnique({ dossier: ["Démo", "V3"], base: "Capture du jour", action: "capture", transformer: () => "---\ntype: capture\n---\n" }, LOGIN)));
    assert.deepEqual(deux.map((x) => x.chemin).sort(), ["Démo/V3/Capture du jour (2).md", "Démo/V3/Capture du jour.md"]);
  });
  test("transformation qui échoue (ErreurFormat 422, ErreurHttp, exception) : rien n'est écrit, aucun temporaire", async () => {
    const c = "Démo/V3/Décision exemple.md";
    const avant = lireDisque(c);
    const etag = sha16(avant);
    await assert.rejects(ecrivain().ecrire({ chemin: c.split("/"), revision: etag, action: "meta", transformer: () => { throw new ErreurFormat("type invalide", "valeur_invalide"); } }, LOGIN),
      (e: unknown) => e instanceof ErreurHttp && e.statut === 422 && e.raison === "valeur_invalide");
    await assert.rejects(ecrivain().ecrire({ chemin: c.split("/"), revision: etag, action: "meta", transformer: () => { throw new ErreurHttp(409, "non", "non"); } }, LOGIN),
      (e: unknown) => e instanceof ErreurHttp && e.statut === 409);
    await assert.rejects(ecrivain().ecrire({ chemin: c.split("/"), revision: etag, action: "meta", transformer: () => { throw new Error("boum"); } }, LOGIN));
    assert.equal(lireDisque(c), avant);
    assert.deepEqual(lsTmp(path.join(b.espace, "Démo/V3")), []);
  });
  test("résultat identique : inchange, rien d'écrit ; révision « existante » : 404 si absente", async () => {
    const c = "Démo/V3/Décision exemple.md";
    const r = await ecrivain().ecrire({ chemin: c.split("/"), revision: REVISION_EXISTANTE, action: "meta", transformer: (x) => x! }, LOGIN);
    assert.equal(r.inchange, true);
    await assert.rejects(ecrivain().ecrire({ chemin: ["Démo", "V3", "Absente.md"], revision: REVISION_EXISTANTE, action: "meta", transformer: (x) => x! }, LOGIN),
      (e: unknown) => e instanceof ErreurHttp && e.statut === 404);
  });
});

describe("journal d'attribution", () => {
  test("principal = identité vérifiée, jamais le fichier ; maj_par = déclaration ; contenuDejaEcritParCarnet", async () => {
    const c = "Démo/V3/Frontmatter difficile.md";
    const r = await b.req("POST", "/api/meta", { corps: { chemin: c, proprietes: { statut: "fait" } }, entetes: { "Tailscale-User-Login": LOGIN } });
    assert.equal(r.statut, 200, r.texte);
    const e = lignesJournal().at(-1);
    assert.equal(e.principal, LOGIN);
    assert.equal(e.client, null);
    assert.equal(e.action, "meta");
    assert.equal(e.chemin, c);
    assert.equal(e.apres, r.json.etag);
    assert.equal(e.auteur_declare, "Lina"); // déclaration lue dans le fichier, distincte du principal
    assert.match(e.t, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    assert.equal(ecrivain().journal.contenuDejaEcritParCarnet(c, r.json.etag), true);
    assert.equal(ecrivain().journal.estEcritureCarnet(c, r.json.etag), true);
    // modification externe : pas un contenu écrit par Carnet
    ecrireDisque(c, lireDisque(c) + "\nAjout externe.\n");
    assert.equal(ecrivain().journal.contenuDejaEcritParCarnet(c, sha16(lireDisque(c))), false);
    assert.deepEqual(ecrivain().journal.dernieres(c, 1).map((x) => x.apres), [r.json.etag]);
    const st = fs.statSync(dossierJournal(b.app.cfg));
    assert.equal(st.mode & 0o777, 0o700);
    assert.ok(!dossierJournal(b.app.cfg).startsWith(b.espace));
  });
});

describe("idempotence (X-Carnet-Requete)", () => {
  test("double envoi : une seule écriture, un seul événement ; même identifiant, autre opération : 409", async () => {
    const c = "Démo/V3/Tâches datées.md";
    const ligne = lireDisque(c).split("\n").findIndex((l) => l.startsWith("- [ ] Ranger le bureau"));
    const id = uuid();
    const corps = { chemin: c, ligne, texte: "- [ ] Ranger le bureau", coche: true, faite: "2026-10-11" };
    const n = lignesJournal().length;
    const r1 = await b.req("POST", "/api/tache", { corps, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r1.statut, 200, r1.texte);
    assert.equal(r1.json.texte, "- [x] Ranger le bureau ✅ 2026-10-11");
    const r2 = await b.req("POST", "/api/tache", { corps, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r2.statut, 200, r2.texte);
    assert.equal(r2.json.rejoue, true);
    assert.equal(r2.json.etag, r1.json.etag);
    assert.equal(lignesJournal().length, n + 1);
    assert.equal((lireDisque(c).match(/Ranger le bureau ✅/g) ?? []).length, 1);
    const r3 = await b.req("POST", "/api/tache", { corps: { ...corps, faite: "2026-10-12" }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r3.statut, 409);
    assert.equal(r3.json.erreur && r3.statut, 409);
    const r4 = await b.req("POST", "/api/tache", { corps, entetes: { "X-Carnet-Requete": "court" } });
    assert.equal(r4.statut, 400);
  });
  test("capture réussie, réponse perdue, redémarrage du serveur, renvoi : pas de seconde capture", async () => {
    const id = uuid();
    const r1 = await b.req("POST", "/api/page", { corps: { parent: "Démo.md", titre: "Capture idempotente", contenu: "---\ntype: capture\n---\nTexte.\n" }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r1.statut, 201, r1.texte);
    // second serveur sur le même espace et le même état (redémarrage)
    const cfg = lireConfig({ ...process.env, CARNET_ESPACE: b.espace, CARNET_PORT: "0", CARNET_HOTE: "127.0.0.1", CARNET_STATIQUE: path.join(b.racine, "dist"), CARNET_UTILISATEURS_AUTORISES: LOGIN, CARNET_ORIGINES_ARTEFACTS: "http://carnet.test=http://art.test", CARNET_CLE: b.cle, CARNET_ETAT: b.etat });
    const app2 = await creerApplication(cfg, { surveiller: false });
    const port2 = await app2.demarrer();
    try {
      const r2 = await requete(port2, "POST", "/api/page", { corps: { parent: "Démo.md", titre: "Capture idempotente", contenu: "---\ntype: capture\n---\nTexte.\n" }, entetes: { "X-Carnet-Requete": id } });
      assert.equal(r2.statut, 201, r2.texte);
      assert.equal(r2.json.rejoue, true);
      assert.equal(r2.json.chemin, r1.json.chemin);
      assert.ok(!fs.existsSync(path.join(b.espace, "Démo/Capture idempotente 2.md")));
    } finally {
      await app2.arreter();
    }
  });
});

describe("« Garder la mienne » (ecraser)", () => {
  test("seulement avec l'etag reçu dans le 412 ; la version externe est d'abord mise en instantané « ecrasee »", async () => {
    const c = "Démo/V3/Base exemple.md";
    const v1 = lireDisque(c);
    ecrireDisque(c, v1 + "\nModification externe.\n");
    const externe = lireDisque(c);
    // l'interface envoie sa version avec l'ancien etag : conflit
    const r1 = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: v1 + "\nMa version.\n" }, entetes: { "If-Match": sha16(v1) } });
    assert.equal(r1.statut, 412);
    assert.equal(r1.json.contenu, externe);
    // « If-Match: * » n'écrase plus rien
    const etoile = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: "x" }, entetes: { "If-Match": "*" } });
    assert.equal(etoile.statut, 412);
    // écraser sans la bonne révision : refusé
    const faux = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: v1 + "\nMa version.\n", ecraser: true }, entetes: { "If-Match": sha16(v1) } });
    assert.equal(faux.statut, 412);
    const r2 = await b.req("PUT", "/api/page?chemin=" + q(c), { corps: { contenu: v1 + "\nMa version.\n", ecraser: true }, entetes: { "If-Match": r1.json.etag } });
    assert.equal(r2.statut, 200, r2.texte);
    assert.equal(lireDisque(c), v1 + "\nMa version.\n");
    const h = await b.req("GET", "/api/historique?chemin=" + q(c));
    const inst = h.json.versions.find((v: any) => v.source === "instantane" && v.ecrasee);
    assert.ok(inst, JSON.stringify(h.json));
    const v = await b.req("GET", `/api/version?chemin=${q(c)}&id=${encodeURIComponent(inst.id)}`);
    assert.equal(v.json.contenu, externe);
    // écraser est réservé à l'enregistrement d'une page
    await assert.rejects(ecrivain().ecrire({ chemin: c.split("/"), revision: sha16(lireDisque(c)), action: "meta", ecraser: true, transformer: (x) => x + "!" }, LOGIN),
      (e: unknown) => e instanceof ErreurHttp && e.raison === "ecraser_interdit");
  });
});

describe("attestations", () => {
  const empreinte = "sha256:" + "a".repeat(64);
  test("signée hors de l'espace, vérifiée ; falsification refusée ; chaîne par demande ; route de lecture", async () => {
    const c = "Démo/V3/Décision exemple.md";
    const avant = lireDisque(c);
    const r = await ecrivain().ecrire({
      chemin: c.split("/"), revision: sha16(avant), action: "decision", transformer: (x) => x!.replace("statut: en attente", "statut: approuvée"),
      attester: { demande: "dec-20261011-0800-x7k2", empreinte, resultat: "approuvée", portee: "proposition figée" },
    }, LOGIN);
    assert.ok(r.attestation);
    assert.equal(r.attestation!.principal, LOGIN);
    assert.equal(r.attestation!.geste, "identite-seule");
    const a = ecrivain().attestations;
    assert.ok(!a.fichier.startsWith(b.espace));
    assert.deepEqual(await a.verifier(c, "dec-20261011-0800-x7k2", empreinte), r.attestation);
    assert.equal(await a.verifier(c, "dec-20261011-0800-x7k2", "sha256:" + "b".repeat(64)), null);
    assert.equal((await a.etat("dec-20261011-0800-x7k2", empreinte, "approuvée")).etat, "valide");
    // un agent ajoute une ligne « approuvée » sans signature valide : ignorée
    const fausse = { ...r.attestation!, id: "att-faux", resultat: "approuvée", empreinte: "sha256:" + "c".repeat(64), sig: "0".repeat(64) };
    fs.appendFileSync(a.fichier, JSON.stringify(fausse) + "\n");
    assert.equal(await a.verifier(c, "dec-20261011-0800-x7k2", fausse.empreinte), null);
    // falsifier une ligne existante (résultat changé) : signature invalide
    assert.equal(a.estValide({ ...r.attestation!, resultat: "refusée" }), false);
    const l = await b.req("GET", "/api/attestations?chemin=" + q(c));
    assert.equal(l.statut, 200);
    assert.deepEqual(l.json.attestations.map((x: any) => [x.id, x.valide]), [[r.attestation!.id, true], ["att-faux", false]]);
    // refus ensuite : l'approbation est remplacée
    await ecrivain().ecrire({
      chemin: c.split("/"), revision: r.etag, action: "decision", transformer: (x) => x!.replace("statut: approuvée", "statut: refusée"),
      attester: { demande: "dec-20261011-0800-x7k2", empreinte, resultat: "refusée", portee: "proposition figée" },
    }, LOGIN);
    assert.equal((await a.etat("dec-20261011-0800-x7k2", empreinte, "approuvée")).etat, "remplacee");
    assert.equal((await a.etat("dec-20261011-0800-x7k2", "sha256:" + "d".repeat(64))).etat, "perimee");
    assert.equal((await a.etat("dec-inconnue", empreinte)).etat, "absente");
    const r403 = await b.req("GET", "/api/attestations?chemin=" + q(c), { entetes: { "Tailscale-User-Login": undefined } });
    assert.equal(r403.statut, 403);
    const hors = await b.req("GET", "/api/attestations?chemin=" + q("../etc/passwd.md"));
    assert.ok(hors.statut === 400 || hors.statut === 403);
  });
});

describe("reprise après panne (intentions)", () => {
  test("intention sans validation : complétée si etag = après, abandonnée si = avant, sinon indéterminée", async () => {
    const dossier = dossierJournal(b.app.cfg);
    const f = path.join(dossier, "intentions.jsonl");
    const mk = (chemin: string, avant: string | null, apres: string) => ({ type: "intention", id: uuid(), t: "2026-10-11T08:00:00+02:00", principal: LOGIN, action: "page", chemin, avant, apres, requete: null });
    ecrireDisque("Démo/V3/Reprise faite.md", "# Écrite avant la panne\n");
    ecrireDisque("Démo/V3/Reprise abandonnée.md", "# Ancienne\n");
    ecrireDisque("Démo/V3/Reprise inconnue.md", "# Autre chose\n");
    const i1 = mk("Démo/V3/Reprise faite.md", sha16("# Avant\n"), sha16("# Écrite avant la panne\n"));
    const i2 = mk("Démo/V3/Reprise abandonnée.md", sha16("# Ancienne\n"), sha16("# Nouvelle\n"));
    const i3 = mk("Démo/V3/Reprise inconnue.md", sha16("# A\n"), sha16("# B\n"));
    fs.appendFileSync(f, [i1, i2, i3].map((x) => JSON.stringify(x) + "\n").join(""));
    const bilan = await ecrivain().verrou.executer(() => ecrivain().reprendre());
    assert.deepEqual(bilan, { faites: 1, abandonnees: 1, indeterminees: 1 });
    assert.ok(lignesJournal().some((e) => e.chemin === "Démo/V3/Reprise faite.md" && e.reprise === true));
    assert.ok(ecrivain().indeterminees.some((x) => x.chemin === "Démo/V3/Reprise inconnue.md"));
    assert.equal(fs.readFileSync(f, "utf8"), ""); // plus rien en attente : fichier vidé
  });
});

describe("routes V3", () => {
  test("/api/meta « proprietes » typées : null écrit null, liste, type date validé (422), YAML refusé (422)", async () => {
    const c = "Démo/V3/Base exemple/Entrée complète.md";
    const r = await b.req("POST", "/api/meta", { corps: { chemin: c, proprietes: { montant: 0, fait: true, statut: null, tags: ["a"] }, retirer: ["priorite"] } });
    assert.equal(r.statut, 200, r.texte);
    const t = lireDisque(c);
    assert.match(t, /^montant: 0$/m);
    assert.match(t, /^fait: true$/m);
    assert.match(t, /^statut: null$/m);
    assert.match(t, /^tags:\n {2}- a\n---/m);
    assert.ok(!/^priorite:/m.test(t));
    const d = await b.req("POST", "/api/meta", { corps: { chemin: c, proprietes: { echeance: "2026-13-01" }, types: { echeance: "date" } } });
    assert.equal(d.statut, 422);
    ecrireDisque("Démo/V3/Ancre.md", "---\na: &x 1\nb: *x\n---\n# Ancre\n");
    const y = await b.req("POST", "/api/meta", { corps: { chemin: "Démo/V3/Ancre.md", champs: { c: "x" } } });
    assert.equal(y.statut, 422);
    assert.equal(lireDisque("Démo/V3/Ancre.md"), "---\na: &x 1\nb: *x\n---\n# Ancre\n");
  });
  test("/api/tache : échéance, priorité, faite = aujourd'hui (fuseau du serveur) ; refus ciblé 422", async () => {
    const c = "Démo/V3/Tâches datées.md";
    const lignes = lireDisque(c).split("\n");
    const i = lignes.findIndex((l) => l.startsWith("- [ ] Relire le devis"));
    const r = await b.req("POST", "/api/tache", { corps: { chemin: c, ligne: i, texte: lignes[i], echeance: "2026-10-16", priorite: "haute" } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.texte, "- [ ] Relire le devis 📅 2026-10-16 ⏫");
    const r2 = await b.req("POST", "/api/tache", { corps: { chemin: c, ligne: i, texte: r.json.texte, coche: true, faite: true } });
    assert.match(r2.json.texte, /^- \[x\] Relire le devis 📅 2026-10-16 ⏫ ✅ \d{4}-\d{2}-\d{2}$/);
    const j = lignes.findIndex((l) => l.startsWith("- [/] Appeler"));
    const r3 = await b.req("POST", "/api/tache", { corps: { chemin: c, ligne: j, texte: lignes[j], echeance: "2026-10-20" } });
    assert.equal(r3.statut, 422);
    const autres = lireDisque(c).split("\n");
    assert.deepEqual(autres.map((l, k) => (l === lignes[k] ? null : k)).filter((x) => x !== null), [i]);
  });
});

describe("renommer, déplacer, supprimer par la porte", () => {
  test("journalisés avec `vers` ; révision de la source vérifiée ; liens réécrits par la porte ; suppression rejouée sans effet", async () => {
    ecrireDisque("Démo/V3/Mobile/Source.md", "# Source\n\nTexte.\n");
    ecrireDisque("Démo/V3/Mobile/Lien.md", "# Lien\n\nVoir [[Démo/V3/Mobile/Source]].\n");
    await b.app.espace.traiter(["Démo/V3/Mobile"]);
    const faux = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/V3/Mobile/Source.md", nom: "Renommée" }, entetes: { "If-Match": '"0000000000000000"' } });
    assert.equal(faux.statut, 412);
    assert.ok(fs.existsSync(path.join(b.espace, "Démo/V3/Mobile/Source.md")));
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Démo/V3/Mobile/Source.md", nom: "Renommée" }, entetes: { "If-Match": sha16("# Source\n\nTexte.\n") } });
    assert.equal(r.statut, 200, r.texte);
    const j = lignesJournal();
    const ren = j.find((e) => e.action === "renommer" && e.chemin === "Démo/V3/Mobile/Source.md");
    assert.equal(ren.vers, "Démo/V3/Mobile/Renommée.md");
    assert.equal(ren.avant, ren.apres);
    assert.ok(j.some((e) => e.action === "liens" && e.chemin === "Démo/V3/Mobile/Lien.md"));
    assert.equal(lireDisque("Démo/V3/Mobile/Lien.md"), "# Lien\n\nVoir [[Démo/V3/Mobile/Renommée]].\n");
    assert.equal(ecrivain().journal.contenuDejaEcritParCarnet("Démo/V3/Mobile/Renommée.md", ren.apres), true);
    const d = await b.req("POST", "/api/deplacer", { corps: { chemin: "Démo/V3/Mobile/Renommée.md", parent: "Démo/V3/Base exemple.md" } });
    assert.equal(d.statut, 200, d.texte);
    assert.ok(lignesJournal().some((e) => e.action === "deplacer" && e.vers === "Démo/V3/Base exemple/Renommée.md"));
    const id = uuid();
    const s1 = await b.req("POST", "/api/supprimer", { corps: { chemin: "Démo/V3/Base exemple/Renommée.md" }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(s1.statut, 200, s1.texte);
    const s2 = await b.req("POST", "/api/supprimer", { corps: { chemin: "Démo/V3/Base exemple/Renommée.md" }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(s2.statut, 200, s2.texte);
    assert.deepEqual(s2.json, { ...s1.json, rejoue: true });
    const sup = lignesJournal().filter((e) => e.action === "supprimer" && e.chemin === "Démo/V3/Base exemple/Renommée.md");
    assert.equal(sup.length, 1);
    assert.equal(sup[0].apres, null);
    assert.match(sup[0].vers, /^\.corbeille\//);
  });
  test("reprise d'un mouvement interrompu : fait si la destination seule existe, abandonné si la source est restée", async () => {
    const f = path.join(dossierJournal(b.app.cfg), "intentions.jsonl");
    ecrireDisque("Démo/V3/Mobile/Arrivée.md", "# Arrivée\n");
    ecrireDisque("Démo/V3/Mobile/Restée.md", "# Restée\n");
    const mk = (chemin: string, vers: string) => ({ type: "intention", id: uuid(), t: "2026-10-11T08:00:00+02:00", principal: LOGIN, action: "deplacer", chemin, vers, avant: null, apres: null, requete: null, mouvement: true });
    fs.appendFileSync(f, [mk("Démo/V3/Mobile/Partie.md", "Démo/V3/Mobile/Arrivée.md"), mk("Démo/V3/Mobile/Restée.md", "Démo/V3/Mobile/Ailleurs.md")].map((x) => JSON.stringify(x) + "\n").join(""));
    const bilan = await ecrivain().verrou.executer(() => ecrivain().reprendre());
    assert.deepEqual(bilan, { faites: 1, abandonnees: 1, indeterminees: 0 });
  });
});

describe("preuveDecision", () => {
  test("absente → valide → périmée après modification externe de la proposition ; statut déclaré ≠ résultat attesté", async () => {
    const { elementsDecision } = await import("../src/decisions.ts");
    const c = "Démo/V3/Décision preuve.md";
    const base = fs.readFileSync(path.join(FIXTURES_V3, "Décision exemple.md"), "utf8").replace("dec-20261011-0800-x7k2", "dec-20261011-0900-p8q3");
    ecrireDisque(c, base);
    const p0 = await b.req("GET", "/api/page?chemin=" + q(c));
    assert.equal(p0.json.preuveDecision.etat, "absente");
    assert.equal(p0.json.preuveDecision.demande, "dec-20261011-0900-p8q3");
    assert.match(p0.json.preuveDecision.empreinte, /^sha256:[0-9a-f]{64}$/);
    assert.equal(p0.json.contenu, base); // la preuve est HORS du contenu
    const e = elementsDecision(base);
    // un agent écrit « approuvée » dans le fichier : toujours aucune preuve
    ecrireDisque(c, base.replace("statut: en attente", "statut: approuvée"));
    assert.equal((await b.req("GET", "/api/page?chemin=" + q(c))).json.preuveDecision.etat, "absente");
    const avant = lireDisque(c);
    await ecrivain().ecrire({
      chemin: c.split("/"), revision: sha16(avant), action: "decision", transformer: (x) => x + "\n## Décision\n\n- Résultat : approuvée\n",
      attester: { demande: e.demande!, empreinte: e.empreinte!, resultat: "approuvée", portee: "proposition figée" },
    }, LOGIN);
    const p1 = (await b.req("GET", "/api/page?chemin=" + q(c))).json.preuveDecision;
    assert.equal(p1.etat, "valide");
    assert.equal(p1.resultat, "approuvée");
    assert.equal(p1.geste, "identite-seule");
    assert.equal(p1.declarationConforme, true);
    // le lot 3 remplace la méthode par défaut (definirCalculDecision : « carnet-proposition-v1 », propriétés engageantes comprises)
    assert.equal(p1.methode, elementsDecision(base).methode);
    assert.ok(["socle-v1", "carnet-proposition-v1"].includes(p1.methode));
    // la section « Décision » ajoutée ne change pas l'empreinte de la proposition
    assert.equal(p1.empreinte, e.empreinte);
    // modification externe d'un montant de la proposition : périmée
    ecrireDisque(c, lireDisque(c).replace("120 € TTC", "1 200 € TTC"));
    assert.equal((await b.req("GET", "/api/page?chemin=" + q(c))).json.preuveDecision.etat, "perimee");
    // page ordinaire : pas de preuveDecision
    assert.equal((await b.req("GET", "/api/page?chemin=" + q("Démo/V3/Tâches datées.md"))).json.preuveDecision, undefined);
  });
});

describe("rotation du journal", () => {
  test("au-delà du seuil : archive, puis fichier neuf ; l'index mémoire garde les dernières écritures", async () => {
    const { JournalEcritures } = await import("../src/journal-ecritures.ts");
    const dossier = path.join(b.racine, "journal-rotation");
    const j = new JournalEcritures(dossier, 400);
    for (let k = 0; k < 6; k++) {
      await j.ajouter({ t: "2026-10-11T08:00:00+02:00", principal: LOGIN, client: null, action: "page", chemin: "a.md", avant: null, apres: `"${String(k).padStart(16, "0")}"`, requete: null });
    }
    const archives = fs.readdirSync(dossier).filter((n) => n.startsWith("ecritures-"));
    assert.ok(archives.length >= 1, fs.readdirSync(dossier).join(","));
    assert.ok(fs.statSync(path.join(dossier, "ecritures.jsonl")).size < 400 + 300);
    const total = fs.readdirSync(dossier).filter((n) => n.endsWith(".jsonl")).reduce((s, n) => s + fs.readFileSync(path.join(dossier, n), "utf8").split("\n").filter(Boolean).length, 0);
    assert.equal(total, 6);
    const j2 = new JournalEcritures(dossier, 400);
    await j2.charger();
    assert.equal(j2.contenuDejaEcritParCarnet("a.md", `"${"5".padStart(16, "0")}"`), true);
  });
});
