// Carnet · tests de la configuration : utilisateurs autorisés, en-têtes d'identité du proxy, origines des artefacts,
// mode développement, mentions « À relire », dossiers masqués ; anciens noms de variables acceptés comme alias dépréciés.
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { lireConfig, lireLibelle, lireMentions } from "../src/config.ts";
import { analyser } from "../src/markdown.ts";
import { demarrerBanc, LOGIN, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

const MAIN = path.resolve(import.meta.dirname, "../src/main.ts");
let racine: string;
let esp: string;
before(() => {
  racine = fs.mkdtempSync(path.join(os.tmpdir(), "carnet-config-"));
  esp = path.join(racine, "espace");
  fs.mkdirSync(esp);
});
after(() => { fs.rmSync(racine, { recursive: true, force: true }); });

/** Variables minimales d'une configuration valide (espace vide, état hors de l'espace). */
const env = (extra: Record<string, string | undefined> = {}): Record<string, string | undefined> => ({
  CARNET_ESPACE: esp,
  CARNET_ETAT: path.join(racine, "etat"),
  CARNET_UTILISATEURS_AUTORISES: LOGIN,
  ...extra,
});

describe("CARNET_UTILISATEURS_AUTORISES", () => {
  test("identités séparées par des espaces, comparées en minuscules", () => {
    const cfg = lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: "  Ami@Exemple.TEST  autre@exemple.test\tLogin " }));
    assert.deepEqual([...cfg.utilisateurs], ["ami@exemple.test", "autre@exemple.test", "login"]);
    assert.deepEqual(cfg.avertissements, []);
  });
  test("liste vide hors CARNET_DEV : refus de démarrer, message clair avec le nom de l'en-tête", () => {
    for (const v of [undefined, "", "   "]) {
      assert.throws(() => lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: v })), /aucun utilisateur autorisé : renseigne CARNET_UTILISATEURS_AUTORISES.*en-tête Tailscale-User-Login.*CARNET_DEV=1/);
    }
    assert.throws(() => lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: undefined, CARNET_ENTETE_IDENTITE: "X-Forwarded-Email" })), /en-tête X-Forwarded-Email/);
  });
  test("liste vide avec CARNET_DEV=1 : accepté", () => {
    const cfg = lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: undefined, CARNET_DEV: "1" }));
    assert.equal(cfg.utilisateurs.size, 0);
    assert.equal(cfg.dev, true);
  });
  test("ancien nom CARNET_UTILISATEURS : accepté comme alias déprécié, avec avertissement", () => {
    const cfg = lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: undefined, CARNET_UTILISATEURS: "Vieux@Exemple.test" }));
    assert.deepEqual([...cfg.utilisateurs], ["vieux@exemple.test"]);
    assert.equal(cfg.avertissements.length, 1);
    assert.match(cfg.avertissements[0], /CARNET_UTILISATEURS est dépréciée.*CARNET_UTILISATEURS_AUTORISES/);
  });
  test("la variable neuve l'emporte sur l'ancienne (même vide : on ne retombe pas sur l'ancien accès)", () => {
    const cfg = lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: "neuf@exemple.test", CARNET_UTILISATEURS: "vieux@exemple.test" }));
    assert.deepEqual([...cfg.utilisateurs], ["neuf@exemple.test"]);
    assert.match(cfg.avertissements.join("\n"), /CARNET_UTILISATEURS ignorée/);
    assert.throws(() => lireConfig(env({ CARNET_UTILISATEURS_AUTORISES: "", CARNET_UTILISATEURS: "vieux@exemple.test" })), /aucun utilisateur autorisé/);
  });
  test("serveur démarré avec l'ancien nom : l'identité est reconnue, un autre compte est refusé", async () => {
    const d = await demarrerBanc({ env: { CARNET_UTILISATEURS_AUTORISES: undefined, CARNET_UTILISATEURS: LOGIN.toUpperCase() } });
    try {
      assert.equal((await d.req("GET", "/api/config")).statut, 200);
      assert.equal((await d.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": "intrus@exemple.test" } })).statut, 403);
    } finally {
      await d.fermer();
    }
  });
  test("main.ts refuse de démarrer sans utilisateur (code 2, message en français)", () => {
    const r = spawnSync(process.execPath, [MAIN], { env: { PATH: process.env.PATH, HOME: racine, CARNET_ESPACE: esp, CARNET_ETAT: path.join(racine, "etat") }, encoding: "utf8", timeout: 20_000 });
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /Carnet : configuration invalide : aucun utilisateur autorisé/);
  });
});

