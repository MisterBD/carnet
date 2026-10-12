// Carnet · lot 3 : nouveautés (état « vu » hors de l'espace, version présentée, auteur non vérifié, renommage,
// suppression, fichiers des agents).
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { dossierLecteur } from "../src/nouveautes.ts";
import { demarrerBanc, LOGIN, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
const disque = (rel: string) => path.join(b.espace, rel);
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
async function externe(rel: string, contenu: string | null): Promise<void> {
  if (contenu === null) fs.rmSync(disque(rel));
  else {
    fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
    fs.writeFileSync(disque(rel), contenu);
  }
  await indexer([rel.split("/")[0]]);
}
const liste = async (techniques = false) => (await b.req("GET", "/api/nouveautes" + (techniques ? "?techniques=1" : ""))).json;
const trouver = async (chemin: string, techniques = false) => (await liste(techniques)).pages.find((x: { chemin: string }) => x.chemin === chemin);
const marquer = (pages: unknown[]) => b.req("POST", "/api/nouveautes/vu", { corps: { pages } });
const dossierEtat = () => path.join(b.etat, "nouveautes", "espace", dossierLecteur(LOGIN));

before(async () => {
  b = await demarrerBanc({ env: { CARNET_UTILISATEURS_AUTORISES: `${LOGIN} autre@exemple.test` } });
  await externe("Suivi/Agent.md", "---\nmaj_par: Lina\n---\n\n# Suivi agent\n\nLigne A\n");
  await externe("Suivi/Renommée.md", "# À renommer\n\nContenu stable\n");
  await externe("Suivi/Supprimée.md", "# À supprimer\n\nAdieu\n");
  await externe("AGENTS.md", "# Consignes\n\nv1\n");
});
after(async () => { await b.fermer(); });

describe("premier lancement", () => {
  test("point de départ = maintenant : aucune nouveauté, état hors de l'espace avec copies vérifiables", async () => {
    const r = await b.req("GET", "/api/nouveautes");
    assert.equal(r.statut, 200);
    assert.deepEqual(r.json.pages, []);
    assert.match(r.json.depart, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    const vu = JSON.parse(fs.readFileSync(path.join(dossierEtat(), "vu.json"), "utf8"));
    assert.equal(vu.pages["Suivi/Agent.md"].etag, sha16(fs.readFileSync(disque("Suivi/Agent.md"))));
    const copie = fs.readFileSync(path.join(dossierEtat(), "copies", vu.pages["Suivi/Agent.md"].copie + ".md"), "utf8");
    assert.equal(copie, fs.readFileSync(disque("Suivi/Agent.md"), "utf8"));
    assert.ok(!dossierEtat().startsWith(b.espace));
    assert.equal((fs.statSync(path.join(dossierEtat(), "vu.json")).mode & 0o777), 0o600);
  });
});

describe("nouveauté externe", () => {
  test("modification externe : listée, différence correcte, « auteur non vérifié » malgré maj_par", async () => {
    const v2 = "---\nmaj_par: Lina\nmaj_motif: relance du client\n---\n\n# Suivi agent\n\nLigne A modifiée\nLigne B\n";
    await externe("Suivi/Agent.md", v2);
    const it = await trouver("Suivi/Agent.md");
    assert.ok(it);
    assert.equal(it.etat, "modifiee");
    assert.equal(it.auteur, "non vérifié");
    assert.equal(it.maj_par_declare, "Lina");
    assert.equal(it.motif_declare, "relance du client");
    assert.equal(it.etag, sha16(v2));
    assert.ok(it.ajouts >= 3, JSON.stringify(it));
    for (const k of ["chemin", "titre", "mtime", "etat", "vers", "auteur", "maj_par_declare", "motif_declare"]) assert.ok(k in it, k);
    const d = (await b.req("GET", "/api/nouveaute?chemin=" + q("Suivi/Agent.md"))).json;
    assert.equal(d.etat, "modifiee");
    assert.match(d.vu.contenu, /Ligne A\n$/);
    assert.equal(d.actuel.contenu, v2);
    assert.equal(d.actuel.etag, sha16(v2));
  });
  test("ouvrir une page ne la marque pas vue ; « Marquer comme vu » avec la version présentée la retire", async () => {
    await b.req("GET", "/api/page?chemin=" + q("Suivi/Agent.md"));
    const it = await trouver("Suivi/Agent.md");
    assert.ok(it, "toujours nouvelle après ouverture");
    const r = await marquer([{ chemin: it.chemin, etag: it.etag }]);
    assert.equal(r.statut, 200);
    assert.deepEqual(r.json.marquees, ["Suivi/Agent.md"]);
    assert.equal(await trouver("Suivi/Agent.md"), undefined);
    assert.equal((await b.req("GET", "/api/nouveaute?chemin=" + q("Suivi/Agent.md"))).json.etat, "a-jour");
    // aucun champ « vu » dans le fichier
    assert.doesNotMatch(fs.readFileSync(disque("Suivi/Agent.md"), "utf8"), /\bvu\b/);
  });
});

describe("course au marquage", () => {
  test("version B présentée, C écrite ensuite, B marquée : B est la référence, C reste nouvelle", async () => {
    const B = "---\nmaj_par: Lina\n---\n\n# Suivi agent\n\nVersion B\n";
    const C = "---\nmaj_par: Lina\n---\n\n# Suivi agent\n\nVersion C\n";
    await externe("Suivi/Agent.md", B);
    const presentee = await trouver("Suivi/Agent.md");
    assert.equal(presentee.etag, sha16(B));
    await externe("Suivi/Agent.md", C);
    const r = await marquer([{ chemin: "Suivi/Agent.md", etag: presentee.etag }]);
    assert.deepEqual(r.json.marquees, ["Suivi/Agent.md"]);
    const encore = await trouver("Suivi/Agent.md");
    assert.ok(encore, "C reste nouvelle");
    assert.equal(encore.etag, sha16(C));
    const d = (await b.req("GET", "/api/nouveaute?chemin=" + q("Suivi/Agent.md"))).json;
    assert.equal(d.vu.etag, sha16(B), "la référence est B");
    assert.equal(d.vu.contenu, B);
  });
  test("version présentée par la page (contenu renvoyé) : acceptée seulement si elle correspond à l'etag", async () => {
    const D = "# Suivi agent\n\nVersion D\n";
    const faux = { chemin: "Suivi/Agent.md", etag: sha16(D), contenu: "autre chose" };
    const r1 = await marquer([faux]);
    assert.deepEqual(r1.json.restantes, ["Suivi/Agent.md"]);
    const r2 = await marquer([{ ...faux, contenu: D }]);
    assert.deepEqual(r2.json.marquees, ["Suivi/Agent.md"]);
    const d = (await b.req("GET", "/api/nouveaute?chemin=" + q("Suivi/Agent.md"))).json;
    assert.equal(d.vu.contenu, D);
    assert.equal(d.etat, "modifiee", "la version actuelle (C) reste nouvelle");
  });
  test("« tout marquer » respecte les versions présentées", async () => {
    await externe("Suivi/Une.md", "# Une\n\nv1\n");
    await externe("Suivi/Deux.md", "# Deux\n\nv1\n");
    const l = (await liste()).pages;
    await externe("Suivi/Deux.md", "# Deux\n\nv2 arrivée pendant la lecture\n");
    const r = await marquer(l.map((x: { chemin: string; etag: string | null; vers: string | null }) => ({ chemin: x.chemin, etag: x.etag, vers: x.vers })));
    assert.equal(r.statut, 200);
    const apres = (await liste()).pages.map((x: { chemin: string }) => x.chemin);
    assert.ok(apres.includes("Suivi/Deux.md"), "la v2 non présentée reste nouvelle");
    assert.ok(!apres.includes("Suivi/Une.md"));
    assert.ok(!apres.includes("Suivi/Agent.md"));
    await marquer([{ chemin: "Suivi/Deux.md", etag: sha16("# Deux\n\nv2 arrivée pendant la lecture\n") }]);
  });
});

describe("renommage, suppression, fichiers des agents, état hors espace", () => {
  test("renommage extérieur suivi (même contenu) ; marquer suit le nouveau chemin", async () => {
    fs.renameSync(disque("Suivi/Renommée.md"), disque("Suivi/Nouveau nom.md"));
    await indexer(["Suivi"]);
    const it = await trouver("Suivi/Renommée.md");
    assert.equal(it.etat, "renommee");
    assert.equal(it.vers, "Suivi/Nouveau nom.md");
    assert.equal(it.modifiee, false);
    const r = await marquer([{ chemin: it.chemin, vers: it.vers, etag: it.etag }]);
    assert.deepEqual(r.json.marquees, ["Suivi/Nouveau nom.md"]);
    const l = (await liste()).pages;
    assert.ok(!l.some((x: { chemin: string; vers: string }) => x.chemin === "Suivi/Renommée.md" || x.vers === "Suivi/Nouveau nom.md"));
  });
  test("suppression signalée, puis oubliée une fois vue", async () => {
    await externe("Suivi/Supprimée.md", null);
    const it = await trouver("Suivi/Supprimée.md");
    assert.equal(it.etat, "supprimee");
    assert.equal(it.etag, null);
    assert.equal(it.titre, "À supprimer");
    await marquer([{ chemin: it.chemin, etag: null }]);
    assert.equal(await trouver("Suivi/Supprimée.md"), undefined);
  });
  test("page nouvelle ; fichiers des agents exclus par défaut, inclus sur demande", async () => {
    await externe("Suivi/Créée.md", "# Créée par un agent\n");
    await externe("AGENTS.md", "# Consignes\n\nv2\n");
    const l = await liste();
    assert.equal(l.pages.find((x: { chemin: string }) => x.chemin === "Suivi/Créée.md").etat, "nouvelle");
    assert.ok(!l.pages.some((x: { chemin: string }) => x.chemin === "AGENTS.md"));
    assert.ok(l.techniques_masquees >= 1);
    const t = await trouver("AGENTS.md", true);
    assert.equal(t.technique, true);
  });
  test("une écriture de Carnet sous l'identité du lecteur n'est pas une nouveauté", async () => {
    await externe("Suivi/Décision.md", "---\ntype: decision\nid: dec-1\nstatut: en attente\n---\n\n# D\n\n## Proposition\n\n- Objet : x\n");
    await marquer([{ chemin: "Suivi/Décision.md", etag: (await trouver("Suivi/Décision.md")).etag }]);
    const v = (await b.req("GET", "/api/decision?chemin=" + q("Suivi/Décision.md"))).json;
    const r = await b.req("POST", "/api/decision", {
      corps: { chemin: "Suivi/Décision.md", resultat: "refusée", empreinte: v.empreinte, demande: v.id }, entetes: { "X-Carnet-Requete": crypto.randomUUID() },
    });
    assert.equal(r.statut, 200);
    await new Promise((ok) => setTimeout(ok, 120));
    assert.equal(await trouver("Suivi/Décision.md"), undefined);
    const d = (await b.req("GET", "/api/nouveaute?chemin=" + q("Suivi/Décision.md"))).json;
    assert.equal(d.etat, "a-jour");
    assert.equal(d.etag, r.json.etag);
  });
  test("renommage et suppression faits par Carnet sous l'identité du lecteur : suivis sans bruit (journal du socle)", async () => {
    await externe("Suivi/Carnet A.md", "# Carnet A\n\nstable\n");
    await externe("Suivi/Carnet B.md", "# Carnet B\n\nà supprimer\n");
    const l = (await liste()).pages.filter((x: { chemin: string }) => x.chemin.startsWith("Suivi/Carnet"));
    await marquer(l.map((x: { chemin: string; etag: string }) => ({ chemin: x.chemin, etag: x.etag })));
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Suivi/Carnet A.md", nom: "Carnet A2" } });
    assert.equal(r.statut, 200, JSON.stringify(r.json));
    assert.equal((await b.req("POST", "/api/supprimer", { corps: { chemin: "Suivi/Carnet B.md" } })).statut, 200);
    const apres = (await liste()).pages.map((x: { chemin: string; vers: string | null }) => `${x.chemin}>${x.vers ?? ""}`);
    assert.ok(!apres.some((x: string) => x.includes("Carnet A") || x.includes("Carnet B")), apres.join(" | "));
    const vu = JSON.parse(fs.readFileSync(path.join(dossierEtat(), "vu.json"), "utf8"));
    assert.ok(vu.pages["Suivi/Carnet A2.md"], "le suivi a suivi le renommage");
    assert.equal(vu.pages["Suivi/Carnet A.md"], undefined);
    assert.equal(vu.pages["Suivi/Carnet B.md"], undefined);
  });
  test("écriture de Carnet sous une AUTRE identité : nouveauté, auteur = cette identité (qui ne prouve pas un humain)", async () => {
    await externe("Suivi/Partagée.md", "# Partagée\n\nv1\n");
    await marquer([{ chemin: "Suivi/Partagée.md", etag: (await trouver("Suivi/Partagée.md")).etag }]);
    const p = (await b.req("GET", "/api/page?chemin=" + q("Suivi/Partagée.md"))).json;
    const w = await b.req("PUT", "/api/page?chemin=" + q("Suivi/Partagée.md"), {
      corps: { contenu: "# Partagée\n\nv2 écrite par un autre compte\n" }, entetes: { "If-Match": p.etag, "Tailscale-User-Login": "autre@exemple.test" },
    });
    assert.equal(w.statut, 200, JSON.stringify(w.json));
    await new Promise((ok) => setTimeout(ok, 100));
    const it = await trouver("Suivi/Partagée.md");
    assert.equal(it.etat, "modifiee");
    assert.equal(it.auteur, "autre@exemple.test");
    // pour l'autre compte, sa propre écriture n'est pas une nouveauté
    const autre = await b.req("GET", "/api/nouveautes", { entetes: { "Tailscale-User-Login": "autre@exemple.test" } });
    assert.ok(!autre.json.pages.some((x: { chemin: string }) => x.chemin === "Suivi/Partagée.md"));
  });
  test("sécurité des chemins et des corps", async () => {
    assert.equal((await b.req("GET", "/api/nouveaute?chemin=" + q("../etc/passwd.md"))).statut, 403);
    assert.equal((await b.req("GET", "/api/nouveaute?chemin=" + q("Privé/Cachée.md"))).statut, 403);
    assert.equal((await marquer([{ chemin: ".git/config.md", etag: "x" }])).statut, 403);
    assert.equal((await marquer([{ chemin: "Suivi/Une.md" }])).statut, 400);
    assert.equal((await marquer([])).statut, 400);
    assert.equal((await b.req("POST", "/api/nouveautes/vu", { corps: { pages: [{ chemin: "Suivi/Une.md", etag: "x" }] }, entetes: { "X-Carnet": undefined } })).statut, 403);
    assert.equal(dossierLecteur(".."), "_-" + crypto.createHash("sha256").update("..").digest("hex").slice(0, 8));
    assert.equal(dossierLecteur("Ami@github"), "ami@github");
    assert.match(dossierLecteur("a/../b"), /^_a_\.\._b-[0-9a-f]{8}$/);
  });
  test("état par lecteur : un autre lecteur a son propre point de départ", async () => {
    const moi = await liste();
    assert.ok(moi.pages.length > 0);
    const autre = await b.req("GET", "/api/nouveautes", { entetes: { "Tailscale-User-Login": "autre@exemple.test" } });
    assert.equal(autre.statut, 200);
    assert.deepEqual(autre.json.pages, []);
    assert.ok(fs.existsSync(path.join(b.etat, "nouveautes", "espace", "autre@exemple.test", "vu.json")));
    assert.equal((await b.req("GET", "/api/nouveautes", { entetes: { "Tailscale-User-Login": "intrus@exemple.test" } })).statut, 403);
  });
});
