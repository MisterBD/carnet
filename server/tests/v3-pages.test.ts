// Carnet · tests du lot 6 « Pages » (V3) : modèles (remplacement littéral, YAML valide, modèle intact, création unique),
// journal du jour idempotent (fuseau), verrou (routes d'édition refusées, déverrouillage explicite, seul le drapeau
// change), archive (hors des listes par défaut, retrouvable explicitement, lien direct, seul le drapeau change).
import "../src/analyseur-yaml.ts";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import YAML from "yaml";
import { appliquerModele, heureDe, remplacerVariables } from "../../shared/modeles.ts";
import { dateDuJour, RE_IDENTIFIANT } from "../../shared/identifiants.ts";
import { ErreurFormat } from "../../shared/proprietes.ts";
import { decouper } from "../../shared/page.ts";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

const uuid = () => crypto.randomUUID();
const V = { date: "2026-10-11", heure: "08h05", titre: `Réunion : « Budget » d'été "v2"` };
const yamlDe = (c: string) => YAML.parse(decouper(c).yaml);

describe("modèles : application des variables", () => {
  test("remplacement littéral en une passe, variables inconnues conservées", () => {
    const r = remplacerVariables("{{titre}} · {{date}} {{heure}} · {{inconnue}} {{ titre }} {{title}} {{Date}}", { ...V, titre: "$& {{date}} $1" });
    assert.equal(r, "$& {{date}} $1 · 2026-10-11 08h05 · {{inconnue}} {{ titre }} {{title}} {{Date}}");
    assert.equal(heureDe("2026-10-11T08:05:59+02:00"), "08h05");
  });

  test("en-tête : titre avec guillemets, deux-points et accents → YAML valide, reste à l'octet", () => {
    const modele = [
      "---",
      "title: \"{{titre}}\"",
      "nu: {{titre}} — compte rendu   # commentaire gardé",
      "cree: {{date}}",
      "note: texte {{inconnue}}",
      "liste:",
      "  - \"[[Clients/{{titre}}/]]\"",
      "  - fixe",
      "imbrique:",
      "  sous: \"{{titre}}\"",
      "# {{titre}} dans un commentaire",
      "---",
      "# {{titre}}",
      "",
      "Le {{date}} à {{heure}}. {{inconnue}} {{ titre }}",
      "",
    ].join("\n");
    const r = appliquerModele(modele, V);
    const fm = yamlDe(r);
    assert.equal(fm.title, V.titre);
    assert.equal(fm.nu, `${V.titre} — compte rendu`);
    assert.equal(String(fm.cree), "2026-10-11");
    assert.equal(fm.note, "texte {{inconnue}}");
    assert.deepEqual(fm.liste, [`[[Clients/${V.titre}/]]`, "fixe"]);
    assert.deepEqual(fm.imbrique, { sous: "{{titre}}" }, "objet imbriqué : variable laissée telle quelle");
    assert.match(r, /\n# \{\{titre\}\} dans un commentaire\n/);
    assert.match(r, /# commentaire gardé\n/);
    const d = decouper(r);
    assert.equal(r.slice(d.frontmatter.length), `# ${V.titre}\n\nLe 2026-10-11 à 08h05. {{inconnue}} {{ titre }}\n`);
    // le modèle n'a pas bougé (fonction pure) et rejouer donne le même résultat
    assert.equal(appliquerModele(modele, V), r);
  });

  test("sans en-tête ou sans variable dans l'en-tête : texte seul remplacé ; en-tête invalide refusé", () => {
    assert.equal(appliquerModele("# {{titre}}\n", V), `# ${V.titre}\n`);
    assert.equal(appliquerModele("---\na: 1\n---\n{{date}}\n", V), "---\na: 1\n---\n2026-10-11\n");
    assert.throws(() => appliquerModele("---\ntitle: \"{{titre}}\"\n  : x: [\n---\n", V), ErreurFormat);
    assert.throws(() => appliquerModele("---\ntitle: \"{{titre}}\"\ntitle: double\n---\n", V), ErreurFormat);
  });
});

describe("routes du lot 6", () => {
  let b: Banc;
  const lire = (rel: string) => fs.readFileSync(path.join(b.espace, rel), "utf8");
  const existe = (rel: string) => fs.existsSync(path.join(b.espace, rel));
  const ecrire = async (rel: string, txt: string) => {
    fs.mkdirSync(path.dirname(path.join(b.espace, rel)), { recursive: true });
    fs.writeFileSync(path.join(b.espace, rel), txt);
    await b.app.espace.traiter([rel, path.dirname(rel)]);
  };
  const MODELE_CR = "---\ntitle: \"{{titre}}\"\ncree: {{date}}\n---\n# {{titre}}\n\nLe {{date}} à {{heure}}. {{inconnue}}\n";
  before(async () => {
    b = await demarrerBanc({
      preparer: (_r, espace) => {
        const w = (rel: string, t: string) => { fs.mkdirSync(path.dirname(path.join(espace, rel)), { recursive: true }); fs.writeFileSync(path.join(espace, rel), t); };
        w("Modèles/Compte rendu.md", MODELE_CR);
        w("Modèles/Décision.md", "---\ntype: decision\nid: \"\"\nstatut: en attente\ndemandee_par: \"\"\ncree: \"\"\n---\n\n# {{titre}}\n\n## Proposition\n\n- Objet : essai\n");
        w("Modèles/Cassé.md", "---\ntitle: \"{{titre}}\"\ntitle: deux fois\n---\n# x\n");
        w("Modèles/Journal.md", "---\ntype: journal\n---\n# {{titre}}\n\n## Notes\n");
        w("Lot6/Page.md", "# Page\n\n- [ ] Tâche lot6 visible 📅 2026-10-12\n\nTexte cherchable zebrelune.\n");
        w("Lot6/Nue.md", "Juste du texte sans en-tête zebrelune.\n");
        w("Lot6/Base.md", "# Base\n\n```base\nfilters:\n  and:\n    - file.inFolder(\"Lot6\")\nviews:\n  - type: table\n    name: Tout\n```\n");
        w("Lot6/BaseArchives.md", "# Base archives\n\n```base\nfilters:\n  and:\n    - file.inFolder(\"Lot6\")\n    - archive == true\nviews:\n  - type: table\n    name: Archives\n```\n");
      },
    });
  });
  after(async () => { await b.fermer(); });

  test("GET /api/modeles : pages du dossier Modèles/, triées, sans rien écrire", async () => {
    const r = await b.req("GET", "/api/modeles");
    assert.equal(r.statut, 200, r.texte);
    assert.equal(r.json.dossier, "Modèles");
    // titre « # {{titre}} » : le modèle s'appelle par son nom de fichier ; « Cassé » a pour titre « deux fois »
    assert.deepEqual(r.json.modeles.map((m: { titre: string }) => m.titre), ["Compte rendu", "Décision", "deux fois", "Journal"]);
    assert.deepEqual(r.json.modeles.map((m: { chemin: string }) => m.chemin),
      ["Modèles/Compte rendu.md", "Modèles/Décision.md", "Modèles/Cassé.md", "Modèles/Journal.md"]);
  });

  test("POST /api/page/modele : fichier unique par creerUnique, variables, YAML valide, modèle intact, idempotent", async () => {
    const titre = V.titre;
    const id = uuid();
    const r = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(r.statut, 201, r.texte);
    assert.equal(r.json.chemin, "Réunion « Budget » d'été v2.md");
    const c = lire(r.json.chemin);
    const fm = yamlDe(c);
    assert.equal(fm.title, titre);
    assert.equal(String(fm.cree), dateDuJour("Europe/Paris"));
    assert.match(c, new RegExp(`\\n# ${titre.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\nLe \\d{4}-\\d\\d-\\d\\d à \\d\\dh\\d\\d\\. \\{\\{inconnue\\}\\}\\n$`));
    assert.equal(lire("Modèles/Compte rendu.md"), MODELE_CR, "modèle intact");
    // même geste rejoué : même page, rien de plus
    const bis = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre }, entetes: { "X-Carnet-Requete": id } });
    assert.equal(bis.statut, 200, bis.texte);
    assert.equal(bis.json.rejoue, true);
    assert.equal(bis.json.chemin, r.json.chemin);
    // nouveau geste, même titre : nouveau fichier, jamais d'écrasement
    const r2 = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r2.statut, 201, r2.texte);
    assert.equal(r2.json.chemin, "Réunion « Budget » d'été v2 (2).md");
    assert.equal(lire(r.json.chemin), c);
    // sous une page parente
    const r3 = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre: "Point lundi", parent: "Lot6/Page.md" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r3.statut, 201, r3.texte);
    assert.equal(r3.json.chemin, "Lot6/Page/Point lundi.md");
  });

  test("modèle « Décision » : identifiant neuf au format du lot 3, demande listée ; le modèle n'est pas une décision", async () => {
    const r = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Décision.md", titre: "Choisir un outil" }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(r.statut, 201, r.texte);
    const fm = yamlDe(lire(r.json.chemin));
    assert.match(String(fm.id), RE_IDENTIFIANT);
    assert.ok(String(fm.id).startsWith("dec-"));
    assert.ok(fm.cree && fm.demandee_par);
    const l = await b.req("GET", "/api/decisions");
    assert.equal(l.statut, 200, l.texte);
    const chemins = (l.json.demandes ?? l.json.decisions ?? l.json).map?.((d: { chemin: string }) => d.chemin) ?? JSON.stringify(l.json);
    assert.ok(String(chemins).includes(r.json.chemin), String(chemins));
    assert.ok(!String(chemins).includes("Modèles/"), String(chemins));
  });

  test("refus : pas un modèle, chemin hors espace, modèle absent ou invalide, titre vide, parent absent, sans X-Carnet", async () => {
    const essais: [unknown, number][] = [
      [{ modele: "Lot6/Page.md", titre: "x" }, 400],
      [{ modele: "../Modèles/Compte rendu.md", titre: "x" }, 400],
      [{ modele: "Modèles/../../etc/passwd.md", titre: "x" }, 400],
      [{ modele: "Modèles/Absent.md", titre: "x" }, 404],
      [{ modele: "Modèles/Cassé.md", titre: "x" }, 422],
      [{ modele: "Modèles/Compte rendu.md", titre: "  \n " }, 400],
      [{ modele: "Modèles/Compte rendu.md", titre: "x", parent: "Nulle/Part.md" }, 404],
    ];
    for (const [corps, statut] of essais) {
      const r = await b.req("POST", "/api/page/modele", { corps, entetes: { "X-Carnet-Requete": uuid() } });
      assert.ok(r.statut === statut || (statut === 400 && r.statut === 403), `${JSON.stringify(corps)} → ${r.statut} ${r.texte}`);
    }
    assert.ok(!existe("x.md"));
    const sans = await b.req("POST", "/api/page/modele", { corps: { modele: "Modèles/Compte rendu.md", titre: "y" }, entetes: { "X-Carnet": undefined } });
    assert.equal(sans.statut, 403);
    assert.ok(!existe("y.md"));
  });

  test("journal du jour : une seule page Journal/AAAA-MM-JJ.md (Europe/Paris), depuis Modèles/Journal.md, jamais réappliqué", async () => {
    const jour = dateDuJour("Europe/Paris");
    const [a, c] = await Promise.all([
      b.req("POST", "/api/journal", { corps: {}, entetes: { "X-Carnet-Requete": uuid() } }),
      b.req("POST", "/api/journal", { corps: {}, entetes: { "X-Carnet-Requete": uuid() } }),
    ]);
    assert.deepEqual([a.statut, c.statut].sort(), [200, 201], a.texte + c.texte);
    assert.equal(a.json.chemin, `Journal/${jour}.md`);
    assert.equal(c.json.chemin, a.json.chemin);
    assert.equal(lire(a.json.chemin), `---\ntype: journal\n---\n# ${jour}\n\n## Notes\n`);
    assert.deepEqual(fs.readdirSync(path.join(b.espace, "Journal")), [`${jour}.md`]);
    // une note ajoutée, puis second appui : rien n'est réappliqué ni écrasé
    await ecrire(a.json.chemin, lire(a.json.chemin) + "\nMa note.\n");
    const avant = lire(a.json.chemin);
    const d = await b.req("POST", "/api/journal", { corps: {}, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(d.statut, 200, d.texte);
    assert.equal(d.json.cree, false);
    assert.equal(lire(a.json.chemin), avant);
  });

  test("verrou : seul `verrou: true` change ; page, tâche, méta, propriété, titre, restauration refusés (423) ; déverrouillage explicite à l'octet", async () => {
    const rel = "Lot6/Nue.md";
    const original = lire(rel);
    const lu = await b.req("GET", "/api/page?chemin=" + q(rel));
    const v = await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "verrou", valeur: true }, entetes: { "If-Match": lu.json.etag, "X-Carnet-Requete": uuid() } });
    assert.equal(v.statut, 200, v.texte);
    const verrouille = lire(rel);
    assert.equal(verrouille, "---\nverrou: true\n---\n" + original);
    const etag = v.json.etag;
    const refus = [
      await b.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu: "écrasé\n" }, entetes: { "If-Match": etag } }),
      await b.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu: "écrasé\n", ecraser: true }, entetes: { "If-Match": etag } }),
      await b.req("POST", "/api/meta", { corps: { chemin: rel, champs: { statut: "x" } } }),
      await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "statut", valeur: "x" }, entetes: { "If-Match": etag, "X-Carnet-Requete": uuid() } }),
      await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "archive", valeur: true }, entetes: { "If-Match": etag, "X-Carnet-Requete": uuid() } }),
      await b.req("POST", "/api/renommer", { corps: { chemin: rel, titre: "Autre titre" } }),
    ];
    for (const r of refus) {
      assert.equal(r.statut, 423, r.texte);
      assert.equal(r.json.raison, "page_verrouillee", r.texte);
    }
    assert.match(refus[0].json.erreur ?? refus[0].json.message ?? refus[0].texte, /agents peuvent toujours écrire/);
    // tâche d'une page verrouillée
    await ecrire("Lot6/Tache.md", "---\nverrou: true\n---\n- [ ] coche-moi\n");
    const t = await b.req("POST", "/api/tache", { corps: { chemin: "Lot6/Tache.md", ligne: 3, texte: "- [ ] coche-moi", coche: true }, entetes: { "X-Carnet-Requete": uuid() } });
    assert.equal(t.statut, 423, t.texte);
    assert.equal(lire("Lot6/Tache.md"), "---\nverrou: true\n---\n- [ ] coche-moi\n");
    assert.equal(lire(rel), verrouille, "rien d'écrit");
    assert.ok(existe(rel));
    // déverrouiller : retour à l'octet (l'en-tête vide créé par le verrou disparaît)
    const d = await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "verrou", retirer: true }, entetes: { "If-Match": etag, "X-Carnet-Requete": uuid() } });
    assert.equal(d.statut, 200, d.texte);
    assert.equal(lire(rel), original);
    const ok = await b.req("PUT", "/api/page?chemin=" + q(rel), { corps: { contenu: original + "Ajout.\n" }, entetes: { "If-Match": d.json.etag } });
    assert.equal(ok.statut, 200, ok.texte);
    await ecrire(rel, original);
  });

  test("verrou : un en-tête existant ne change que d'une ligne ; un agent peut toujours écrire le fichier (pas une ACL)", async () => {
    await ecrire("Lot6/AvecEnTete.md", "---\ntitle: Garde # commentaire\ntags: [a, b]\n---\n# Garde\n\nCorps.\n");
    const lu = await b.req("GET", "/api/page?chemin=" + q("Lot6/AvecEnTete.md"));
    const v = await b.req("POST", "/api/propriete", { corps: { chemin: "Lot6/AvecEnTete.md", cle: "verrou", valeur: true }, entetes: { "If-Match": lu.json.etag, "X-Carnet-Requete": uuid() } });
    assert.equal(v.statut, 200, v.texte);
    assert.equal(lire("Lot6/AvecEnTete.md"), "---\ntitle: Garde # commentaire\ntags: [a, b]\nverrou: true\n---\n# Garde\n\nCorps.\n");
    await ecrire("Lot6/AvecEnTete.md", "---\ntitle: Garde\nverrou: true\n---\nÉcrit par un agent.\n");
    assert.equal(lire("Lot6/AvecEnTete.md"), "---\ntitle: Garde\nverrou: true\n---\nÉcrit par un agent.\n");
  });

  test("archive : seul `archive: true` change ; absente des listes par défaut, retrouvable explicitement et par lien direct ; désarchivage", async () => {
    const rel = "Lot6/Page.md";
    const original = lire(rel);
    const cherche = async (archives: boolean) => (await b.req("GET", `/api/recherche?q=zebrelune${archives ? "&archives=1" : ""}`)).json.resultats as { chemin: string; archive?: boolean }[];
    await ecrire("Lot6/Page/Enfant.md", "# Enfant\n\nAussi zebrelune.\n");
    assert.ok((await cherche(false)).some((x) => x.chemin === rel));
    assert.ok((await cherche(false)).some((x) => x.chemin === "Lot6/Page/Enfant.md"));
    const lu = await b.req("GET", "/api/page?chemin=" + q(rel));
    const a = await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "archive", valeur: true }, entetes: { "If-Match": lu.json.etag, "X-Carnet-Requete": uuid() } });
    assert.equal(a.statut, 200, a.texte);
    assert.equal(lire(rel), "---\narchive: true\n---\n" + original);
    // recherche normale : absente ; avec « Inclure les archives » : présente et marquée
    assert.ok(!(await cherche(false)).some((x) => x.chemin === rel));
    assert.ok(!(await cherche(false)).some((x) => x.chemin === "Lot6/Page/Enfant.md"), "sous-page d'une page archivée : rangée avec elle");
    assert.equal((await cherche(true)).find((x) => x.chemin === "Lot6/Page/Enfant.md")?.archive, true);
    const avec = (await cherche(true)).find((x) => x.chemin === rel);
    assert.ok(avec && avec.archive === true);
    // lien direct
    const direct = await b.req("GET", "/api/page?chemin=" + q(rel));
    assert.equal(direct.statut, 200);
    // arbre : nœud marqué (l'interface le range dans « Archives »)
    const arbre = (await b.req("GET", "/api/arbre")).json;
    const trouve = (l: any[]): any => l.map((n) => (n.chemin === rel ? n : trouve(n.enfants))).find(Boolean);
    assert.equal(trouve(arbre.racine)?.archive, true);
    // accueil, aujourd'hui (tâches et récents), projets, bases
    const acc = (await b.req("GET", "/api/accueil")).json;
    assert.ok(!JSON.stringify(acc).includes("Lot6/Page.md"));
    const auj = (await b.req("GET", "/api/aujourdhui")).json;
    assert.ok(!JSON.stringify(auj).includes("Tâche lot6 visible"), "tâche d'une page archivée hors d'Aujourd'hui");
    assert.ok(!JSON.stringify(auj.recents).includes(rel));
    const base = (await b.req("GET", "/api/base?chemin=" + q("Lot6/Base.md") + "&bloc=0")).json;
    assert.ok(!JSON.stringify(base.lignes).includes(rel), "base sans filtre explicite : page archivée absente");
    const baseA = (await b.req("GET", "/api/base?chemin=" + q("Lot6/BaseArchives.md") + "&bloc=0")).json;
    assert.ok(JSON.stringify(baseA.lignes).includes(rel), "filtre explicite `archive == true` : présente " + JSON.stringify(baseA).slice(0, 300));
    // désarchiver : retour à l'octet, visible de nouveau
    const d = await b.req("POST", "/api/propriete", { corps: { chemin: rel, cle: "archive", retirer: true }, entetes: { "If-Match": a.json.etag, "X-Carnet-Requete": uuid() } });
    assert.equal(d.statut, 200, d.texte);
    assert.equal(lire(rel), original);
    assert.ok((await cherche(false)).some((x) => x.chemin === rel));
    assert.ok(JSON.stringify((await b.req("GET", "/api/aujourdhui")).json).includes("Tâche lot6 visible"));
  });

  test("archive dans Missions et Dossier de rendez-vous : mission archivée absente ; page archivée d'un dossier source non reprise", async () => {
    await ecrire("Lot6M/Mission vive.md", "---\ntype: mission\netat: en cours\nclient: \"[[Lot6M/Fiche]]\"\n---\n# Mission vive\n");
    await ecrire("Lot6M/Mission rangée.md", "---\ntype: mission\netat: en cours\narchive: true\nclient: \"[[Lot6M/Fiche]]\"\n---\n# Mission rangée\n");
    await ecrire("Modèles/Mission.md", "---\ntype: mission\netat: à faire\n---\n# {{titre}}\n");
    await ecrire("Lot6M/Notes/Visible.md", "# Visible\n\nNote vivante.\n");
    await ecrire("Lot6M/Notes/Rangée.md", "---\narchive: true\n---\n# Rangée\n\nNote archivée.\n");
    await ecrire("Lot6M/Fiche.md", "---\ntype: client\nsources:\n  - \"[[Lot6M/Notes/]]\"\n---\n# Fiche\n");
    const m = await b.req("GET", "/api/missions");
    assert.equal(m.statut, 200, m.texte);
    const chemins = m.json.missions.map((x: { chemin: string }) => x.chemin);
    assert.ok(chemins.includes("Lot6M/Mission vive.md"), JSON.stringify(chemins));
    assert.ok(!chemins.includes("Lot6M/Mission rangée.md"));
    assert.ok(!chemins.includes("Modèles/Mission.md"));
    const p = await b.req("GET", "/api/preparation?chemin=" + q("Lot6M/Fiche.md"));
    assert.equal(p.statut, 200, p.texte);
    const texte = JSON.stringify(p.json);
    assert.ok(texte.includes("Lot6M/Notes/Visible.md"), texte.slice(0, 400));
    assert.ok(!texte.includes("Lot6M/Notes/Rangée.md"), "page archivée d'un dossier source");
    assert.ok(texte.includes("Mission vive") && !texte.includes("Mission rangée"), "missions rattachées sans les archivées");
  });

  test("modèles hors des listes vivantes : leurs tâches ne sont pas dans Aujourd'hui", async () => {
    await ecrire("Modèles/Avec tâche.md", "# {{titre}}\n\n- [ ] tâche de modèle 📅 {{date}}\n");
    const auj = (await b.req("GET", "/api/aujourdhui")).json;
    assert.ok(!JSON.stringify(auj).includes("tâche de modèle"));
    assert.ok((await b.req("GET", "/api/recherche?q=tache%20de%20modele")).json.resultats.length >= 1, "toujours trouvable par la recherche");
    assert.equal(sha16(lire("Modèles/Avec tâche.md")), sha16("# {{titre}}\n\n- [ ] tâche de modèle 📅 {{date}}\n"));
  });
});
