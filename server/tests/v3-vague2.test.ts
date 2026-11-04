// Carnet · fusion de la vague 2 (lots 5 « Fiabilité » × 6 « Pages ») : points de rencontre, côté serveur.
// - un 423 (page verrouillée) est un refus définitif : rien d'écrit, aucune écriture « indéterminée », renvoi = 423 ;
// - « Revenir à la version marquée vue » : refusé clairement sur une page verrouillée (aperçu ET confirmation, rien
//   d'écrit), et ne désarchive pas une page archivée ;
// - copie de conflit d'une page archivée / verrouillée : ni archivée ni verrouillée (et la réponse le dit) ;
// - page créée depuis un modèle : même règle de conflit (412, copie au nom attendu).
import "../src/analyseur-yaml.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import YAML from "yaml";
import { decouper } from "../../shared/page.ts";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
const rq = () => crypto.randomUUID();
const disque = (rel: string) => path.join(b.espace, rel);
const lire = (rel: string) => fs.readFileSync(disque(rel), "utf8");
const fm = (c: string) => YAML.parse(decouper(c).yaml) ?? {};
const indexer = (rels: string[]) => b.app.espace.verrou.executer(async () => b.app.espace.appliquer(await b.app.espace.traiter(rels)));
async function externe(rel: string, contenu: string): Promise<void> {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
  await indexer([rel.split("/")[0]]);
}
const ecrire = (rel: string, contenu: string, etag: string | null, requete = rq()) =>
  b.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu }, entetes: { ...(etag ? { "If-Match": etag } : { "If-None-Match": "*" }), "X-Carnet-Requete": requete } });

before(async () => {
  b = await demarrerBanc({
    preparer: (_r, espace) => {
      const w = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(espace, rel)), { recursive: true }); fs.writeFileSync(path.join(espace, rel), t); };
      w("Modèles/Compte rendu.md", "---\ntitle: \"{{titre}}\"\ncree: {{date}}\n---\n# {{titre}}\n\nLe {{date}}.\n");
    },
  });
  await externe("V2/Verrou retour.md", "# Verrou retour\n\nVersion vue.\n");
  await externe("V2/Archive retour.md", "# Archive retour\n\nVersion vue.\n");
  await externe("V2/Saisie.md", "# Saisie\n\nTexte.\n");
  // premier passage des nouveautés : les pages actuelles sont « vues »
  assert.equal((await b.req("GET", "/api/nouveautes")).statut, 200);
});
after(async () => { await b.fermer(); });

describe("verrou × écriture fiable", () => {
  test("423 = refus définitif : rien d'écrit, renvoi du même geste encore 423, aucune écriture indéterminée", async () => {
    const avant = lire("V2/Saisie.md");
    // un agent verrouille la page sur disque pendant la saisie
    const verrouille = "---\nverrou: true\n---\n" + avant;
    await externe("V2/Saisie.md", verrouille);
    const id = rq();
    const r = await ecrire("V2/Saisie.md", verrouille + "\nAjout refusé.\n", sha16(verrouille), id);
    assert.equal(r.statut, 423, r.texte);
    assert.equal(r.json.raison, "page_verrouillee");
    assert.equal(lire("V2/Saisie.md"), verrouille);
    const bis = await ecrire("V2/Saisie.md", verrouille + "\nAjout refusé.\n", sha16(verrouille), id);
    assert.equal(bis.statut, 423, "un renvoi n'est jamais rejoué comme une écriture réussie");
    assert.equal(lire("V2/Saisie.md"), verrouille);
    const ind = await b.req("GET", "/api/ecritures/indeterminees");
    assert.equal(ind.statut, 200);
    assert.equal(ind.json.elements.filter((e: { chemin: string }) => e.chemin === "V2/Saisie.md").length, 0);
    // « Garder la mienne » (écraser) sur une version verrouillée : refusé aussi
    const ec = await b.req("PUT", "/api/page?chemin=" + q("V2/Saisie.md"), { corps: { contenu: "# Saisie\n\nÉcrasé.\n", ecraser: true }, entetes: { "If-Match": sha16(verrouille), "X-Carnet-Requete": rq() } });
    assert.equal(ec.statut, 423, ec.texte);
    assert.equal(lire("V2/Saisie.md"), verrouille);
  });

  test("retour à la version vue sur une page verrouillée : aperçu et confirmation refusés (423), rien d'écrit", async () => {
    const rel = "V2/Verrou retour.md";
    const agent = "---\nverrou: true\n---\n# Verrou retour\n\nModifiée par un agent.\n";
    await externe(rel, agent);
    const ap = await b.req("GET", "/api/nouveautes/retour?chemin=" + q(rel));
    assert.equal(ap.statut, 423, ap.texte);
    assert.match(ap.json.erreur, /verrouillée/);
    const vu = sha16("# Verrou retour\n\nVersion vue.\n");
    const r = await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: rel, etag: sha16(agent), vu }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 423, r.texte);
    assert.equal(lire(rel), agent);
  });

  test("retour à la version vue sur une page archivée : la page revient au texte vu ET reste archivée", async () => {
    const rel = "V2/Archive retour.md";
    const agent = "---\narchive: true\n---\n# Archive retour\n\nModifiée par un agent.\n";
    await externe(rel, agent);
    const ap = await b.req("GET", "/api/nouveautes/retour?chemin=" + q(rel));
    assert.equal(ap.statut, 200, ap.texte);
    assert.equal(ap.json.archive, true);
    const r = await b.req("POST", "/api/nouveautes/retour", { corps: { chemin: rel, etag: ap.json.actuel.etag, vu: ap.json.vu.etag }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 200, r.texte);
    const c = lire(rel);
    assert.equal(fm(c).archive, true, "pas de désarchivage");
    assert.match(c, /Version vue\./);
    assert.doesNotMatch(c, /Modifiée par un agent/);
  });
});

