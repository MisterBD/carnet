// Carnet · tests de l'historique : vrai dépôt git temporaire (lecture seule, renommages suivis, refus hors espace),
// instantanés hors de l'espace, restauration d'une version, noms de page « piégés » jamais interprétés.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q, sha16 } from "./aide.ts";
import type { Banc } from "./aide.ts";

const PIEGES = ["$(touch pwned).md", "a;touch pwned2.md", "--help.md", "a:b.md", "`id`.md"];

function git(racine: string, args: string[], date?: number): string {
  const env = {
    ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: racine,
    ...(date ? { GIT_AUTHOR_DATE: `${date} +0000`, GIT_COMMITTER_DATE: `${date} +0000` } : {}),
  };
  return execFileSync("git", ["-c", "user.name=Agent Test", "-c", "user.email=agent@test", "-c", "commit.gpgsign=false", ...args], { cwd: racine, env }).toString("utf8");
}

/** Dépôt dans la racine du banc (l'espace en est le sous-dossier « espace/ »). Renvoie les hashs utiles. */
const hashs: Record<string, string> = {};
function preparerDepot(racine: string): void {
  const e = (rel: string, c: string) => {
    const p = path.join(racine, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, c);
  };
  git(racine, ["init", "-q", "-b", "main"]);
  let t = 1_790_000_000;
  const commit = (cle: string, msg: string) => {
    git(racine, ["commit", "-q", "-m", msg], (t += 3600));
    hashs[cle] = git(racine, ["rev-parse", "HEAD"]).trim();
  };
  e("espace/Hist/Page.md", "# Page\n\nversion 1\n");
  git(racine, ["add", "-f", "espace/Hist/Page.md"]);
  commit("v1", "premier jet");
  e("espace/Hist/Page.md", "# Page\n\nversion 2\n");
  git(racine, ["add", "-f", "espace/Hist/Page.md"]);
  commit("v2", "deuxième jet");
  git(racine, ["mv", "espace/Hist/Page.md", "espace/Hist/Renommée.md"]);
  commit("mv", "renommage");
  e("espace/Hist/Renommée.md", "# Page\n\nversion 3\n");
  git(racine, ["add", "-f", "espace/Hist/Renommée.md"]);
  commit("v3", "troisième jet");
  // une page venue d'HORS de l'espace : son ancienne version ne doit jamais être lue
  e("hors/Secret.md", "# Secret hors espace\n");
  git(racine, ["add", "-f", "hors/Secret.md"]);
  commit("hors", "secret");
  git(racine, ["mv", "hors/Secret.md", "espace/Hist/Arrivée.md"]);
  commit("arrivee", "arrivée dans l'espace");
  // une autre page
  e("espace/Hist/Autre.md", "# Autre\n");
  git(racine, ["add", "-f", "espace/Hist/Autre.md"]);
  commit("autre", "autre page");
  // noms piégés
  for (const n of PIEGES) {
    e(`espace/Hist/${n}`, `# ${n}\n\npiège\n`);
    git(racine, ["add", "-f", "--", `espace/Hist/${n}`]);
  }
  commit("pieges", "noms piégés");
}

let b: Banc;
before(async () => { b = await demarrerBanc({ preparer: (racine) => preparerDepot(racine) }); });
after(async () => { await b.fermer(); });

const disque = (rel: string) => path.join(b.espace, rel);
const hist = async (chemin: string) => (await b.req("GET", "/api/historique?chemin=" + q(chemin))).json;
const version = (chemin: string, id: string) => b.req("GET", `/api/version?chemin=${q(chemin)}&id=${q(id)}`);