describe("en-têtes d'identité du proxy (CARNET_ENTETE_IDENTITE, CARNET_ENTETE_NOM)", () => {
  test("défauts : en-têtes de Tailscale Serve", () => {
    const cfg = lireConfig(env());
    assert.equal(cfg.enteteIdentite, "Tailscale-User-Login");
    assert.equal(cfg.enteteNom, "Tailscale-User-Name");
    const vide = lireConfig(env({ CARNET_ENTETE_IDENTITE: "  ", CARNET_ENTETE_NOM: "" }));
    assert.equal(vide.enteteIdentite, "Tailscale-User-Login");
  });
  test("nom d'en-tête invalide : refus de démarrer", () => {
    for (const v of ["X Forwarded", "X:Y", "Identité", "X_Y", "1abc", "-X", "a".repeat(65), "X\r\nY"]) {
      assert.throws(() => lireConfig(env({ CARNET_ENTETE_IDENTITE: v })), /CARNET_ENTETE_IDENTITE : nom d'en-tête HTTP invalide/, JSON.stringify(v));
    }
    assert.throws(() => lireConfig(env({ CARNET_ENTETE_NOM: "Nom Complet" })), /CARNET_ENTETE_NOM : nom d'en-tête HTTP invalide/);
  });
  test("en-tête personnalisé (X-Forwarded-Email) : identité et nom lus dans ces en-têtes, casse ignorée", async () => {
    const d = await demarrerBanc({ env: { CARNET_ENTETE_IDENTITE: "X-Forwarded-Email", CARNET_ENTETE_NOM: "X-Forwarded-Preferred-Username" } });
    try {
      const r = await d.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined, "X-Forwarded-Email": "AMI@Exemple.Test", "X-Forwarded-Preferred-Username": "Camille" } });
      assert.equal(r.statut, 200, r.texte);
      assert.deepEqual(r.json.utilisateur, { login: "AMI@Exemple.Test", nom: "Camille", prenom: null });
      // un autre compte : refusé
      const autre = await d.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined, "X-Forwarded-Email": "intrus@exemple.test" } });
      assert.equal(autre.statut, 403);
      // l'en-tête par défaut n'a plus aucun effet (un client ne peut pas se faire passer pour quelqu'un par ce biais)
      const defaut = await d.req("GET", "/api/config");
      assert.equal(defaut.statut, 403);
      assert.match(defaut.json.erreur, /identité absente \(en-tête X-Forwarded-Email\)/);
      assert.doesNotMatch(defaut.json.erreur, /tailscale/i);
    } finally {
      await d.fermer();
    }
  });
  test("message par défaut : identité absente (en-tête Tailscale-User-Login)", async () => {
    const b = await demarrerBanc();
    try {
      const r = await b.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined } });
      assert.equal(r.statut, 403);
      assert.equal(r.json.erreur, "Accès réservé : identité absente (en-tête Tailscale-User-Login).");
    } finally {
      await b.fermer();
    }
  });
});

