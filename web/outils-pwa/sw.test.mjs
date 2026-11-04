// Tests du service worker (public/sw.js) dans un bac à sable Node : mêmes événements, faux caches, faux réseau.
//   node --test web/outils-pwa/sw.test.mjs
// Propriétés vérifiées : la navigation vient TOUJOURS du réseau (jamais d'un cache), le repli sert l'écran hors ligne,
// aucune note ni API n'entre dans un cache, les fichiers à empreinte sont figés avec un plafond, l'ancien cache disparaît.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import path from "node:path";

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, "../public/sw.js"), "utf8");
const ORIGINE = "https://carnet.test";

class FauxCache {
  map = new Map();
  cle(req, ignoreSearch) { const u = new URL(typeof req === "string" ? req : req.url, ORIGINE); if (ignoreSearch) u.search = ""; return u.href; }
  async match(req, opts = {}) {
    const k = this.cle(req, opts.ignoreSearch);
    for (const [kk, v] of this.map) if (this.cle(kk, opts.ignoreSearch) === k) return v.clone();
    return undefined;
  }
  async put(req, res) { this.map.set(this.cle(req), res.clone()); }
  async keys() { return [...this.map.keys()].map((u) => ({ url: u })); }
  async delete(req) { return this.map.delete(typeof req === "string" ? req : req.url); }
}
class FauxCaches {
  noms = new Map();
  async open(n) { if (!this.noms.has(n)) this.noms.set(n, new FauxCache()); return this.noms.get(n); }
  async keys() { return [...this.noms.keys()]; }
  async delete(n) { return this.noms.delete(n); }
}

/** Charge sw.js dans un bac à sable et renvoie de quoi lui envoyer des événements. */
function monter({ reseau }) {
  const gestionnaires = {};
  const caches = new FauxCaches();
  const appels = [];
  const ctx = {
    self: { location: { origin: ORIGINE, href: ORIGINE + "/sw.js" }, addEventListener: (t, f) => { gestionnaires[t] = f; }, skipWaiting: async () => {}, clients: { claim: async () => {} } },
    caches, URL, Request: class extends Request { constructor(u, i) { super(new URL(u, ORIGINE).href, i); } }, Response, AbortController, Promise, Error, Math, console,
    // le délai de 5 s du service worker devient 20 ms dans les tests
    setTimeout: (f, ms) => setTimeout(f, ms >= 1000 ? 20 : ms), clearTimeout,
    fetch: async (req, init) => { const u = typeof req === "string" ? req : req.url; appels.push(new URL(u, ORIGINE).pathname);
      const r = await reseau(new URL(u, ORIGINE).pathname, init);
      Object.defineProperty(r, "type", { value: "basic" }); // une réponse de même origine, comme sur le vrai réseau
      return r; },
  };
  vm.createContext(ctx);
  vm.runInContext(SOURCE, ctx);
  const evenement = (type, extra = {}) => {
    let promesse;
    const e = { ...extra, waitUntil: (p) => { promesse = p; }, respondWith: (p) => { promesse = Promise.resolve(p); e.repondu = true; } };
    gestionnaires[type](e);
    return { e, fin: promesse };
  };
  const requete = (chemin, { mode = "cors", method = "GET", origine = ORIGINE } = {}) => ({ url: origine + chemin, method, mode });
  return { caches, appels, evenement, requete };
}

const FICHIERS = (chemin) => {
  if (chemin === "/hors-ligne.html") return new Response("<h1>Pas de connexion au carnet</h1>", { headers: { "content-type": "text/html" } });
  if (/^\/(hors-ligne\.js|polices|icones)\//.test(chemin) || chemin === "/hors-ligne.js") return new Response("x", { headers: { "content-type": "application/octet-stream" } });
  return null;
};

async function installer(m) { await m.evenement("install").fin; await m.evenement("activate").fin; }

test("navigation en ligne : la réponse vient du réseau et n'entre dans aucun cache", async () => {
  const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response("<html>version du serveur</html>", { status: 200 }) });
  await installer(m);
  const { e, fin } = m.evenement("fetch", { request: m.requete("/p/D%C3%A9mo/Note", { mode: "navigate" }) });
  assert.equal(e.repondu, true);
  assert.equal(await (await fin).text(), "<html>version du serveur</html>");
  for (const [, cache] of m.caches.noms) for (const k of await cache.keys()) assert.ok(!k.url.includes("/p/"), `page de note en cache : ${k.url}`);
});

test("la page est toujours redemandée au réseau : deux navigations = deux requêtes, la seconde voit la nouvelle version", async () => {
  let version = "v1";
  const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response(`<html>${version}</html>`) });
  await installer(m);
  const nav = () => m.evenement("fetch", { request: m.requete("/", { mode: "navigate" }) }).fin;
  assert.equal(await (await nav()).text(), "<html>v1</html>");
  version = "v2";
  assert.equal(await (await nav()).text(), "<html>v2</html>");
  assert.equal(m.appels.filter((c) => c === "/").length, 2);
});

