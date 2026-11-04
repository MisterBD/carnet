// Carnet · point d'entrée : `node src/main.ts` (Node 22.18+ retire les types TypeScript à la volée).
import { creerApplication } from "./app.ts";
import { lireConfig } from "./config.ts";
import type { Config } from "./config.ts";
import { journal } from "./http.ts";

let cfg: Config;
try {
  cfg = lireConfig();
} catch (e) {
  process.stderr.write(`Carnet : configuration invalide : ${(e as Error).message}\n`);
  process.exit(2);
}

const t0 = performance.now();
const app = await creerApplication(cfg);
const port = await app.demarrer();
journal({
  niveau: "info",
  quoi: "demarrage",
  ecoute: `${cfg.hote}:${port}`,
  espace: cfg.espace,
  pages: app.espace.pages.size,
  fichiers: app.espace.fichiers.size,
  dossiers: app.espace.dossiers.size,
  surveillants: app.espace.nbSurveillants,
  ms: Math.round(performance.now() - t0),
  dev: cfg.dev,
  origines: cfg.origines.map((o) => `${o.appli}=${o.art}`),
  utilisateurs: [...cfg.utilisateurs],
  entete_identite: cfg.enteteIdentite,
  mentions: cfg.mentions,
  signature: cfg.fichierCle ? "oui" : "non",
});
for (const message of cfg.avertissements) journal({ niveau: "avertissement", quoi: "configuration", message });
if (cfg.dev) journal({ niveau: "avertissement", quoi: `CARNET_DEV=1 : requêtes sans identité (en-tête ${cfg.enteteIdentite}) acceptées` });

let enArret = false;
async function arreter(signal: string): Promise<void> {
  if (enArret) return;
  enArret = true;
  journal({ niveau: "info", quoi: "arret", signal });
  const minuteur = setTimeout(() => process.exit(0), 3000);
  minuteur.unref();
  await app.arreter().catch(() => {});
  process.exit(0);
}
process.on("SIGTERM", () => void arreter("SIGTERM"));
process.on("SIGINT", () => void arreter("SIGINT"));
process.on("unhandledRejection", (e) => journal({ niveau: "erreur", quoi: "promesse_rejetee", erreur: String((e as Error)?.message ?? e) }));