describe("CARNET_ORIGINES_ARTEFACTS", () => {
  const table = (cfg: ReturnType<typeof lireConfig>) => cfg.origines.map((o) => `${o.appli}=${o.art}`);
  test("défaut inchangé : 127.0.0.1 et localhost sur le port de l'appli, base http://127.0.0.1:3006", () => {
    assert.deepEqual(table(lireConfig(env({ CARNET_PORT: "3020" }))), ["http://127.0.0.1:3020=http://127.0.0.1:3006", "http://localhost:3020=http://127.0.0.1:3006"]);
    assert.deepEqual(table(lireConfig(env({ CARNET_PORT: "4000" }))), ["http://127.0.0.1:4000=http://127.0.0.1:3006", "http://localhost:4000=http://127.0.0.1:3006"]);
  });
  test("nouveau nom : paires séparées par des espaces, origines normalisées", () => {
    const cfg = lireConfig(env({ CARNET_ORIGINES_ARTEFACTS: "https://Carnet.example.org:443=https://art.example.org http://127.0.0.1:3020=http://127.0.0.1:3006" }));
    assert.deepEqual(table(cfg), ["https://carnet.example.org=https://art.example.org", "http://127.0.0.1:3020=http://127.0.0.1:3006"]);
    assert.deepEqual(cfg.avertissements, []);
  });
  test("ancien nom CARNET_ORIGINES : alias déprécié ; la variable neuve l'emporte", () => {
    const vieux = lireConfig(env({ CARNET_ORIGINES: "http://a.test=http://b.test" }));
    assert.deepEqual(table(vieux), ["http://a.test=http://b.test"]);
    assert.match(vieux.avertissements[0], /CARNET_ORIGINES est dépréciée.*CARNET_ORIGINES_ARTEFACTS/);
    const les2 = lireConfig(env({ CARNET_ORIGINES: "http://a.test=http://b.test", CARNET_ORIGINES_ARTEFACTS: "http://c.test=http://d.test" }));
    assert.deepEqual(table(les2), ["http://c.test=http://d.test"]);
    assert.match(les2.avertissements[0], /CARNET_ORIGINES ignorée/);
  });
  test("erreurs : messages avec le nouveau nom", () => {
    assert.throws(() => lireConfig(env({ CARNET_ORIGINES_ARTEFACTS: "pas-une-paire" })), /CARNET_ORIGINES_ARTEFACTS : paire invalide "pas-une-paire"/);
    assert.throws(() => lireConfig(env({ CARNET_ORIGINES_ARTEFACTS: "http://a.test=http://b.test http://b.test=http://c.test" })), /CARNET_ORIGINES_ARTEFACTS : http:\/\/b\.test est à la fois/);
    assert.throws(() => lireConfig(env({ CARNET_ORIGINES_ARTEFACTS: "" })), /CARNET_ORIGINES_ARTEFACTS vide/);
    assert.throws(() => lireConfig(env({ CARNET_ORIGINES: "oups" })), /CARNET_ORIGINES_ARTEFACTS : paire invalide/);
  });
  test("serveur démarré avec l'ancien nom : la base d'artefacts de l'alias est utilisée", async () => {
    const d = await demarrerBanc({ env: { CARNET_ORIGINES_ARTEFACTS: undefined, CARNET_ORIGINES: "http://carnet.test=http://alias.test" } });
    try {
      const r = await d.req("GET", "/api/config");
      assert.equal(r.json.artBase, "http://alias.test");
    } finally {
      await d.fermer();
    }
  });
  test("main.ts : démarre avec les anciens noms, journalise l'en-tête d'identité et les avertissements", async () => {
    const enfant = spawn(process.execPath, [MAIN], {
      env: {
        PATH: process.env.PATH, HOME: racine, CARNET_JOURNAL: "1", CARNET_ESPACE: esp, CARNET_ETAT: path.join(racine, "etat-main"), CARNET_PORT: "0",
        CARNET_UTILISATEURS: LOGIN, CARNET_ORIGINES: "http://127.0.0.1=http://127.0.0.1:3006", CARNET_ENTETE_IDENTITE: "Remote-User",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let sortie = "";
    let erreurs = "";
    enfant.stdout.on("data", (m: Buffer) => { sortie += m.toString("utf8"); });
    enfant.stderr.on("data", (m: Buffer) => { erreurs += m.toString("utf8"); });
    const fini = new Promise<number | null>((ok) => enfant.on("exit", (c) => ok(c)));
    try {
      const limite = Date.now() + 15_000;
      while (!sortie.includes('"quoi":"demarrage"') && Date.now() < limite) await new Promise((r) => setTimeout(r, 50));
      assert.ok(sortie.includes('"quoi":"demarrage"'), `pas de démarrage : ${sortie} ${erreurs}`);
    } finally {
      enfant.kill("SIGTERM");
    }
    assert.equal(await fini, 0, erreurs);
    const lignes = sortie.trim().split("\n").map((l) => JSON.parse(l));
    const demarrage = lignes.find((l) => l.quoi === "demarrage");
    assert.equal(demarrage.entete_identite, "Remote-User");
    assert.deepEqual(demarrage.utilisateurs, [LOGIN]);
    const avertissements = lignes.filter((l) => l.quoi === "configuration").map((l) => l.message).join("\n");
    assert.match(avertissements, /CARNET_UTILISATEURS est dépréciée/);
    assert.match(avertissements, /CARNET_ORIGINES est dépréciée/);
  });
});

describe("CARNET_DEV=1 : jamais derrière un nom de domaine", () => {
  test("origine appli non locale : refus de démarrer, message clair", () => {
    for (const o of ["http://carnet.test=http://art.test", "https://notes.example.org=https://art.example.org", "http://127.0.0.1:3020=http://127.0.0.1:3006 http://192.168.1.10:3020=http://127.0.0.1:3006"]) {
      assert.throws(
        () => lireConfig(env({ CARNET_DEV: "1", CARNET_ORIGINES_ARTEFACTS: o })),
        /CARNET_DEV=1 refusé : le mode développement n'accepte aucune identité, il ne doit jamais être joint par un nom de domaine ni derrière un proxy.*CARNET_ORIGINES_ARTEFACTS contient l'origine http.*supprime CARNET_DEV ou retire cette origine/,
        o,
      );
    }
  });
  test("origines locales (127.0.0.1, localhost, défaut) : accepté ; hors dev, toute origine reste possible", () => {
    assert.equal(lireConfig(env({ CARNET_DEV: "1" })).dev, true);
    assert.equal(lireConfig(env({ CARNET_DEV: "1", CARNET_ORIGINES_ARTEFACTS: "http://127.0.0.1:3020=http://art.test http://localhost:3020=http://art.test" })).dev, true);
    assert.equal(lireConfig(env({ CARNET_DEV: "0", CARNET_ORIGINES_ARTEFACTS: "https://notes.example.org=https://art.example.org" })).dev, false);
    assert.equal(lireConfig(env({ CARNET_ORIGINES_ARTEFACTS: "https://notes.example.org=https://art.example.org" })).dev, false);
  });
});

describe("CARNET_MENTIONS", () => {
  test("lireMentions : défaut dérivé du prénom (minuscules, sans accents), sinon aucune", () => {
    assert.deepEqual(lireMentions(undefined, ""), []);
    assert.deepEqual(lireMentions(undefined, "Camille"), ["@camille"]);
    assert.deepEqual(lireMentions(undefined, "Élodie"), ["@elodie"]);
    assert.deepEqual(lireMentions(undefined, "Jean Pierre"), ["@jean"]);
    assert.deepEqual(lireMentions(undefined, "!!!"), []);
  });
  test("lireMentions : liste explicite (« @ » facultatif, repliée, sans doublon) ; vide : aucune mention même avec un prénom", () => {
    assert.deepEqual(lireMentions("@Camille @relecture camille @Équipe-1", "Autre"), ["@camille", "@relecture", "@equipe-1"]);
    assert.deepEqual(lireMentions("", "Camille"), []);
    assert.deepEqual(lireMentions("   ", "Camille"), []);
  });
  test("lireMentions : mentions invalides ou trop nombreuses refusées", () => {
    for (const v of ["@a@b", "@camille!", "@", "@-x", "a.b", "@" + "x".repeat(41)]) {
      assert.throws(() => lireMentions(v, ""), /CARNET_MENTIONS : mention invalide/, v);
    }
    assert.throws(() => lireMentions(Array.from({ length: 51 }, (_, i) => "@m" + i).join(" "), ""), /50 mentions au plus/);
  });
  test("lireConfig : mentions dérivées du prénom ou explicites", () => {
    assert.deepEqual(lireConfig(env({ CARNET_PRENOM: " Camille " })).mentions, ["@camille"]);
    assert.deepEqual(lireConfig(env({ CARNET_PRENOM: "Camille", CARNET_MENTIONS: "@relecture @camille" })).mentions, ["@relecture", "@camille"]);
    assert.deepEqual(lireConfig(env()).mentions, []);
    assert.throws(() => lireConfig(env({ CARNET_MENTIONS: "@oups!" })), /CARNET_MENTIONS/);
  });

  test("analyser : insensible à la casse et aux accents, mot entier, hors frontmatter et hors code", () => {
    const m = ["@elodie", "@relecture"];
    const oui = (txt: string, fm = 0) => analyser(txt, fm, m).mention;
    assert.equal(oui("Question pour @Élodie : on valide ?"), true);
    assert.equal(oui("Merci @ELODIE."), true);
    assert.equal(oui("(cc @elodie)"), true);
    assert.equal(oui("à passer en @Relecture"), true);
    assert.equal(oui("Rien ici"), false);
    assert.equal(oui("@elodiette n'est pas @elodie2 ni @elodie_"), false, "mot collé");
    assert.equal(oui("écris à elodie@exemple.test ou x@elodie"), false, "adresse e-mail, mention collée");
    assert.equal(oui("---\nresume: pour @elodie\n---\n# Titre\n", 3), false, "frontmatter");
    assert.equal(oui("# Titre\n```\n@elodie\n```\n~~~\n@relecture\n~~~\n"), false, "bloc de code");
    assert.equal(oui("# Titre\nUn `@elodie` en ligne\n"), false, "code en ligne");
    assert.equal(oui("# Titre\n`code` puis @elodie\n"), true, "après du code en ligne");
  });
  test("analyser : sans mention configurée, jamais de mention (les tâches restent détectées)", () => {
    const a = analyser("# T\n- [ ] Voir @camille\n- [x] Fait\n", 0, []);
    assert.equal(a.mention, false);
    assert.deepEqual(a.taches.map((t) => t.libelle), ["Voir @camille"]);
    assert.equal(analyser("@camille", 0).mention, false);
  });

  /** Page « À relire » : raisons indiquées à l'accueil pour chaque page de Tests/. */
  async function raisons(b: Banc, pages: Record<string, string>): Promise<Record<string, string[]>> {
    fs.mkdirSync(path.join(b.espace, "Tests"), { recursive: true });
    for (const [nom, txt] of Object.entries(pages)) fs.writeFileSync(path.join(b.espace, "Tests", nom), txt);
    await b.app.espace.traiter(["Tests"]);
    const r = await b.req("GET", "/api/accueil");
    assert.equal(r.statut, 200);
    return Object.fromEntries(r.json.aRelire.filter((x: any) => x.chemin.startsWith("Tests/")).map((x: any) => [x.chemin.slice(6), x.raisons]));
  }
  const PAGES = {
    "Elodie.md": "# Élodie\n\nPour @Élodie : à valider.\n",
    "Camille.md": "# Camille\n\nPour @camille : à valider.\n",
    "Relecture.md": "# Relecture\n\nMerci de passer ceci en @relecture.\n",
    "Code.md": "# Code\n\n```\n@elodie @camille @relecture\n```\n",
  };
  test("défaut dérivé de CARNET_PRENOM : @prénom (accents repliés) place la page à relire, pas les autres", async () => {
    const b = await demarrerBanc({ env: { CARNET_MENTIONS: undefined, CARNET_PRENOM: "Élodie" } });
    try {
      assert.deepEqual(b.app.cfg.mentions, ["@elodie"]);
      assert.equal((await b.req("GET", "/api/config")).json.utilisateur.prenom, "Élodie");
      assert.deepEqual(await raisons(b, PAGES), { "Elodie.md": ["mention"] });
    } finally {
      await b.fermer();
    }
  });
  test("plusieurs mentions : chacune place la page à relire", async () => {
    const b = await demarrerBanc({ env: { CARNET_MENTIONS: "@camille @relecture", CARNET_PRENOM: "Élodie" } });
    try {
      assert.deepEqual(await raisons(b, PAGES), { "Camille.md": ["mention"], "Relecture.md": ["mention"] });
      // L'interface reçoit les mentions réelles (pastille « À relire » de l'accueil).
      assert.deepEqual((await b.req("GET", "/api/config")).json.mentions, ["@camille", "@relecture"]);
    } finally {
      await b.fermer();
    }
  });
  test("ni prénom ni mentions : aucune mention (même « @camille »)", async () => {
    const b = await demarrerBanc({ env: { CARNET_MENTIONS: undefined, CARNET_PRENOM: undefined } });
    try {
      assert.deepEqual(b.app.cfg.mentions, []);
      assert.deepEqual(await raisons(b, PAGES), {});
    } finally {
      await b.fermer();
    }
  });
  test("une mention modifiée sur disque est prise en compte au rebalayage", async () => {
    const b = await demarrerBanc();
    try {
      assert.deepEqual(await raisons(b, { "Plus tard.md": "# Plus tard\n\nRien.\n" }), {});
      fs.writeFileSync(path.join(b.espace, "Tests/Plus tard.md"), "# Plus tard\n\nAvis de @Camille\n");
      const ch = await b.app.espace.balayerTout();
      b.app.espace.appliquer(ch);
      assert.deepEqual(await raisons(b, {}), { "Plus tard.md": ["mention"] });
    } finally {
      await b.fermer();
    }
  });
});

describe("CARNET_MASQUES", () => {
  test("défaut vide (aucun dossier propre à un outil particulier) ; noms normalisés en NFC", () => {
    assert.equal(lireConfig(env()).masques.size, 0);
    assert.equal(lireConfig(env({ CARNET_MASQUES: "" })).masques.size, 0);
    assert.deepEqual([...lireConfig(env({ CARNET_MASQUES: "Privé bruts  Archives" })).masques], ["Privé", "bruts", "Archives"]);
  });
  test("sans CARNET_MASQUES : seuls les segments cachés et artefacts/ restent interdits", async () => {
    const b = await demarrerBanc({ env: { CARNET_MASQUES: "" } });
    try {
      assert.equal((await b.req("GET", "/api/page?chemin=" + q("Privé/Cachée.md"))).statut, 200);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q("bruts/session.md"))).statut, 200);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q(".corbeille/ancienne.md"))).statut, 403);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q("artefacts/2026-10-01-tableau-de-bord/index.md"))).statut, 403);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q("Démo/.brouillon.md"))).statut, 403);
      const arbre = (await b.req("GET", "/api/arbre")).texte;
      assert.ok(arbre.includes('"chemin":"Privé/Cachée.md"'));
    } finally {
      await b.fermer();
    }
  });
  test("avec CARNET_MASQUES : dossiers de premier niveau seulement (un homonyme plus profond reste lisible)", async () => {
    const b = await demarrerBanc();
    try {
      fs.mkdirSync(path.join(b.espace, "Démo/bruts"));
      fs.writeFileSync(path.join(b.espace, "Démo/bruts/x.md"), "# x\n");
      await b.app.espace.traiter(["Démo"]);
      assert.equal((await b.req("GET", "/api/page?chemin=" + q("Démo/bruts/x.md"))).statut, 200);
      for (const c of ["bruts/session.md", "Privé/Cachée.md", "Privé/Atelier/Coffre.md"]) {
        const r = await b.req("GET", "/api/page?chemin=" + q(c));
        assert.equal(r.statut, 403, c);
      }
      // un titre qui reprend un dossier masqué reçoit un suffixe (la page homonyme serait inaccessible)
      const p = await b.req("POST", "/api/page", { corps: { parent: "", titre: "Privé" } });
      assert.equal(p.statut, 201);
      assert.equal(p.json.chemin, "Privé 2.md");
    } finally {
      await b.fermer();
    }
  });
});