test("réseau coupé : écran hors ligne, jamais une page périmée", async () => {
  let coupe = false;
  const m = monter({ reseau: (c) => { if (coupe && !FICHIERS(c)) throw new TypeError("Failed to fetch"); return FICHIERS(c) ?? new Response("<html>note</html>"); } });
  await installer(m);
  await m.evenement("fetch", { request: m.requete("/p/Note", { mode: "navigate" }) }).fin; // une visite réussie avant la coupure
  coupe = true;
  const r = await m.evenement("fetch", { request: m.requete("/p/Note", { mode: "navigate" }) }).fin;
  const texte = await r.text();
  assert.match(texte, /Pas de connexion au carnet/);
  assert.doesNotMatch(texte, /note<\/html>/);
});

test("réseau qui ne répond pas (Tailscale coupé, paquets perdus) : repli après le délai", async () => {
  const m = monter({ reseau: (c, init) => FICHIERS(c) ?? new Promise((_, rejet) => init?.signal?.addEventListener("abort", () => rejet(new DOMException("aborted", "AbortError")))) });
  await installer(m);
  const r = await m.evenement("fetch", { request: m.requete("/", { mode: "navigate" }) }).fin;
  assert.match(await r.text(), /Pas de connexion au carnet/);
});

test("serveur indisponible (502, 503, 504 de tailscale serve) : même écran de repli", async () => {
  for (const statut of [502, 503, 504]) {
    const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response("Bad Gateway", { status: statut }) });
    await installer(m);
    const r = await m.evenement("fetch", { request: m.requete("/", { mode: "navigate" }) }).fin;
    assert.match(await r.text(), /Pas de connexion au carnet/, `statut ${statut}`);
  }
});

test("erreurs applicatives (403, 404, 500) : passent telles quelles, pas masquées par le repli", async () => {
  for (const statut of [403, 404, 500]) {
    const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response("corps serveur", { status: statut }) });
    await installer(m);
    const r = await m.evenement("fetch", { request: m.requete("/", { mode: "navigate" }) }).fin;
    assert.equal(r.status, statut);
    assert.equal(await r.text(), "corps serveur");
  }
});

test("API, flux, artefacts, fichiers de l'espace, mutations, autres origines : jamais interceptés", async () => {
  const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response("x") });
  await installer(m);
  const cas = [
    m.requete("/api/arbre"), m.requete("/api/page?chemin=a.md"), m.requete("/api/evenements"), m.requete("/api/fichier?chemin=a.png"),
    m.requete("/_art/x", { mode: "navigate" }), m.requete("/api/fichier?chemin=a.pdf", { mode: "navigate" }), m.requete("/p/Note"),
    m.requete("/api/page?chemin=a.md", { method: "PUT" }), m.requete("/", { mode: "navigate", method: "POST" }),
    m.requete("/assets/x.js", { origine: "https://autre.test" }), m.requete("/sante"),
  ];
  for (const requete of cas) assert.equal(m.evenement("fetch", { request: requete }).e.repondu, undefined, `intercepté : ${requete.method} ${requete.url}`);
});

test("fichiers à empreinte : cache d'abord, plafond de 48 entrées, jamais une erreur en cache", async () => {
  const m = monter({ reseau: (c) => FICHIERS(c) ?? (c === "/assets/absent.js" ? new Response("non", { status: 404 }) : new Response("// " + c)) });
  await installer(m);
  const lire = (c) => m.evenement("fetch", { request: m.requete(c) }).fin;
  await lire("/assets/a.js"); const avant = m.appels.length; await lire("/assets/a.js");
  assert.equal(m.appels.length, avant, "le second appel doit venir du cache");
  await lire("/assets/absent.js");
  const assets = await m.caches.open("carnet-assets");
  assert.ok(!(await assets.keys()).some((k) => k.url.endsWith("absent.js")), "une 404 ne doit pas être mise en cache");
  for (let i = 0; i < 70; i++) await lire(`/assets/f${i}.js`);
  assert.ok((await assets.keys()).length <= 48, `${(await assets.keys()).length} entrées`);
});

test("activation : l'ancien cache (carnet-statique-v2) est supprimé", async () => {
  const m = monter({ reseau: (c) => FICHIERS(c) ?? new Response("x") });
  await m.caches.open("carnet-statique-v2");
  await installer(m);
  assert.ok(!(await m.caches.keys()).includes("carnet-statique-v2"));
  assert.ok((await m.caches.keys()).some((n) => n.startsWith("carnet-coquille-")));
});

test("installation : échoue si un fichier de la coquille manque (pas de coquille bancale)", async () => {
  const m = monter({ reseau: (c) => (c === "/hors-ligne.html" ? new Response("", { status: 404 }) : FICHIERS(c) ?? new Response("x")) });
  await assert.rejects(m.evenement("install").fin);
});

test("installation : un fichier de la coquille remplacé par l'index de l'appli (repli du serveur) est refusé", async () => {
  const m = monter({ reseau: (c) => (c === "/polices/literata-opsz.woff2" ? new Response("<!doctype html>", { headers: { "content-type": "text/html" } }) : FICHIERS(c) ?? new Response("x")) });
  await assert.rejects(m.evenement("install").fin, /HTML inattendue/);
});
