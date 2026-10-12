// Carnet · lot 11 « Dossier de rendez-vous » : assemblage déterministe (B1), couverture et sources non accessibles (B2),
// « à rafraîchir » d'une préparation conservée (B3), conservation idempotente et relecture après redémarrage (B4),
// sécurité des chemins, boucles de liens, dossier énorme borné, Markdown inerte.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { creerApplication } from "../src/app.ts";
import { lireConfig } from "../src/config.ts";
import { lireFrontmatter } from "../src/espace.ts";
import { assembler, codeEnLigne, echapperMd, extrait, rendreMarkdown, sansCommentairesHtml } from "../src/preparation.ts";
import { demarrerBanc, LOGIN, q, requete } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
const disque = (rel: string) => path.join(b.espace, rel);
const ecrire = (rel: string, contenu: string) => {
  fs.mkdirSync(path.dirname(disque(rel)), { recursive: true });
  fs.writeFileSync(disque(rel), contenu);
};
const vieillir = (rel: string, jours: number) => {
  const t = new Date(Date.now() - jours * 86_400_000);
  fs.utimesSync(disque(rel), t, t);
};
const reindexer = async () => {
  const e = b.app.espace;
  await e.verrou.executer(async () => e.appliquer(await e.balayerTout()));
};
const uuid = () => crypto.randomUUID();
const FICHE = "Clients/Atelier Nord.md";

const PIEGE = "zorglubinterdit";

before(async () => {
  b = await demarrerBanc({ env: { CARNET_GIT: "non" } });
  ecrire(FICHE, `---
type: client
sources:
  - "[[Clients/Atelier Nord/Compte rendu 03-10]]"
  - "[[Clients/Atelier Nord/Réunions/]]"
  - "[[Décisions/Choix de l'offre]]"
  - "[[Clients/Atelier Nord/Contrat]]"
  - "[[Privé/Cachée]]"
  - "[[Privé/N'existe pas]]"
  - "[[../../../etc/passwd]]"
  - "[[.git/config]]"
  - "https://exemple.test/dossier"
  - [[Clients/Atelier Nord/Notes en vrac]]
  - "[[Clients/Atelier Nord]]"
---
# Atelier Nord

Fiche client fictive.

- [ ] Préparer l'ordre du jour 📅 2026-10-20
`);
  ecrire("Clients/Atelier Nord/Compte rendu 03-10.md", `---
type: compte-rendu
---
# Compte rendu du 03/10

Échange sur le **périmètre** de l'audit et [[Privé/Cachée|un lien]] vers <b>rien</b>.

## Livrables
Faux titre dans une source : ne doit pas créer de section.

- [ ] Envoyer le devis signé 📅 2020-01-15 ⏫
- [x] Relancer la comptable ✅ 2026-10-01
- [/] Rédiger la synthèse
- [-] Tâche abandonnée
- [ ] Tâche annulée ❌ 2026-10-02
- [ ] Appeler le client 📅 2026-10-12

\`\`\`
- [ ] tâche dans du code, ignorée
\`\`\`
`);
  ecrire("Clients/Atelier Nord/Réunions/Atelier 1.md", "# Atelier 1\n\nPremier atelier : cartographie des processus.\n\n- [ ] Partager le support\n");
  ecrire("Clients/Atelier Nord/Réunions/Archives/Atelier 0.md", "# Atelier 0\n\nVieux compte rendu.\n");
  ecrire("Clients/Atelier Nord/Notes en vrac.md", "# Notes en vrac\n\nNote saisie sans guillemets dans les sources.\n");
  ecrire("Décisions/Choix de l'offre.md", `---
type: decision
id: dec-20261005-0900-ab12
statut: approuvée
demande_par: Sacha
cree: 2026-10-05T09:00:00+02:00
---
# Choix de l'offre

## Proposition

- Objet : retenir l'offre B (audit en deux temps)

## Contexte

Texte libre.
`);
  ecrire("Missions/Audit Atelier Nord.md", `---
type: mission
id: mis-20261006-1000-zz11
responsable_declare: Sacha
etat: terminée déclarée
livrables:
  - "[[Clients/Atelier Nord/Audit v1]]"
  - "[[Clients/Atelier Nord/Annexe absente]]"
  - "https://exemple.test/livrable.pdf"
  - "[[Privé/Atelier/Coffre]]"
decision: "[[Décisions/Choix de l'offre]]"
client: "[[Clients/Atelier Nord]]"
---
# Audit Atelier Nord

## Demande
Auditer les processus.
`);
  ecrire("Clients/Atelier Nord/Audit v1.md", "---\ntype: livrable\n---\n# Audit v1\n\nLivrable de démonstration.\n");
  vieillir("Clients/Atelier Nord/Réunions/Archives/Atelier 0.md", 90);
  await reindexer();
});
after(async () => { await b.fermer(); });