describe("CARNET_RESEAU, CARNET_CONTACT (textes des écrans hors ligne et d'erreur)", () => {
  test("défaut vide : textes génériques (null dans /api/config)", async () => {
    const cfg = lireConfig(env());
    assert.equal(cfg.reseau, "");
    assert.equal(cfg.contact, "");
    const b = await demarrerBanc({ env: { CARNET_RESEAU: undefined, CARNET_CONTACT: undefined } });
    try {
      const c = (await b.req("GET", "/api/config")).json;
      assert.equal(c.reseau, null);
      assert.equal(c.contact, null);
    } finally {
      await b.fermer();
    }
  });
  test("libellés courts acceptés et renvoyés tels quels", async () => {
    assert.equal(lireLibelle(" Tailscale ", "X"), "Tailscale");
    assert.equal(lireLibelle("l'équipe IT", "X"), "l'équipe IT");
    const b = await demarrerBanc({ env: { CARNET_RESEAU: "WireGuard", CARNET_CONTACT: "Camille" } });
    try {
      const c = (await b.req("GET", "/api/config")).json;
      assert.equal(c.reseau, "WireGuard");
      assert.equal(c.contact, "Camille");
    } finally {
      await b.fermer();
    }
  });
  test("balisage, guillemets, trop long : refus de démarrer", () => {
    for (const v of ["<b>x</b>", "a\"b", "x".repeat(41), "-tiret", "nom;rm"]) {
      assert.throws(() => lireConfig(env({ CARNET_RESEAU: v })), /CARNET_RESEAU : libellé court attendu/, v);
      assert.throws(() => lireConfig(env({ CARNET_CONTACT: v })), /CARNET_CONTACT : libellé court attendu/, v);
    }
  });
});
