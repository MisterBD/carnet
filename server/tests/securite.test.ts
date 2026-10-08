// Carnet · tests de sécurité : identité, Host, CSRF, en-têtes, traversées, zones interdites, liens symboliques.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { demarrerBanc, q } from "./aide.ts";
import type { Banc } from "./aide.ts";

let b: Banc;
before(async () => { b = await demarrerBanc(); });
after(async () => { await b.fermer(); });

describe("identité (en-tête du proxy)", () => {
  test("sans en-tête Tailscale-User-Login : 403", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined } });
    assert.equal(r.statut, 403);
    assert.match(r.json.erreur, /identité/i);
  });
  test("autre login : 403", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": "intrus@exemple.test" } });
    assert.equal(r.statut, 403);
  });
  test("login vide : 403", async () => {
    const r = await b.req("GET", "/api/arbre", { entetes: { "Tailscale-User-Login": "" } });
    assert.equal(r.statut, 403);
  });
  test("bon login : 200, nom décodé (RFC 2047)", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { "Tailscale-User-Name": "=?utf-8?q?Camille_Fr=C3=A9mont?=" } });
    assert.equal(r.statut, 200);
    assert.deepEqual(r.json.utilisateur, { login: "ami@exemple.test", nom: "Camille Frémont", prenom: null });
    assert.equal(r.json.artBase, "http://art.test");
    assert.equal(r.json.dev, false);
  });
  test("le statique exige aussi l'identité", async () => {
    const r = await b.req("GET", "/", { entetes: { "Tailscale-User-Login": undefined } });
    assert.equal(r.statut, 403);
  });
  test("/sante sans identité ni Host connu : 200 ok", async () => {
    const r = await b.req("GET", "/sante", { entetes: { "Tailscale-User-Login": undefined, Host: "nimporte.quoi" } });
    assert.equal(r.statut, 200);
    assert.equal(r.texte, "ok\n");
  });
  test("CARNET_DEV=1 : sans en-tête accepté, login étranger toujours refusé", async () => {
    // CARNET_DEV=1 n'est accepté qu'avec des origines locales (voir configuration.test.ts)
    const d = await demarrerBanc({ env: { CARNET_DEV: "1", CARNET_ORIGINES_ARTEFACTS: "http://localhost=http://art.test" } });
    try {
      const r = await d.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined, Host: "localhost" } });
      assert.equal(r.statut, 200);
      assert.equal(r.json.dev, true);
      const r2 = await d.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": "intrus@exemple.test", Host: "localhost" } });
      assert.equal(r2.statut, 403);
    } finally {
      await d.fermer();
    }
  });
});

describe("Host (anti DNS-rebinding)", () => {
  test("Host inconnu : 421", async () => {
    for (const h of ["evil.com", "evil.com:80", "carnet.test.evil.com", "127.0.0.1", "[::1]:80", ""]) {
      const r = await b.req("GET", "/api/arbre", { entetes: { Host: h } });
      assert.equal(r.statut, 421, `Host ${h}`);
    }
  });
  test("Host Tailscale avec port : base d'artefacts associée + CSP", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { Host: "carnet.ts.net:8447" } });
    assert.equal(r.statut, 200);
    assert.equal(r.json.artBase, "https://carnet.ts.net:8446");
    assert.match(String(r.entetes["content-security-policy"]), /frame-src 'self' https:\/\/carnet\.ts\.net:8446;/);
  });
  test("Host Tailscale SANS port : accepté (table connaît l'hôte)", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { Host: "carnet.ts.net", "X-Forwarded-Proto": "https" } });
    assert.equal(r.statut, 200);
    assert.equal(r.json.artBase, "https://carnet.ts.net:8446");
  });
  test("Host connu mais mauvais port : 421", async () => {
    const r = await b.req("GET", "/api/config", { entetes: { Host: "carnet.ts.net:8445" } });
    assert.equal(r.statut, 421);
  });
});

