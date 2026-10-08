// Carnet · service worker. Il met en cache la COQUILLE seulement, jamais le contenu.
//
//   - Navigation (la page demandée) : TOUJOURS le réseau, jamais une copie. Si le réseau manque ou tarde trop
//     (réseau privé coupé), on sert l'écran de repli « Pas de connexion au carnet » (/hors-ligne.html), pas une page
//     périmée, pas une note en cache. Une page de note (/p/…, /f/…) n'est donc jamais lue depuis un cache.
//   - /assets/* : fichiers à empreinte (nom = contenu), figés par construction → cache d'abord, sans risque de périmé.
//   - /polices/*, /icones/*, écran de repli : coquille précachée à l'installation, rafraîchie à chaque nouvelle version.
//   - Tout le reste (API, SSE, images de l'espace, artefacts…) : jamais touché, passe directement au réseau.
//
// Pour changer le cache (nouvelle coquille), incrémenter VERSION : l'ancien cache est supprimé à l'activation.
const VERSION = "v4"; // v4 : écran de repli aux textes configurables (CARNET_RESEAU)
const CACHE_COQUILLE = `carnet-coquille-${VERSION}`;
const CACHE_ASSETS = "carnet-assets"; // noms à empreinte : on le garde d'une version à l'autre, avec un plafond
const MAX_ASSETS = 48;
const DELAI_RESEAU_MS = 5000; // au-delà, on bascule sur l'écran de repli (le réseau ne répond pas : VPN coupé, avion…)
const REPLI = "/hors-ligne.html";
const COQUILLE = [
  REPLI,
  "/hors-ligne.js",
  "/polices/literata-opsz.woff2",
  "/polices/atkinson-next.woff2",
  "/polices/atkinson-next-italique.woff2",
  "/icones/icone-192.png",
  "/icones/apple-touch-icon.png",
];
const FIGES = /^\/assets\//;
const COQUILLE_STATIQUE = /^\/(polices|icones)\//;

self.addEventListener("install", (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE_COQUILLE);
    // cache: "reload" : on veut la version du serveur, pas celle du cache HTTP du navigateur
    await Promise.all(COQUILLE.map(async (u) => {
      const r = await fetch(new Request(u, { cache: "reload" }));
      if (!r.ok) throw new Error(`précache ${u} : ${r.status}`);
      // un fichier absent peut recevoir l'index de l'appli (repli du serveur) : ce n'est pas la coquille attendue
      if (u !== REPLI && (r.headers.get("content-type") || "").includes("text/html")) throw new Error(`précache ${u} : page HTML inattendue`);
      await cache.put(u, r);
    }));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    for (const cle of await caches.keys()) {
      if (cle !== CACHE_COQUILLE && cle !== CACHE_ASSETS) await caches.delete(cle);
    }
    await self.clients.claim();
  })());
});

/** Réponse du réseau, ou rejet si rien n'arrive dans le délai (la requête est alors abandonnée). */
function reseauAvecDelai(requete) {
  return new Promise((resolve, reject) => {
    const ctl = new AbortController();
    const t = setTimeout(() => { ctl.abort(); reject(new Error("délai")); }, DELAI_RESEAU_MS);
    fetch(requete, { signal: ctl.signal }).then(
      (r) => { clearTimeout(t); resolve(r); },
      (err) => { clearTimeout(t); reject(err); },
    );
  });
}

async function repli() {
  const cache = await caches.open(CACHE_COQUILLE);
  const r = await cache.match(REPLI);
  return r || new Response("Pas de connexion au carnet. Vérifie ta connexion, puis réessaie.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

async function navigation(requete) {
  try {
    const r = await reseauAvecDelai(requete);
    // Le serveur (ou le proxy devant lui) répond « indisponible » : même écran clair plutôt qu'une page d'erreur brute.
    if (r.status === 502 || r.status === 503 || r.status === 504) return await repli();
    return r; // jamais mise en cache
  } catch {
    return await repli();
  }
}

async function figee(requete) {
  const cache = await caches.open(CACHE_ASSETS);
  const trouve = await cache.match(requete);
  if (trouve) return trouve;
  const r = await fetch(requete);
  if (r.ok && r.type === "basic") {
    await cache.put(requete, r.clone());
    const cles = await cache.keys();
    for (const k of cles.slice(0, Math.max(0, cles.length - MAX_ASSETS))) await cache.delete(k); // les plus anciens d'abord
  }
  return r;
}

async function coquille(requete) {
  const cache = await caches.open(CACHE_COQUILLE);
  const trouve = await cache.match(requete, { ignoreSearch: true });
  if (trouve) return trouve;
  return fetch(requete);
}

self.addEventListener("fetch", (e) => {
  const requete = e.request;
  if (requete.method !== "GET") return;
  const url = new URL(requete.url);
  if (url.origin !== self.location.origin) return;
  if (requete.mode === "navigate") {
    // Seule la navigation de l'appli elle-même : jamais /api/, /_art/ ni les fichiers de l'espace.
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/_art/")) return;
    e.respondWith(navigation(requete));
    return;
  }
  if (FIGES.test(url.pathname)) { e.respondWith(figee(requete)); return; }
  if (COQUILLE_STATIQUE.test(url.pathname) || url.pathname === "/hors-ligne.js") { e.respondWith(coquille(requete)); return; }
});