describe("historique git", () => {
  test("config : git actif ; liste suivie à travers le renommage, plus récent d'abord", async () => {
    assert.deepEqual((await b.req("GET", "/api/config")).json.historique, { git: true });
    const h = await hist("Hist/Renommée.md");
    assert.equal(h.git, true);
    const git = h.versions.filter((v: any) => v.source === "git");
    assert.deepEqual(git.map((v: any) => v.id), ["v3", "mv", "v2", "v1"].map((k) => `git:${hashs[k]}`));
    assert.deepEqual(Object.keys(git[0]).sort(), ["auteur", "date", "id", "message", "source"]);
    assert.equal(git[0].auteur, "Agent Test");
    assert.equal(git[0].message, "troisième jet");
    assert.equal(git[0].date, (1_790_000_000 + 4 * 3600) * 1000);
  });
  test("lecture d'une version, y compris sous l'ancien nom", async () => {
    const r = await version("Hist/Renommée.md", `git:${hashs.v1}`);
    assert.equal(r.statut, 200, r.texte);
    assert.deepEqual(r.json, { id: `git:${hashs.v1}`, date: (1_790_000_000 + 3600) * 1000, contenu: "# Page\n\nversion 1\n" });
    const r3 = await version("Hist/Renommée.md", `git:${hashs.v3}`);
    assert.equal(r3.json.contenu, "# Page\n\nversion 3\n");
  });
  test("refus : hash d'une autre page (404), mal formé (400), id inconnu (400), ancien chemin hors espace (403)", async () => {
    assert.equal((await version("Hist/Renommée.md", `git:${hashs.autre}`)).statut, 404);
    for (const id of ["git:xyz", "git:" + "g".repeat(40), "git:" + hashs.v1 + ":../../hors/Secret.md", "git:HEAD", "git:--help", "inst:../../x", "inst:", "autre", ""]) {
      assert.equal((await version("Hist/Renommée.md", id)).statut, 400, id);
    }
    const h = await hist("Hist/Arrivée.md");
    assert.deepEqual(h.versions.map((v: any) => v.id), [`git:${hashs.arrivee}`, `git:${hashs.hors}`]);
    const dedans = await version("Hist/Arrivée.md", `git:${hashs.arrivee}`);
    assert.equal(dedans.statut, 200);
    const dehors = await version("Hist/Arrivée.md", `git:${hashs.hors}`);
    assert.equal(dehors.statut, 403);
    assert.ok(!dehors.texte.includes("Secret hors espace"));
  });
  test("chemins de page validés : traversée, caché, non .md", async () => {
    for (const c of ["../hors/Secret.md", ".git/config.md", "Hist/../../hors/Secret.md", "Hist/x.txt", "/etc/passwd.md"]) {
      const r = await b.req("GET", "/api/historique?chemin=" + q(c));
      assert.ok(r.statut === 400 || r.statut === 403, `${c} : ${r.statut}`);
    }
  });
  test("noms piégés : jamais interprétés (aucun fichier créé), lecture correcte", async () => {
    for (const n of PIEGES) {
      const h = await hist(`Hist/${n}`);
      assert.equal(h.versions.length, 1, n);
      assert.equal(h.versions[0].id, `git:${hashs.pieges}`);
      const v = await version(`Hist/${n}`, h.versions[0].id);
      assert.equal(v.statut, 200, n);
      assert.equal(v.json.contenu, `# ${n}\n\npiège\n`);
    }
    for (const d of [b.racine, b.espace, path.join(b.espace, "Hist"), process.cwd()]) {
      assert.ok(!fs.existsSync(path.join(d, "pwned")), d);
      assert.ok(!fs.existsSync(path.join(d, "pwned2.md")), d);
    }
  });
  test("page non suivie : liste git vide", async () => {
    const h = await hist("Démo/To-do.md");
    assert.equal(h.git, true);
    assert.deepEqual(h.versions, []);
  });
});

