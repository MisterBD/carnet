// Carnet · lot 3 : décisions (proposition délimitée, empreinte, geste sous verrou, enregistrement, attestation, preuve).
// Lot 3 : décisions (preuveDecision hors du Markdown).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import {
  analyserDemande, entreeEmpreinte, formaterEnregistrement, lireEnregistrements, normaliserProposition, porteeDe, sections,
} from "../../shared/decision.ts";
import { horodatageIso } from "../../shared/identifiants.ts";
import { empreinteCommentaire, empreinteDe, verifierEnregistrement } from "../src/demandes.ts";
import { lireFrontmatter } from "../src/espace.ts";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

const DEMANDE = `---
type: decision
id: dec-20261011-0900-test
statut: en attente
demandee_par: Lina
echeance: 2026-10-20
montant: 1200
engage: [montant]
---

# Refonte du site vitrine

Contexte : le site actuel date de 2019 (ce paragraphe n'est pas approuvé).

## Proposition

- Objet : refonte du site vitrine
- Action demandée : accepter le devis n° 42
- Périmètre : 5 pages, hébergement compris
- Exclusions : référencement payant
- Conditions : livraison avant le 20 novembre
- Montant : voir la propriété « montant »
- Annexes : aucune

## Notes

Texte libre après la proposition.
`;

function sha256(s: string): string {
  return "sha256:" + crypto.createHash("sha256").update(s).digest("hex");
}