describe("copie de conflit × archive / verrou / modèles", () => {
  test("copie d'une page archivée et verrouillée : ni archivée ni verrouillée, et la réponse le dit", async () => {
    await externe("V2/Rangée.md", "---\narchive: true\nverrou: true\nstatut: fini\n---\n# Rangée\n\nTexte.\n");
    const mien = "---\narchive: true\nverrou: true\nstatut: fini\n---\n# Rangée\n\nTexte et ma saisie.\n";
    const r = await b.req("POST", "/api/page/conflit", { corps: { chemin: "V2/Rangée.md", contenu: mien }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 201, r.texte);
    assert.deepEqual(r.json.retires, ["archive", "verrou"]);
    const c = lire(r.json.chemin);
    const f = fm(c);
    assert.equal(f.archive, undefined);
    assert.equal(f.verrou, undefined);
    assert.equal(f.statut, "fini");
    assert.equal(f.conflit_de, "V2/Rangée.md");
    assert.match(c, /Texte et ma saisie\./);
    // visible : dans la recherche par défaut et dans l'arbre sans drapeau
    const arbre = await b.req("GET", "/api/arbre");
    const trouve = JSON.stringify(arbre.json).includes(path.basename(r.json.chemin, ".md"));
    assert.equal(trouve, true);
    // l'original n'a pas bougé
    assert.equal(fm(lire("V2/Rangée.md")).verrou, true);
  });

  test("copie d'une page ordinaire : pas de champ retires", async () => {
    const r = await b.req("POST", "/api/page/conflit", { corps: { chemin: "V2/Saisie.md", contenu: "# Saisie\n\nAutre.\n" }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(r.statut, 201, r.texte);
    assert.equal(r.json.retires, undefined);
  });

  test("page créée depuis un modèle, modifiée en même temps par un agent : 412 puis copie au nom attendu", async () => {
    const cree = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre: "CR conflit" }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(cree.statut, 201, cree.texte);
    const rel = cree.json.chemin as string;
    const base = lire(rel);
    await externe(rel, base + "\nAjout de l'agent.\n");
    const mien = base + "\nMa saisie.\n";
    const r = await ecrire(rel, mien, sha16(base));
    assert.equal(r.statut, 412, r.texte);
    const copie = await b.req("POST", "/api/page/conflit", { corps: { chemin: rel, contenu: mien }, entetes: { "X-Carnet-Requete": rq() } });
    assert.equal(copie.statut, 201, copie.texte);
    assert.match(copie.json.chemin, /^CR conflit \(conflit \d{4}-\d\d-\d\d \d\dh\d\d\)\.md$/);
    assert.match(lire(copie.json.chemin), /Ma saisie\./);
    assert.match(lire(rel), /Ajout de l'agent\./);
  });
});