describe("anti-CSRF", () => {
  const corps = { parent: "", titre: "Essai CSRF" };
  test("mutation sans X-Carnet : 403", async () => {
    const r = await b.req("POST", "/api/page", { corps, entetes: { "X-Carnet": undefined } });
    assert.equal(r.statut, 403);
    assert.ok(!fs.existsSync(path.join(b.espace, "Essai CSRF.md")));
  });
  test("Origin étranger : 403 ; Origin « null » : 403", async () => {
    for (const o of ["https://evil.com", "null", "http://carnet.test:81"]) {
      const r = await b.req("POST", "/api/page", { corps, entetes: { Origin: o } });
      assert.equal(r.statut, 403, o);
    }
  });
  test("Sec-Fetch-Site cross-site / same-site : 403", async () => {
    for (const s of ["cross-site", "same-site", "none"]) {
      const r = await b.req("POST", "/api/page", { corps, entetes: { "Sec-Fetch-Site": s } });
      assert.equal(r.statut, 403, s);
    }
  });
  test("Origin de l'appli + same-origin : accepté", async () => {
    const r = await b.req("POST", "/api/page", { corps, entetes: { Origin: "http://carnet.test", "Sec-Fetch-Site": "same-origin" } });
    assert.equal(r.statut, 201);
  });
  test("lecture API intersite (Sec-Fetch-Site: cross-site) : 403", async () => {
    const r = await b.req("GET", "/api/page?chemin=" + q("Démo/To-do.md"), { entetes: { "Sec-Fetch-Site": "cross-site" } });
    assert.equal(r.statut, 403);
  });
  test("Content-Type non JSON : 415", async () => {
    const r = await b.req("POST", "/api/page", { brut: Buffer.from("parent=&titre=x"), entetes: { "Content-Type": "application/x-www-form-urlencoded" } });
    assert.equal(r.statut, 415);
  });
  test("OPTIONS / DELETE : 405, jamais d'en-têtes CORS", async () => {
    for (const m of ["OPTIONS", "DELETE", "PATCH"]) {
      const r = await b.req(m, "/api/page?chemin=x.md", { entetes: { Origin: "https://evil.com", "Access-Control-Request-Method": "PUT" } });
      assert.equal(r.statut, 405, m);
      assert.ok(!Object.keys(r.entetes).some((k) => k.startsWith("access-control-")), m);
    }
  });
  test("corps JSON > 2 Mo : 413", async () => {
    const r = await b.req("POST", "/api/page", { brut: Buffer.alloc(3 * 1024 * 1024, 32), entetes: { "Content-Type": "application/json" } });
    assert.equal(r.statut, 413);
  });
});