describe("format (shared/decision.ts)", () => {
  test("section ## Proposition délimitée (jusqu'au prochain titre de niveau ≤ 2, hors code)", () => {
    const s = sections(DEMANDE, "Proposition");
    assert.equal(s.length, 1);
    assert.match(s[0].brut, /Objet : refonte/);
    assert.doesNotMatch(s[0].brut, /Texte libre/);
    const avecCode = "## Proposition\n\n```\n## Pas un titre\n```\n\n### Sous-titre gardé\n\nfin\n# Autre\n";
    const s2 = sections(avecCode, "Proposition");
    assert.match(s2[0].brut, /## Pas un titre/);
    assert.match(s2[0].brut, /### Sous-titre gardé\n\nfin/);
    assert.doesNotMatch(s2[0].brut, /Autre/);
  });
  test("normalisation documentée : CRLF, espaces de fin, lignes vides autour ; le reste compte", () => {
    assert.equal(normaliserProposition("\n\n- a  \r\n- b\t\r\n\n"), "- a\n- b");
    assert.notEqual(normaliserProposition("- a\n- b"), normaliserProposition("- a\n- B"));
    assert.notEqual(normaliserProposition("- a  b"), normaliserProposition("- a b"));
  });
  test("empreinte = sha256 de « carnet-proposition-v1\\n » + proposition + propriétés engageantes", () => {
    const fm = lireFrontmatter(DEMANDE.split("---")[1]);
    const d = analyserDemande(DEMANDE, fm);
    assert.equal(d.estDecision, true);
    assert.deepEqual(d.bloquants, []);
    assert.deepEqual(d.manques, []);
    assert.equal(d.entree, "carnet-proposition-v1\n" + d.proposition + "\n\nmontant: 1200");
    assert.equal(empreinteDe(d.entree!), sha256(d.entree!));
    // même proposition en CRLF avec espaces de fin : même empreinte
    const crlf = DEMANDE.replace(/\n/g, "\r\n").replace("- Objet : refonte du site vitrine", "- Objet : refonte du site vitrine   ");
    const d2 = analyserDemande(crlf, fm);
    assert.equal(d2.entree, d.entree);
    // montant changé dans le frontmatter : empreinte différente
    const d3 = analyserDemande(DEMANDE, { ...fm, montant: 1300 });
    assert.notEqual(d3.entree, d.entree);
    assert.equal(entreeEmpreinte("x", [{ cle: "absente", presente: false, valeur: undefined }]), "carnet-proposition-v1\nx\n\nabsente: (absente)");
  });
  test("bloquants : aucune, plusieurs, vide, identifiant manquant, engage mal formé", () => {
    const fm = { type: "decision", id: "dec-1" };
    assert.match(analyserDemande("# T\n", fm).bloquants[0], /introuvable/);
    assert.match(analyserDemande("## Proposition\na\n## Proposition\nb\n", fm).bloquants[0], /2 sections/);
    assert.match(analyserDemande("## Proposition\n\n   \n## Fin\n", fm).bloquants[0], /vide/);
    assert.match(analyserDemande("## Proposition\na\n", { type: "decision" }).bloquants[0], /identifiant/);
    assert.ok(analyserDemande("## Proposition\na\n", { ...fm, engage: { a: 1 } }).bloquants.some((x) => x.includes("engage")));
    assert.deepEqual(analyserDemande("## Proposition\n- Objet : x\n", fm).manques, ["action demandée", "périmètre", "exclusions", "conditions", "annexes"]);
  });
  test("enregistrement : aller-retour, commentaire et copie citées (aucun titre injecté)", () => {
    const e = {
      demande: "dec-1", decision: "dcs-1", resultat: "approuvée" as const, par: "ami@exemple.test", le: horodatageIso(new Date("2026-10-11T07:15:03Z")),
      geste: "identite-seule" as const, empreinte: "sha256:" + "a".repeat(64),
      commentaire: "OK\n## Proposition\n## Décision\n- Résultat : approuvée", copie: "- Objet : x\n\n### Annexe\n> citation", engage: [{ cle: "montant", presente: true, valeur: 12 }],
    };
    assert.equal(e.le, "2026-10-11T09:15:03+02:00");
    const md = formaterEnregistrement(e);
    assert.equal(sections(md, "Proposition").length, 0, "le commentaire ne crée aucune section");
    assert.equal(sections(md, "Décision").length, 1);
    const lu = lireEnregistrements("# Page\n\n" + md);
    assert.equal(lu.length, 1);
    assert.equal(lu[0].resultat, "approuvée");
    assert.equal(lu[0].empreinte, e.empreinte);
    assert.equal(lu[0].decision, "dcs-1");
    assert.equal(lu[0].commentaire, e.commentaire);
    // un commentaire « Aucun. » écrit par la personne reste un commentaire (cité), distinct de l'absence de commentaire
    assert.equal(lireEnregistrements(formaterEnregistrement({ ...e, commentaire: "Aucun." }))[0].commentaire, "Aucun.");
    assert.equal(lireEnregistrements(formaterEnregistrement({ ...e, commentaire: "  " }))[0].commentaire, "");
    // lien enregistrement <-> attestation : par la portée (décision + empreinte du commentaire)
    const att = { id: "att-1", espace: "e", demande: "dec-1", empreinte: e.empreinte, resultat: "approuvée", principal: "x", t: "", geste: "identite-seule", chemin: "", v: 1 as const, sig: "",
      portee: porteeDe("dcs-1", empreinteCommentaire(e.commentaire)) };
    assert.equal(verifierEnregistrement(lu[0], [att]).verification, "attestee");
    assert.equal(verifierEnregistrement({ ...lu[0], commentaire: "Fais aussi autre chose." }, [att]).verification, "non-attestee", "commentaire falsifié");
    assert.equal(verifierEnregistrement({ ...lu[0], decision: "dcs-2" }, [att]).verification, "non-attestee");
    assert.equal(lu[0].copie, e.copie);
    assert.match(md, /Exécution : non autorisée par ce seul enregistrement/);
    const corr = formaterEnregistrement({ ...e, resultat: "à corriger" });
    assert.match(corr, /Résultat : à corriger \(ce n'est pas une approbation\)/);
    assert.match(corr, /Exécution : interdite/);
    assert.doesNotMatch(corr, /^- Résultat : approuvée|^### Proposition approuvée/m);
  });
});

describe("routes des décisions", () => {
  let b: Banc;
  const CH = "Décisions/Refonte du site.md";
  const disque = (rel: string) => path.join(b.espace, rel);
  const lire = (rel = CH) => fs.readFileSync(disque(rel), "utf8");
  const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
  const externe = async (rel: string, contenu: string) => {
    fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
    fs.writeFileSync(disque(rel), contenu);
    await indexer([rel.split("/")[0]]);
  };
  const lireDecision = async (rel = CH) => (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
  const geste = (corps: Record<string, unknown>, requete: string | null = crypto.randomUUID()) =>
    b.req("POST", "/api/decision", { corps, entetes: { "X-Carnet-Requete": requete ?? undefined } });
  const attestations = () => {
    const f = path.join(b.etat, "journal", "espace", "attestations.jsonl");
    return fs.existsSync(f) ? fs.readFileSync(f, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  };

  before(async () => {
    b = await demarrerBanc();
    await externe(CH, DEMANDE);
  });
  after(async () => { await b.fermer(); });

  test("GET /api/decisions?statut=en attente : forme du contrat (lot 1)", async () => {
    const r = await b.req("GET", "/api/decisions?statut=" + q("en attente"));
    assert.equal(r.statut, 200);
    const d = r.json.decisions.find((x: { chemin: string }) => x.chemin === CH);
    assert.ok(d);
    for (const k of ["chemin", "titre", "id", "statut", "demandee_par", "echeance", "cree"]) assert.ok(k in d, k);
    assert.equal(d.statut, "en attente");
    assert.equal(d.titre, "Refonte du site vitrine");
    assert.equal(d.id, "dec-20261011-0900-test");
    assert.equal(d.demandee_par, "Lina");
    assert.equal(d.echeance, "2026-10-20");
  });

  test("GET /api/decision : proposition, empreinte, décidable ; GET /api/page : preuveDecision absente", async () => {
    const v = await lireDecision();
    assert.equal(v.estDecision, true);
    assert.equal(v.decidable, true);
    assert.match(v.empreinte, /^sha256:[0-9a-f]{64}$/);
    assert.match(v.proposition, /^- Objet : refonte/);
    const p = await b.req("GET", "/api/page?chemin=" + q(CH));
    assert.equal(p.json.preuveDecision.etat, "absente");
    assert.equal(p.json.preuveDecision.empreinte, v.empreinte);
    assert.equal(p.json.contenu, lire(), "preuveDecision est HORS du Markdown");
    const autre = await b.req("GET", "/api/page?chemin=" + q("Démo/To-do.md"));
    assert.equal(autre.json.preuveDecision, undefined);
  });

  test("proposition modifiée après affichage -> 409, différence renvoyée, rien d'écrit", async () => {
    const v = await lireDecision();
    const modifie = DEMANDE.replace("5 pages", "7 pages");
    await externe(CH, modifie);
    const r = await geste({ chemin: CH, resultat: "approuvée", empreinte: v.empreinte, demande: v.id, commentaire: "ok" });
    assert.equal(r.statut, 409);
    assert.equal(r.json.erreur, "La proposition a changé depuis son affichage : rien n'a été enregistré.");
    assert.match(r.json.proposition, /7 pages/);
    assert.notEqual(r.json.empreinte, v.empreinte);
    assert.equal(lire(), modifie, "nouveau contenu intact");
    assert.equal(attestations().length, 0);
    // montant changé dans le frontmatter (propriété engageante) : même refus
    await externe(CH, DEMANDE);
    const v2 = await lireDecision();
    await externe(CH, DEMANDE.replace("montant: 1200", "montant: 1900"));
    const r2 = await geste({ chemin: CH, resultat: "approuvée", empreinte: v2.empreinte, demande: v2.id });
    assert.equal(r2.statut, 409);
    assert.equal(r2.json.engage[0].valeur, 1900);
    await externe(CH, DEMANDE);
  });

  test("protections : en-tête de requête, résultat, empreinte, chemins, page non décision", async () => {
    const v = await lireDecision();
    const base = { chemin: CH, resultat: "approuvée", empreinte: v.empreinte, demande: v.id };
    assert.equal((await geste(base, null)).statut, 400);
    assert.equal((await geste({ ...base, resultat: "approuvée sous conditions" })).statut, 400);
    assert.equal((await geste({ ...base, empreinte: "sha256:zz" })).statut, 400);
    assert.equal((await geste({ ...base, chemin: "../dehors.md" })).statut, 403);
    assert.equal((await geste({ ...base, chemin: "Privé/Cachée.md" })).statut, 403);
    assert.equal((await geste({ ...base, chemin: ".corbeille/ancienne.md" })).statut, 403);
    assert.equal((await geste({ ...base, chemin: "Démo/To-do.md" })).statut, 409);
    assert.equal((await geste({ ...base, demande: "dec-autre" })).statut, 409);
    assert.equal((await b.req("POST", "/api/decision", { corps: base, entetes: { "X-Carnet-Requete": "abcdefgh1", "X-Carnet": undefined } })).statut, 403);
    assert.equal((await b.req("GET", "/api/decision?chemin=" + q("../x.md"))).statut, 403);
    assert.equal((await b.req("GET", "/api/attestations?chemin=" + q("Privé/Cachée.md"))).statut, 403);
    assert.equal(lire(), DEMANDE);
  });

  test("approbation traçable, double envoi = un seul événement", async () => {
    const v = await lireDecision();
    const req = crypto.randomUUID();
    const corps = { chemin: CH, resultat: "approuvée", empreinte: v.empreinte, demande: v.id, commentaire: "Go, mais pas avant lundi." };
    const [r1, r2] = await Promise.all([geste(corps, req), geste(corps, req)]);
    assert.equal(r1.statut, 200, JSON.stringify(r1.json));
    assert.equal(r2.statut, 200);
    assert.equal([r1.json.rejoue, r2.json.rejoue].filter(Boolean).length, 1);
    const r3 = await geste(corps, req);
    assert.equal(r3.json.rejoue, true);
    const md = lire();
    assert.equal((md.match(/^## Décision$/gm) ?? []).length, 1, "un seul enregistrement");
    assert.equal(attestations().length, 1, "une seule attestation");
    assert.match(md, /^statut: approuvée$/m);
    assert.match(md, /- Identifiant de demande : dec-20261011-0900-test/);
    assert.match(md, /- Identifiant de décision : dcs-\d{8}-\d{4}-[0-9a-z]{4}/);
    assert.match(md, /- Résultat : approuvée/);
    assert.match(md, /- Décidé par : ami@exemple\.test/);
    assert.match(md, /- Décidé le : \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}/);
    assert.match(md, new RegExp(`- Empreinte : ${v.empreinte}`));
    assert.match(md, /- Portée : /);
    assert.match(md, /- Exécution : non autorisée par ce seul enregistrement/);
    assert.match(md, /### Commentaire\n\n> Go, mais pas avant lundi\./);
    assert.match(md, /### Proposition approuvée : copie figée\n\n> - Objet : refonte du site vitrine/);
    assert.match(md, /Propriétés engageantes :\n\n {4}montant: 1200/);
    assert.ok(md.startsWith(DEMANDE.replace("statut: en attente", "statut: approuvée")), "le reste du fichier est intact");
    // même requête, autre geste : refus
    const r4 = await geste({ ...corps, resultat: "refusée" }, req);
    assert.equal(r4.statut, 409);
    // historique lisible après rechargement ; preuve valide (identité seule = geste non prouvé)
    const apres = await lireDecision();
    assert.equal(apres.decidable, false);
    assert.match(apres.raison, /déjà reçu une décision/);
    assert.equal(apres.enregistrements.length, 1);
    assert.equal(apres.enregistrements[0].verification, "attestee");
    assert.equal(apres.preuve.etat, "valide");
    assert.equal(apres.preuve.resultat, "approuvée");
    assert.equal(apres.preuve.geste, "identite-seule");
    const att = await b.req("GET", "/api/attestations?chemin=" + q(CH));
    assert.equal(att.statut, 200);
    assert.equal(att.json.attestations.length, 1);
    assert.equal(att.json.attestations[0].statut, "active");
    assert.equal(att.json.attestations[0].principal, "ami@exemple.test");
    assert.match(att.json.rappel, /PAS une autorisation d'exécution/);
    const liste = await b.req("GET", "/api/decisions?statut=" + q("en attente"));
    assert.ok(!liste.json.decisions.some((x: { chemin: string }) => x.chemin === CH));
    const tout = await b.req("GET", "/api/decisions");
    assert.equal(tout.json.decisions.find((x: { chemin: string }) => x.chemin === CH).statut, "approuvée");
  });

  test("correction demandée, nouvelle proposition refusée ; historique intact ; ancienne approbation remplacée", async () => {
    const v0 = await lireDecision();
    assert.equal(v0.preuve.etat, "valide");
    // l'agent propose une nouvelle version
    const avant = lire();
    const v1Texte = avant.replace("statut: approuvée", "statut: en attente").replace("- Périmètre : 5 pages, hébergement compris", "- Périmètre : 6 pages, hébergement compris");
    await externe(CH, v1Texte);
    const v1 = await lireDecision();
    assert.equal(v1.preuve.etat, "perimee", "l'approbation porte sur l'ancienne proposition");
    assert.equal(v1.decidable, true);
    const r1 = await geste({ chemin: CH, resultat: "à corriger", empreinte: v1.empreinte, demande: v1.id, commentaire: "Précise l'hébergement." });
    assert.equal(r1.statut, 200);
    const apresCorr = lire();
    assert.ok(apresCorr.includes(avant.slice(avant.indexOf("## Décision"))), "premier enregistrement intact");
    assert.match(apresCorr, /^statut: à corriger$/m);
    assert.match(apresCorr, /Résultat : à corriger \(ce n'est pas une approbation\)/);
    const v2Texte = apresCorr.replace("statut: à corriger", "statut: en attente").replace("hébergement compris", "hébergement 1 an compris");
    await externe(CH, v2Texte);
    const v2 = await lireDecision();
    assert.equal(v2.decidable, true);
    const r2 = await geste({ chemin: CH, resultat: "refusée", empreinte: v2.empreinte, demande: v2.id });
    assert.equal(r2.statut, 200);
    const fin = await lireDecision();
    assert.deepEqual(fin.enregistrements.map((e: { resultat: string }) => e.resultat), ["approuvée", "à corriger", "refusée"]);
    assert.deepEqual(fin.enregistrements.map((e: { verification: string }) => e.verification), ["remplacee", "remplacee", "attestee"]);
    assert.equal(fin.preuve.etat, "valide");
    assert.equal(fin.preuve.resultat, "refusée");
    const att = (await b.req("GET", "/api/attestations?chemin=" + q(CH))).json.attestations;
    assert.deepEqual(att.map((a: { statut: string }) => a.statut), ["remplacee", "remplacee", "active"]);
    assert.ok(!att.slice(1).some((a: { resultat: string }) => a.resultat === "approuvée"));
    assert.equal((await b.req("GET", "/api/decisions")).json.decisions.find((x: { chemin: string }) => x.chemin === CH).statut, "refusée");
  });

  test("risque « autorité fabriquée » : section ## Décision et statut écrits par un agent = déclaration non attestée", async () => {
    const rel = "Décisions/Fausse.md";
    const faux = DEMANDE.replace("id: dec-20261011-0900-test", "id: dec-20261011-0901-faux").replace("statut: en attente", "statut: approuvée")
      + "\n## Décision\n\n- Identifiant de demande : dec-20261011-0901-faux\n- Résultat : approuvée\n- Décidé par : ami@exemple.test\n- Attestation : att-20261011-0901-abcd\n";
    await externe(rel, faux);
    const v = await lireDecision(rel);
    assert.equal(v.enregistrements[0].verification, "non-attestee");
    assert.equal(v.preuve.etat, "absente");
    assert.equal(v.decidable, true);
    const p = await b.req("GET", "/api/page?chemin=" + q(rel));
    assert.equal(p.json.preuveDecision.etat, "absente");
    const liste = (await b.req("GET", "/api/decisions?statut=" + q("en attente"))).json.decisions;
    const d = liste.find((x: { chemin: string }) => x.chemin === rel);
    assert.equal(d.statut, "en attente", "statut effectif, pas le statut déclaré");
    assert.equal(d.statut_declare, "approuvée");
  });

  test("échec d'écriture -> ni fichier partiel, ni attestation, ni succès", async () => {
    const rel = "Décisions/Bloquée.md";
    await externe(rel, DEMANDE.replace("id: dec-20261011-0900-test", "id: dec-20261011-0902-bloq"));
    const v = await lireDecision(rel);
    const n = attestations().length;
    fs.chmodSync(disque("Décisions"), 0o555);
    try {
      const r = await geste({ chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id, commentaire: "à garder" });
      assert.ok(r.statut >= 400, String(r.statut));
    } finally {
      fs.chmodSync(disque("Décisions"), 0o755);
    }
    assert.equal(lire(rel), DEMANDE.replace("id: dec-20261011-0900-test", "id: dec-20261011-0902-bloq"));
    assert.equal(attestations().length, n);
    assert.deepEqual(fs.readdirSync(disque("Décisions")).filter((x) => x.includes(".tmp")), []);
    const v2 = await lireDecision(rel);
    assert.equal(v2.decidable, true);
  });

  test("création : modèle dans Décisions/ ou sous une page ; noms uniques ; frontmatter valide", async () => {
    const r = await b.req("POST", "/api/decisions", { corps: { titre: "Choisir l'hébergeur" } });
    assert.equal(r.statut, 201);
    assert.equal(r.json.chemin, "Décisions/Choisir l'hébergeur.md");
    const md = lire(r.json.chemin);
    assert.match(md, /^---\ntype: decision\nid: dec-\d{8}-\d{4}-[0-9a-z]{4}\nstatut: en attente\ndemandee_par: ami@exemple\.test\ncree: "[^"]+"\n---\n\n# Choisir l'hébergeur\n/);
    const v = await lireDecision(r.json.chemin);
    assert.equal(v.estDecision, true);
    assert.deepEqual(v.bloquants, []);
    const r2 = await b.req("POST", "/api/decisions", { corps: { titre: "Choisir l'hébergeur" } });
    assert.equal(r2.json.chemin, "Décisions/Choisir l'hébergeur (2).md");
    const r3 = await b.req("POST", "/api/decisions", { corps: { titre: "Budget", parent: "Démo/Projets.md" } });
    assert.equal(r3.json.chemin, "Démo/Projets/Budget.md");
    assert.equal((await b.req("POST", "/api/decisions", { corps: { titre: "X", parent: "Privé/Cachée.md" } })).statut, 403);
    assert.equal((await b.req("POST", "/api/decisions", { corps: { titre: "X", parent: "Absente.md" } })).statut, 404);
    assert.equal((await b.req("POST", "/api/decisions", { corps: { titre: "   " } })).statut, 400);
  });
});

describe("chaînage du journal des attestations", () => {
  test("chaque attestation cite la précédente ; une ligne effacée au milieu rend la preuve indéterminée ; la fin tronquée ne se voit pas", async () => {
    const b = await demarrerBanc();
    try {
      const fichier = path.join(b.etat, "journal", "espace", "attestations.jsonl");
      const ecrireDemande = async (rel: string, id: string) => {
        fs.mkdirSync(path.join(b.espace, path.dirname(rel)), { recursive: true });
        fs.writeFileSync(path.join(b.espace, rel), DEMANDE.replace("id: dec-20261011-0900-test", `id: ${id}`));
        await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter([rel.split("/")[0]])));
        return (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
      };
      const decider = async (rel: string, resultat: string) => {
        const v = (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
        const r = await b.req("POST", "/api/decision", { corps: { chemin: rel, resultat, empreinte: v.empreinte, demande: v.id }, entetes: { "X-Carnet-Requete": crypto.randomUUID() } });
        assert.equal(r.statut, 200, JSON.stringify(r.json));
      };
      await ecrireDemande("Ch/A.md", "dec-a");
      await decider("Ch/A.md", "approuvée");
      // nouvelle proposition pour A, puis refus : la dernière attestation de A est un refus
      fs.writeFileSync(path.join(b.espace, "Ch/A.md"), fs.readFileSync(path.join(b.espace, "Ch/A.md"), "utf8").replace("5 pages", "6 pages"));
      await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(["Ch"])));
      await decider("Ch/A.md", "refusée");
      await ecrireDemande("Ch/B.md", "dec-b");
      await decider("Ch/B.md", "approuvée");
      const lignes = fs.readFileSync(fichier, "utf8").trim().split("\n").map((l) => JSON.parse(l));
      assert.equal(lignes.length, 3);
      assert.match(lignes[0].portee, / precedente=aucune$/);
      assert.match(lignes[1].portee, / precedente=sha256:[0-9a-f]{64}$/);
      assert.match(lignes[2].portee, / precedente=sha256:[0-9a-f]{64}$/);
      const preuve = async (rel: string) => (await b.req("GET", "/api/page?chemin=" + q(rel))).json.preuveDecision;
      assert.equal((await preuve("Ch/B.md")).etat, "valide");
      // un agent efface le refus de A (ligne du milieu) : la coupure se voit
      fs.writeFileSync(fichier, [lignes[0], lignes[2]].map((l) => JSON.stringify(l) + "\n").join(""));
      fs.writeFileSync(path.join(b.espace, "Ch/A.md"), fs.readFileSync(path.join(b.espace, "Ch/A.md"), "utf8").replace("6 pages", "5 pages"));
      await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(["Ch"])));
      const pa = await preuve("Ch/A.md");
      assert.equal(pa.etat, "indeterminee", "l'approbation de A ne redevient pas « valide »");
      assert.equal(pa.journalCoupe, true);
      assert.equal((await preuve("Ch/B.md")).etat, "valide", "B est après la coupure : intact");
      const att = (await b.req("GET", "/api/attestations?chemin=" + q("Ch/A.md"))).json;
      assert.equal(att.journal.coupures, 1);
      // limite documentée : effacer la DERNIÈRE ligne du journal ne se voit pas
      fs.writeFileSync(fichier, [lignes[0], lignes[1]].map((l) => JSON.stringify(l) + "\n").join(""));
      assert.equal((await b.req("GET", "/api/attestations?chemin=" + q("Ch/B.md"))).json.journal.coupures, 0);
    } finally {
      await b.fermer();
    }
  });
});

describe("sans clé du serveur (CARNET_CLE absente)", () => {
  test("le socle crée sa propre clé d'attestation dans CARNET_ETAT (0600) : la décision est attestée", async () => {
    const b = await demarrerBanc({ env: { CARNET_CLE: "" } });
    try {
      const rel = "Décisions/Sans clé.md";
      fs.mkdirSync(path.join(b.espace, "Décisions"), { recursive: true });
      fs.writeFileSync(path.join(b.espace, rel), DEMANDE);
      await b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(["Décisions"])));
      const v = (await b.req("GET", "/api/decision?chemin=" + q(rel))).json;
      const r = await b.req("POST", "/api/decision", { corps: { chemin: rel, resultat: "approuvée", empreinte: v.empreinte, demande: v.id }, entetes: { "X-Carnet-Requete": crypto.randomUUID() } });
      assert.equal(r.statut, 200, JSON.stringify(r.json));
      assert.ok(r.json.attestation);
      assert.equal(fs.statSync(path.join(b.etat, "cle-attestations.key")).mode & 0o777, 0o600);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q(rel))).json.preuveDecision.etat, "valide");
    } finally {
      await b.fermer();
    }
  });
});