const apercu = async (chemin = FICHE) => {
  const r = await b.req("GET", "/api/preparation?chemin=" + q(chemin));
  assert.equal(r.statut, 200, r.texte);
  return r.json;
};

describe("B1 · assemblage depuis une fiche dotée de sources", () => {
  test("quatre sections attendues ; chaque extrait porte sa page source et sa révision", async () => {
    const a = await apercu();
    assert.equal(a.fiche.chemin, FICHE);
    // décision consignée, statut DÉCLARÉ et preuve calculée par le socle (aucune attestation : pas « valide »)
    assert.equal(a.decisions.length, 1);
    const d = a.decisions[0];
    assert.equal(d.source.chemin, "Décisions/Choix de l'offre.md");
    assert.equal(d.statut, "approuvée");
    assert.equal(d.aConfirmer, false, "statut approuvé : décision prise (même sans attestation, affichée « non attestée »)");
    assert.match(d.extrait, /offre B/);
    assert.ok(d.preuve && d.preuve.etat !== "valide", JSON.stringify(d.preuve));
    // tâches ouvertes : échéance d'abord (la plus ancienne en premier, en retard), puis les autres ; ni faites, ni annulées, ni code
    const textes = a.taches.map((t: any) => t.texte);
    assert.deepEqual(textes.slice(0, 3), ["Envoyer le devis signé", "Appeler le client", "Préparer l'ordre du jour"]);
    assert.ok(textes.includes("Rédiger la synthèse"));
    assert.ok(textes.includes("Partager le support"));
    for (const x of ["Relancer la comptable", "Tâche abandonnée", "Tâche annulée", "tâche dans du code, ignorée"]) assert.ok(!textes.includes(x), x);
    const devis = a.taches[0];
    assert.equal(devis.echeance, "2020-01-15");
    assert.equal(devis.enRetard, true);
    assert.equal(devis.priorite, "haute");
    assert.equal(devis.source.chemin, "Clients/Atelier Nord/Compte rendu 03-10.md");
    assert.ok(a.taches.find((t: any) => t.texte === "Rédiger la synthèse").enCours);
    // notes récentes : modifiées depuis 30 jours (pas l'archive de 90 jours, ni la fiche, ni la décision, ni le livrable)
    const notes = a.notes.map((n: any) => n.source.chemin);
    assert.ok(notes.includes("Clients/Atelier Nord/Compte rendu 03-10.md"));
    assert.ok(notes.includes("Clients/Atelier Nord/Réunions/Atelier 1.md"));
    assert.ok(notes.includes("Clients/Atelier Nord/Notes en vrac.md"), "entrée YAML non guillemetée [[…]] comprise");
    assert.ok(!notes.includes("Clients/Atelier Nord/Réunions/Archives/Atelier 0.md"));
    assert.ok(!notes.includes(FICHE));
    assert.ok(!notes.includes("Clients/Atelier Nord/Audit v1.md"));
    assert.equal(a.masques.notesAnciennes, 1);
    const cr = a.notes.find((n: any) => n.source.chemin === "Clients/Atelier Nord/Compte rendu 03-10.md");
    assert.ok(!/[<>]/.test(cr.extrait), "extrait sans HTML brut : " + cr.extrait);
    // livrables : mission rattachée par `client`, livrable présent avec révision, absent, externe, non accessible
    const l = a.livrables;
    const audit = l.find((x: any) => x.chemin === "Clients/Atelier Nord/Audit v1.md");
    assert.equal(audit.etat, "present");
    assert.equal(audit.mission.chemin, "Missions/Audit Atelier Nord.md");
    assert.equal(audit.mission.etat, "terminée déclarée");
    assert.match(audit.revision.etag, /^[0-9a-f]{16}$/);
    assert.ok(l.some((x: any) => x.etat === "absent" && /Annexe absente/.test(x.brut)));
    assert.ok(l.some((x: any) => x.etat === "externe" && x.url === "https://exemple.test/livrable.pdf"));
    assert.ok(l.some((x: any) => x.etat === "non_accessible" && !("chemin" in x)));
    assert.ok(a.sources.some((s: any) => s.implicite && s.chemin === "Missions/Audit Atelier Nord.md"));
    // révisions : etag complet = etag de l'index, court = 8 caractères, date ISO avec fuseau
    for (const p of a.pages) {
      const page = b.app.espace.pages.get(p.chemin)!;
      assert.equal(p.revision.etag, page.etag.replace(/"/g, ""));
      assert.equal(p.revision.court, p.revision.etag.slice(0, 8));
      assert.match(p.revision.modifiee, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
    }
  });

  test("déterministe : même index et même instant = même résultat, même empreinte", async () => {
    const ctx = b.app.api.preparations.contexte(Date.parse("2026-10-11T08:12:00+02:00"));
    const a1 = await assembler(ctx, FICHE);
    const a2 = await assembler(ctx, FICHE);
    assert.deepEqual(a1, a2);
    assert.match(a1.empreinte, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a1.genere, "2026-10-11T08:12:00+02:00");
    const r1 = await apercu();
    const r2 = await apercu();
    assert.equal(r1.empreinte, r2.empreinte);
  });

  test("une page sans sources : 422 explicite ; page absente : 404 ; rien n'est écrit", async () => {
    const r = await b.req("GET", "/api/preparation?chemin=" + q("Clients/Atelier Nord/Audit v1.md"));
    assert.equal(r.statut, 422);
    assert.equal(r.json.raison, "sans_sources");
    const r2 = await b.req("GET", "/api/preparation?chemin=" + q("Clients/Inconnu.md"));
    assert.equal(r2.statut, 404);
    assert.ok(!fs.existsSync(disque("Préparations")));
  });
});

describe("B2 · couverture incomplète sans divulgation", () => {
  test("manquante, masquée, traversante, cachée, externe : signalées ; aucun contenu interdit dans la réponse", async () => {
    const r = await b.req("GET", "/api/preparation?chemin=" + q(FICHE));
    assert.equal(r.statut, 200);
    assert.ok(!r.texte.includes(PIEGE), "contenu interdit divulgué");
    const a = r.json;
    const s = (brut: string) => a.sources.find((x: any) => x.brut === brut);
    assert.equal(s("[[Clients/Atelier Nord/Contrat]]").etat, "introuvable");
    // sources non accessibles : ni titre ni chemin exposés, et la même réponse qu'elles existent ou non
    const na = a.sources.filter((x: any) => x.etat === "non_accessible");
    assert.deepEqual(na.map((x: any) => [x.brut, x.raison]), [["", "masquée"], ["", "masquée"], ["", "hors de l'espace"], ["", "masquée"]]);
    for (const x of na) assert.ok(!("chemin" in x) && !("nom" in x));
    assert.ok(!r.texte.includes("Cachée") && !r.texte.includes("N'existe pas") && !r.texte.includes("passwd"));
    assert.equal(s("[[Clients/Atelier Nord/Contrat]]").nom, "Contrat");
    assert.equal(s("https://exemple.test/dossier").etat, "externe");
    assert.equal(s("[[Clients/Atelier Nord]]").etat, "ignoree");
    assert.equal(a.couverture.manquantes, 1);
    assert.equal(a.couverture.nonAccessibles, 4);
    assert.equal(a.couverture.externes, 1);
    // les pages lues ne sortent jamais des zones autorisées
    for (const p of a.pages) assert.ok(!p.chemin.startsWith("Privé/") && !p.chemin.includes("/."), p.chemin);
  });

  test("lien symbolique vers une zone masquée et _assets : jamais lus", async () => {
    ecrire("Fiches/Lien.md", "---\nsources:\n  - \"[[lien-prive]]\"\n  - \"[[Démo/_assets/note]]\"\n  - \"[lien md](../Privé/Cachée.md)\"\n---\n# Lien\n");
    await reindexer();
    const r = await b.req("GET", "/api/preparation?chemin=" + q("Fiches/Lien.md"));
    assert.equal(r.statut, 200, r.texte);
    assert.ok(!r.texte.includes(PIEGE));
    assert.equal(r.json.couverture.lues, 0);
    assert.deepEqual(r.json.sources.map((x: any) => x.etat), ["introuvable", "non_accessible", "non_accessible"]);
  });

  test("chemin de la fiche refusé : traversée, fichier caché, zone masquée", async () => {
    for (const c of ["../x.md", ".git/config.md", "Privé/Cachée.md", "Démo/../../x.md"]) {
      const r = await b.req("GET", "/api/preparation?chemin=" + q(c));
      assert.ok(r.statut === 400 || r.statut === 403, `${c} : ${r.statut}`);
      assert.ok(!r.texte.includes(PIEGE));
    }
  });
});

describe("Bornes et boucles", () => {
  test("boucle de liens (fiches qui se citent, dossier qui contient la fiche, livrable qui revient à la fiche) : terminé, chaque page une fois", async () => {
    ecrire("Boucle/A.md", "---\nsources:\n  - \"[[Boucle/B]]\"\n  - \"[[Boucle/A]]\"\n  - \"[[Boucle/]]\"\n  - \"[[Boucle/B]]\"\n---\n# A\n\n- [ ] Tâche de A\n");
    ecrire("Boucle/B.md", "---\nsources:\n  - \"[[Boucle/A]]\"\n---\n# B\n\n- [ ] Tâche de B\n");
    ecrire("Boucle/M.md", "---\ntype: mission\netat: en cours\nlivrables:\n  - \"[[Boucle/A]]\"\n  - \"[[Boucle/M]]\"\nclient: \"[[Boucle/A]]\"\n---\n# M\n");
    await reindexer();
    const a = await apercu("Boucle/A.md");
    const chemins = a.pages.map((p: any) => p.chemin);
    assert.equal(new Set(chemins).size, chemins.length);
    assert.deepEqual([...chemins].sort(), ["Boucle/A.md", "Boucle/B.md", "Boucle/M.md"]);
    assert.equal(a.taches.filter((t: any) => t.texte === "Tâche de B").length, 1);
    assert.equal(a.taches.filter((t: any) => t.texte === "Tâche de A").length, 1);
    assert.ok(a.sources.some((s: any) => s.doublon));
  });

  test("dossier énorme : 200 pages lues au plus, un niveau d'abord, troncature signalée", async () => {
    for (let i = 0; i < 230; i++) ecrire(`Gros/Niveau1/P${String(i).padStart(3, "0")}.md`, `# P${i}\n\n- [ ] t${i}\n`);
    for (let i = 0; i < 20; i++) ecrire(`Gros/Haut ${i}.md`, `# Haut ${i}\n`);
    ecrire("Fiches/Gros.md", "---\nsources: \"[[Gros/]]\"\n---\n# Gros\n");
    await reindexer();
    const t0 = Date.now();
    const a = await apercu("Fiches/Gros.md");
    assert.ok(Date.now() - t0 < 3000);
    const s = a.sources[0];
    assert.equal(s.etat, "dossier");
    assert.equal(s.pages, 200);
    assert.equal(s.total, 250);
    assert.equal(s.tronque, true);
    assert.equal(a.couverture.tronquee, true);
    // un niveau d'abord : les 20 pages du haut sont toutes lues
    for (let i = 0; i < 20; i++) assert.ok(a.pages.some((p: any) => p.chemin === `Gros/Haut ${i}.md`));
    assert.ok(a.taches.length <= 150);
    assert.ok(a.masques.taches > 0);
  });

  test("plus de 50 entrées dans sources : le reste est ignoré et compté", async () => {
    const l = Array.from({ length: 60 }, (_, i) => `  - "[[Gros/Haut ${i % 20}]]"`).join("\n");
    ecrire("Fiches/Longue.md", `---\nsources:\n${l}\n---\n# Longue\n`);
    await reindexer();
    const a = await apercu("Fiches/Longue.md");
    assert.equal(a.couverture.declarees, 50);
    assert.equal(a.couverture.entreesIgnorees, 10);
  });
});

describe("Markdown conservé inerte", () => {
  test("échappement : ni HTML, ni lien, ni titre venant d'une source", () => {
    assert.equal(echapperMd("<script>x</script>"), "\\<script\\>x\\</script\\>");
    assert.equal(echapperMd("[[Privé/Cachée]]"), "\\[\\[Privé/Cachée\\]\\]");
    assert.equal(echapperMd("## Livrables"), "\\## Livrables");
    assert.equal(echapperMd("1. liste"), "1\\. liste");
    assert.equal(echapperMd("a &amp; b"), "a \\&amp; b");
    assert.equal(codeEnLigne("[[a]]"), "`[[a]]`");
    assert.equal(codeEnLigne("a `b` c"), "``a `b` c``");
  });

  test("rendu : quatre sections et seulement elles ; aucune case à cocher (pas de tâche en double dans Aujourd'hui)", async () => {
    const a = await assembler(b.app.api.preparations.contexte(), FICHE);
    const md = rendreMarkdown(a, "prep-20261011-0812-q7c2");
    const titres = md.split("\n").filter((l) => /^#{1,6} /.test(l));
    assert.deepEqual(titres, ["# Préparation — Atelier Nord", "## Décisions à confirmer", "## Décisions prises", "## Tâches ouvertes", "## Notes récentes", "## Livrables"]);
    // traçabilité repliée en fin de page, sans titre de section
    assert.match(md, /\n<details>\n<summary>Sources et traçabilité<\/summary>\n\n[\s\S]*\n<\/details>\n$/);
    assert.ok(!/^\s*[-*+] \[[ xX/]\]/m.test(md), "aucune ligne de tâche Markdown");
    assert.ok(!md.includes("<b>") && !md.includes(PIEGE));
    assert.ok(!md.includes("Privé") && !md.includes("Cachée"), "ni titre ni chemin d'une zone masquée");
    assert.ok(md.includes("`[[Clients/Atelier Nord/Contrat]]`"));
    const fm = lireFrontmatter(md.slice(4, md.indexOf("\n---\n")));
    assert.ok(fm, "frontmatter YAML valide");
    assert.equal(fm!.type, "preparation");
    assert.equal(fm!.fiche, "[[Clients/Atelier Nord]]");
    assert.ok(Array.isArray(fm!.sources_utilisees));
    const u = (fm!.sources_utilisees as any[]).find((x) => x.page === "[[Clients/Atelier Nord/Compte rendu 03-10]]");
    assert.match(u.revision, /^[0-9a-f]{16}$/);
    assert.match(String(u.modifiee), /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(fm!.sources_manquantes, ["[[Clients/Atelier Nord/Contrat]]"]);
    assert.equal(fm!.sources_non_accessibles, 4);
    assert.match(String(fm!.resume), /^Photographie du \d{2}\/\d{2}\/\d{4} à \d{2}h\d{2} · Contrat introuvable · 4 autres sources inaccessibles$/);
  });
});

describe("B3 et B4 · conserver, rafraîchir, rouvrir après redémarrage", () => {
  let chemin1 = "";
  let contenu1 = "";
  let requete1 = "";
  const conserver = (a: any, id: string, entetes: Record<string, string> = {}) =>
    b.req("POST", "/api/preparation/conserver", { corps: { chemin: a.fiche.chemin, empreinte: a.empreinte, genere: a.genere }, entetes: { "X-Carnet-Requete": id, ...entetes } });

  test("conserver crée une NOUVELLE page dans Préparations/ ; un renvoi identique ne crée pas de doublon", async () => {
    const a = await apercu();
    requete1 = uuid();
    const r1 = await conserver(a, requete1);
    assert.equal(r1.statut, 201, r1.texte);
    chemin1 = r1.json.chemin;
    assert.match(chemin1, /^Préparations\/\d{4}-\d{2}-\d{2} \d{2}h\d{2} Atelier Nord\.md$/);
    contenu1 = fs.readFileSync(disque(chemin1), "utf8");
    assert.match(contenu1, /^---\ntype: preparation\nid: prep-\d{8}-\d{4}-[0-9a-z]{4}\n/);
    assert.ok(contenu1.includes(`cree: ${a.genere}`));
    const r2 = await conserver(a, requete1);
    assert.equal(r2.statut, 200);
    assert.equal(r2.json.rejoue, true);
    assert.equal(r2.json.chemin, chemin1);
    assert.equal(fs.readdirSync(disque("Préparations")).length, 1);
    // même identifiant pour une autre opération : refusé
    const autre = await b.req("POST", "/api/preparation/conserver", { corps: { chemin: "Boucle/A.md", empreinte: a.empreinte, genere: a.genere }, entetes: { "X-Carnet-Requete": requete1 } });
    assert.equal(autre.statut, 409);
    // la préparation conservée n'est pas une fiche : pas de sources
    const g = await b.req("GET", "/api/preparation?chemin=" + q(chemin1));
    assert.equal(g.statut, 422);
  });

  test("protections : X-Carnet, X-Carnet-Requete, empreinte, aperçu trop ancien", async () => {
    const a = await apercu();
    const sansCsrf = await b.req("POST", "/api/preparation/conserver", { corps: { chemin: FICHE, empreinte: a.empreinte, genere: a.genere }, entetes: { "X-Carnet": undefined, "X-Carnet-Requete": uuid() } });
    assert.equal(sansCsrf.statut, 403);
    const sansId = await b.req("POST", "/api/preparation/conserver", { corps: { chemin: FICHE, empreinte: a.empreinte, genere: a.genere } });
    assert.equal(sansId.statut, 400);
    assert.equal(sansId.json.raison, "requete_absente");
    const mauvaise = await conserver({ ...a, empreinte: "sha256:" + "0".repeat(64) }, uuid());
    assert.equal(mauvaise.statut, 409);
    assert.equal(mauvaise.json.raison, "apercu_perime");
    const vieux = await conserver({ ...a, genere: "2026-01-01T08:00:00+01:00" }, uuid());
    assert.equal(vieux.statut, 409);
    const invalide = await conserver({ ...a, genere: "hier" }, uuid());
    assert.equal(invalide.statut, 400);
    const traverse = await b.req("POST", "/api/preparation/conserver", { corps: { chemin: "../x.md", empreinte: a.empreinte, genere: a.genere }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(traverse.statut, 403);
    assert.equal(fs.readdirSync(disque("Préparations")).length, 1);
  });

  test("B3 : une source change ; la préparation conservée reste intacte et apparaît « à rafraîchir » ; régénérer puis conserver = nouvelle photographie", async () => {
    const avant = await b.req("GET", "/api/page?chemin=" + q(chemin1));
    assert.equal(avant.statut, 200);
    assert.equal(avant.json.preparation.aRafraichir, false);
    const ancien = await apercu();
    const cr = "Clients/Atelier Nord/Compte rendu 03-10.md";
    ecrire(cr, fs.readFileSync(disque(cr), "utf8") + "\n- [ ] Nouvelle tâche ajoutée par Sacha 📅 2026-10-14\n");
    await reindexer();
    assert.equal(fs.readFileSync(disque(chemin1), "utf8"), contenu1, "la préparation conservée n'est jamais réécrite");
    const e = await b.req("GET", "/api/preparation/etat?chemin=" + q(chemin1));
    assert.equal(e.statut, 200, e.texte);
    assert.equal(e.json.aRafraichir, true);
    assert.deepEqual(e.json.changements, [{ chemin: cr, titre: "Compte rendu du 03/10", etat: "modifiee" }]);
    const p = await b.req("GET", "/api/page?chemin=" + q(chemin1));
    assert.equal(p.json.preparation.aRafraichir, true);
    // l'ancien aperçu ne peut plus être conservé tel quel
    const perime = await conserver(ancien, uuid());
    assert.equal(perime.statut, 409);
    // régénérer : l'aperçu montre la nouvelle tâche ; conserver : nouvelle page, l'ancienne intacte
    const nouveau = await apercu();
    assert.notEqual(nouveau.empreinte, ancien.empreinte);
    assert.ok(nouveau.taches.some((t: any) => t.texte === "Nouvelle tâche ajoutée par Sacha"));
    const r = await conserver(nouveau, uuid());
    assert.equal(r.statut, 201, r.texte);
    assert.notEqual(r.json.chemin, chemin1);
    assert.equal(fs.readdirSync(disque("Préparations")).length, 2);
    assert.equal(fs.readFileSync(disque(chemin1), "utf8"), contenu1);
    const e2 = await b.req("GET", "/api/preparation/etat?chemin=" + q(r.json.chemin));
    assert.equal(e2.json.aRafraichir, false);
    // une source nouvelle dans la fiche : la première photographie la signale aussi
    ecrire("Clients/Atelier Nord/Réunions/Atelier 2.md", "# Atelier 2\n");
    await reindexer();
    const e3 = await b.req("GET", "/api/preparation/etat?chemin=" + q(r.json.chemin));
    assert.deepEqual(e3.json.changements.map((c: any) => c.etat), ["nouvelle"]);
  });

  test("B4 : après redémarrage, la préparation restitue les mêmes extraits et références depuis son .md ; le renvoi reste sans doublon", async () => {
    const cfg = lireConfig({
      ...process.env, CARNET_ESPACE: b.espace, CARNET_PORT: "0", CARNET_HOTE: "127.0.0.1", CARNET_STATIQUE: path.join(b.racine, "dist"),
      CARNET_UTILISATEURS_AUTORISES: LOGIN, CARNET_ORIGINES_ARTEFACTS: "http://carnet.test=http://art.test", CARNET_CLE: b.cle, CARNET_ETAT: b.etat,
      CARNET_MASQUES: "Privé bruts", CARNET_GIT: "non",
    });
    const app2 = await creerApplication(cfg, { surveiller: false });
    const port2 = await app2.demarrer();
    try {
      const p = await requete(port2, "GET", "/api/page?chemin=" + q(chemin1));
      assert.equal(p.statut, 200);
      assert.equal(p.json.contenu, contenu1);
      // références et révisions relues depuis le fichier
      assert.ok(p.json.contenu.includes("[[Clients/Atelier Nord/Compte rendu 03-10|Compte rendu du 03/10]]"));
      assert.match(p.json.contenu, /rév\. `[0-9a-f]{8}` · modifiée le \d{2}\/\d{2}\/\d{4}/);
      assert.equal(p.json.preparation.fiche, FICHE);
      // le compte rendu a changé depuis (B3) : toujours « à rafraîchir », calculé
      assert.equal(p.json.preparation.aRafraichir, true);
      // renvoi de la toute première opération : même résultat, aucune nouvelle page (idempotence durable)
      const premier = fs.readFileSync(disque(chemin1), "utf8");
      const fm = lireFrontmatter(premier.slice(4, premier.indexOf("\n---\n")))!;
      const r = await requete(port2, "POST", "/api/preparation/conserver", {
        corps: { chemin: FICHE, empreinte: fm.empreinte, genere: fm.cree }, entetes: { "X-Carnet-Requete": requete1 },
      });
      assert.equal(r.statut, 200, r.texte);
      assert.equal(r.json.rejoue, true);
      assert.equal(r.json.chemin, chemin1);
      assert.equal(fs.readdirSync(disque("Préparations")).length, 2);
    } finally {
      await app2.arreter();
    }
  });
});

describe("commentaires HTML des extraits : temps linéaire (page piégée)", () => {
  test("même résultat que l'expression paresseuse sur des cas ordinaires et limites", () => {
    const re = (x: string) => x.replace(/<!--[\s\S]*?-->/g, " ");
    for (const x of ["", "a", "a<!-- b -->c", "<!---->", "<!-->x-->", "<!--->", "a<!--b", "a<!--b-->c<!--d", "x<!--1-->y<!--2-->z",
      "<!-- a\n b -->\nfin", "<!--<!-- -->-->", "--><!--", "<!-- a --> <!-- b"]) {
      assert.equal(sansCommentairesHtml(x), re(x), JSON.stringify(x));
    }
  });
  test("une page pleine de « <!-- » non fermés ne bloque pas le serveur", () => {
    const piege = "<!--".repeat(500_000); // 2 Mo
    const t0 = performance.now();
    assert.equal(sansCommentairesHtml(piege), piege);
    assert.ok(extrait("Texte " + piege, 200).startsWith("Texte"));
    assert.ok(performance.now() - t0 < 2000, "extrait trop lent : " + Math.round(performance.now() - t0) + " ms");
  });
});