describe("instantanés et restauration", () => {
  test("instantané hors de l'espace (0600/0700), identique = pas de doublon, listé", async () => {
    const r = await b.req("POST", "/api/instantane", { corps: { chemin: "Hist/Renommée.md" } });
    assert.equal(r.statut, 201, r.texte);
    assert.match(r.json.id, /^inst:\d{8}-\d{6}-\d{3}$/);
    assert.equal(r.json.identique, false);
    const r2 = await b.req("POST", "/api/instantane", { corps: { chemin: "Hist/Renommée.md" } });
    assert.equal(r2.json.identique, true);
    assert.equal(r2.json.id, r.json.id);
    const dossier = path.join(b.etat, "instantanes", "espace", "Hist", "Renommée.md");
    const fichiers = fs.readdirSync(dossier);
    assert.equal(fichiers.length, 1);
    assert.equal(fs.statSync(path.join(dossier, fichiers[0])).mode & 0o777, 0o600);
    assert.equal(fs.statSync(dossier).mode & 0o777, 0o700);
    assert.ok(!fs.readdirSync(b.espace).includes("instantanes"));
    const h = await hist("Hist/Renommée.md");
    assert.equal(h.versions[0].source, "instantane");
    assert.equal(h.versions[0].auto, false);
    const v = await version("Hist/Renommée.md", r.json.id);
    assert.equal(v.json.contenu, "# Page\n\nversion 3\n");
    assert.equal((await b.req("POST", "/api/instantane", { corps: { chemin: "Hist/Absente.md" } })).statut, 404);
  });
  test("restaurer : If-Match discordant 412 ; sinon instantané auto puis écriture, SSE/etag cohérents", async () => {
    const lu = await b.req("GET", "/api/page?chemin=" + q("Hist/Renommée.md"));
    const mauvais = await b.req("POST", "/api/restaurer-version", { corps: { chemin: "Hist/Renommée.md", id: `git:${hashs.v1}` }, entetes: { "If-Match": '"0000000000000000"' } });
    assert.equal(mauvais.statut, 412);
    assert.equal(mauvais.json.etag, lu.json.etag);
    // modification locale non commitée, puis restauration
    fs.writeFileSync(disque("Hist/Renommée.md"), "# Page\n\nmodif locale\n");
    const r = await b.req("POST", "/api/restaurer-version", { corps: { chemin: "Hist/Renommée.md", id: `git:${hashs.v1}` } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(fs.readFileSync(disque("Hist/Renommée.md"), "utf8"), "# Page\n\nversion 1\n");
    assert.equal(r.json.etag, sha16("# Page\n\nversion 1\n"));
    assert.match(r.json.instantane, /^inst:\d{8}-\d{6}-\d{3}-auto$/);
    const auto = await version("Hist/Renommée.md", r.json.instantane);
    assert.equal(auto.json.contenu, "# Page\n\nmodif locale\n");
    const h = await hist("Hist/Renommée.md");
    assert.equal(h.versions.find((v: any) => v.id === r.json.instantane).auto, true);
    // le dépôt n'a pas bougé (lecture seule)
    assert.equal(git(b.racine, ["rev-parse", "HEAD"]).trim(), hashs.pieges);
  });
  test("restaurer une page disparue : recréée", async () => {
    fs.unlinkSync(disque("Hist/Autre.md"));
    const r = await b.req("POST", "/api/restaurer-version", { corps: { chemin: "Hist/Autre.md", id: `git:${hashs.autre}` } });
    assert.equal(r.statut, 200, r.texte);
    assert.equal(fs.readFileSync(disque("Hist/Autre.md"), "utf8"), "# Autre\n");
    assert.equal(r.json.instantane, null);
  });
  test("renommer une page : ses instantanés la suivent", async () => {
    fs.writeFileSync(disque("Hist/Suivie.md"), "# Suivie\n");
    await b.app.espace.traiter(["Hist/Suivie.md"]);
    const i = await b.req("POST", "/api/instantane", { corps: { chemin: "Hist/Suivie.md" } });
    const r = await b.req("POST", "/api/renommer", { corps: { chemin: "Hist/Suivie.md", nom: "Suivie ailleurs" } });
    assert.equal(r.statut, 200, r.texte);
    const h = await hist("Hist/Suivie ailleurs.md");
    assert.deepEqual(h.versions.map((v: any) => v.id), [i.json.id]);
    assert.deepEqual((await hist("Hist/Suivie.md")).versions, []);
  });
});

describe("sans git / GIT_DIR explicite", () => {
  test("CARNET_GIT=non : git:false, instantanés seuls", async () => {
    const d = await demarrerBanc({ env: { CARNET_GIT: "non" }, preparer: (racine) => preparerDepot(racine) });
    try {
      const h = (await d.req("GET", "/api/historique?chemin=" + q("Hist/Renommée.md"))).json;
      assert.deepEqual(h, { git: false, versions: [] });
      const r = await d.req("GET", `/api/version?chemin=${q("Hist/Renommée.md")}&id=git:${hashs.v1}`);
      assert.equal(r.statut, 404);
    } finally {
      await d.fermer();
    }
  });
  test("pas de dépôt au-dessus de l'espace : git désactivé sans erreur", async () => {
    const d = await demarrerBanc();
    try {
      assert.deepEqual((await d.req("GET", "/api/config")).json.historique, { git: false });
    } finally {
      await d.fermer();
    }
  });
  test("CARNET_GIT=<dossier .git> + CARNET_GIT_PREFIXE : même historique, mêmes refus", async () => {
    const depot = fs.mkdtempSync(path.join(path.dirname(b.racine), "carnet-depot-"));
    try {
      preparerDepot(depot);
      const d = await demarrerBanc({ env: { CARNET_GIT: path.join(depot, ".git"), CARNET_GIT_PREFIXE: "espace" } });
      try {
        const h = (await d.req("GET", "/api/historique?chemin=" + q("Hist/Renommée.md"))).json;
        assert.equal(h.git, true);
        assert.deepEqual(h.versions.map((v: any) => v.id), ["v3", "mv", "v2", "v1"].map((k) => `git:${hashs[k]}`));
        const v = await d.req("GET", `/api/version?chemin=${q("Hist/Renommée.md")}&id=git:${hashs.v2}`);
        assert.equal(v.json.contenu, "# Page\n\nversion 2\n");
        const dehors = await d.req("GET", `/api/version?chemin=${q("Hist/Arrivée.md")}&id=git:${hashs.hors}`);
        assert.equal(dehors.statut, 403);
      } finally {
        await d.fermer();
      }
    } finally {
      fs.rmSync(depot, { recursive: true, force: true });
    }
  });
  test("CARNET_GIT vers un dossier qui n'est pas un dépôt : désactivé", async () => {
    const d = await demarrerBanc({ env: { CARNET_GIT: "/nonexistent/carnet.git" } });
    try {
      assert.deepEqual((await d.req("GET", "/api/config")).json.historique, { git: false });
    } finally {
      await d.fermer();
    }
  });
});