describe("en-têtes de sécurité", () => {
  test("présents sur API, statique, erreurs ; no-store sur l'API", async () => {
    const reponses = [
      await b.req("GET", "/api/arbre"),
      await b.req("GET", "/"),
      await b.req("GET", "/api/page?chemin=" + q("absente.md")),
      await b.req("GET", "/api/config", { entetes: { "Tailscale-User-Login": undefined } }),
    ];
    for (const r of reponses) {
      const csp = String(r.entetes["content-security-policy"]);
      assert.match(csp, /^default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob: http:\/\/art\.test;/);
      assert.match(csp, /frame-src 'self' http:\/\/art\.test; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'$/);
      assert.equal(r.entetes["x-content-type-options"], "nosniff");
      assert.equal(r.entetes["referrer-policy"], "no-referrer");
      assert.equal(r.entetes["x-frame-options"], "DENY");
      assert.equal(r.entetes["cross-origin-opener-policy"], "same-origin");
      assert.equal(r.entetes["permissions-policy"], "camera=(), microphone=(), geolocation=(), interest-cohort=()");
      assert.ok(!Object.keys(r.entetes).some((k) => k.startsWith("access-control-")));
    }
    assert.equal(reponses[0].entetes["cache-control"], "no-store");
    assert.equal(reponses[2].entetes["cache-control"], "no-store");
  });
  test("statique : assets immuables, sw.js no-cache + Service-Worker-Allowed, repli SPA", async () => {
    const a = await b.req("GET", "/assets/app-abc123.js", { entetes: { "Accept-Encoding": "br, gzip" } });
    assert.equal(a.statut, 200);
    assert.equal(a.entetes["cache-control"], "public, max-age=31536000, immutable");
    assert.equal(a.entetes["content-type"], "text/javascript; charset=utf-8");
    assert.equal(a.entetes["content-encoding"], "br");
    const sw = await b.req("GET", "/sw.js");
    assert.equal(sw.entetes["cache-control"], "no-cache");
    assert.equal(sw.entetes["service-worker-allowed"], "/");
    const m = await b.req("GET", "/manifest.webmanifest");
    assert.equal(m.entetes["content-type"], "application/manifest+json; charset=utf-8");
    const spa = await b.req("GET", "/p/" + q("Démo/Page riche.md"));
    assert.equal(spa.statut, 200);
    assert.equal(spa.entetes["content-type"], "text/html; charset=utf-8");
    assert.equal(spa.entetes["cache-control"], "no-cache");
    const absent = await b.req("GET", "/assets/inexistant.js");
    assert.equal(absent.statut, 404);
    const cache = await b.req("GET", "/.env");
    assert.equal(cache.entetes["content-type"], "text/html; charset=utf-8"); // repli index, jamais un fichier caché
  });
});

describe("chemins : traversées, zones interdites, liens symboliques", () => {
  const lire = (c: string) => b.req("GET", "/api/page?chemin=" + c);
  test("traversées et formes interdites refusées (400/403)", async () => {
    const cas = [
      q("../x.md"), "%2e%2e%2fespace%2fx.md", q("Démo/../../x.md"), q("Démo/./To-do.md"), q("/etc/passwd.md"),
      q("Démo//To-do.md"), q("Démo/To-do.md/"), q(".git/config.md"), q("Démo/.cache.md"), q("a\\b.md"), "a%00b.md",
      q("a\u0001b.md"), q("x".repeat(1100) + ".md"), q(Array(34).fill("a").join("/") + ".md"), q("é".repeat(130) + ".md"),
    ];
    for (const c of cas) {
      const r = await lire(c);
      assert.ok(r.statut === 400 || r.statut === 403, `${decodeURIComponent(c).slice(0, 60)} -> ${r.statut}`);
    }
  });
  test("double encodage : un seul décodage (%252e%252e = nom littéral, introuvable)", async () => {
    const r = await lire("%252e%252e%252fx.md");
    assert.equal(r.statut, 404);
  });
  test("zones interdites : dossiers masqués, artefacts, .corbeille", async () => {
    for (const c of ["bruts/session.md", "artefacts/2026-10-01-tableau-de-bord/index.md", "Privé/Atelier/Coffre.md", ".corbeille/ancienne.md"]) {
      const r = await lire(q(c));
      assert.equal(r.statut, 403, c);
    }
    const put = await b.req("PUT", "/api/page?chemin=" + q("Privé/Nouvelle.md"), { corps: { contenu: "x" }, entetes: { "If-None-Match": "*" } });
    assert.equal(put.statut, 403);
    assert.ok(!fs.existsSync(path.join(b.espace, "Privé/Nouvelle.md")));
  });
  test("liens symboliques : sortants et vers zones interdites refusés, internes lisibles mais en lecture seule", async () => {
    for (const c of ["lien-sortant.md", "lien-git.md", "lien-art.md", "lien-prive.md", "etc-lie/hostname"]) {
      const r = c.endsWith(".md") ? await lire(q(c)) : await b.req("GET", "/api/fichier?chemin=" + q(c));
      assert.equal(r.statut, 403, c);
    }
    const ok = await lire(q("lien-ok.md"));
    assert.equal(ok.statut, 200);
    const viaDossierLie = await lire(q("dossier-lie/To-do.md"));
    assert.equal(viaDossierLie.statut, 200);
    const put = await b.req("PUT", "/api/page?chemin=" + q("lien-ok.md"), { corps: { contenu: "écrasé" }, entetes: { "If-Match": ok.json.etag } });
    assert.equal(put.statut, 403);
    const put2 = await b.req("PUT", "/api/page?chemin=" + q("dossier-lie/Nouvelle.md"), { corps: { contenu: "x" }, entetes: { "If-None-Match": "*" } });
    assert.equal(put2.statut, 403);
    assert.ok(!fs.existsSync(path.join(b.espace, "Démo/Nouvelle.md")));
    const sup = await b.req("POST", "/api/supprimer", { corps: { chemin: "lien-ok.md" } });
    assert.equal(sup.statut, 403);
    assert.equal(fs.readFileSync(path.join(b.espace, "Démo/To-do.md"), "utf8").includes("écrasé"), false);
  });
  test("arbre : rien de caché, d'interdit ni de piégé", async () => {
    const r = await b.req("GET", "/api/arbre");
    assert.equal(r.statut, 200);
    const chemins: string[] = [];
    const parcourir = (l: any[]) => { for (const n of l) { chemins.push(n.chemin); parcourir(n.enfants); } };
    parcourir(r.json.racine);
    for (const interdit of [".git", ".corbeille", "bruts", "artefacts", "Privé", "_assets", "piege.html", "piege.svg", "piege.js", "lien-sortant", "lien-git", "lien-art", "lien-prive", "dossier-lie", "etc-lie"]) {
      assert.ok(!chemins.some((c) => c.split("/").some((s) => s === interdit || s.startsWith(interdit + "."))), interdit);
    }
    assert.ok(chemins.includes("Démo.md"));
    assert.ok(chemins.includes("Démo/Projets/Site web.md"));
    assert.ok(chemins.includes("Dossier seul.md"), "dossier sans page = page virtuelle");
    assert.ok(chemins.includes("inbox/Fournitures.txt"));
    // lien-ok.md -> Démo/To-do.md : lisible par son adresse, mais pas de 2e nœud dans l'arbre (comme CLAUDE.md -> AGENTS.md)
    assert.ok(!JSON.stringify(r.json).includes('"chemin":"lien-ok.md"'));
    assert.ok(chemins.includes("Démo/To-do.md"));
  });
  test("alias (lien symbolique vers une page listée) : ni dans la recherche, ni à l'accueil, ni dans les projets", async () => {
    const rech = await b.req("GET", "/api/recherche?q=" + q("To-do"));
    assert.equal(rech.statut, 200);
    assert.ok(!rech.texte.includes("lien-ok.md"));
    const acc = await b.req("GET", "/api/accueil");
    assert.ok(!acc.texte.includes("lien-ok.md"));
    const proj = await b.req("GET", "/api/projets");
    assert.ok(!proj.texte.includes("lien-ok.md"));
  });
});
