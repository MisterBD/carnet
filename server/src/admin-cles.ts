// Carnet · administration des clés d'accès (hors de l'appli : aucune route HTTP ne crée de code ni ne retire de clé).
//
//   node server/src/admin-cles.ts code [--minutes 30]   crée un code d'enrôlement à usage unique et l'affiche
//   node server/src/admin-cles.ts liste                 liste les clés enregistrées
//   node server/src/admin-cles.ts retirer <début d'id>  retire une clé
//
// Lit CARNET_ETAT et CARNET_NOM_ESPACE (ou CARNET_ESPACE, dont le nom de dossier sert de nom d'espace), comme le serveur.
// Options : --etat <dossier> --espace <nom> pour les remplacer.
import os from "node:os";
import path from "node:path";
import type { Config } from "./config.ts";
import { Cles } from "./cles.ts";

function option(nom: string): string | undefined {
  const i = process.argv.indexOf(nom);
  return i > 0 ? process.argv[i + 1] : undefined;
}

const etat = path.resolve(option("--etat") || process.env.CARNET_ETAT || path.join(os.homedir(), ".local/state/carnet"));
const nomEspace = option("--espace") || process.env.CARNET_NOM_ESPACE || (process.env.CARNET_ESPACE ? path.basename(path.resolve(process.env.CARNET_ESPACE)) : "");
if (!nomEspace) {
  process.stderr.write("Nom d'espace inconnu : renseigne CARNET_NOM_ESPACE, CARNET_ESPACE ou --espace.\n");
  process.exit(2);
}
const cles = new Cles({ etat, nomEspace } as Config);
const commande = process.argv[2];

if (commande === "code") {
  const minutes = Number(option("--minutes") ?? "30");
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    process.stderr.write("--minutes : entier entre 1 et 1440.\n");
    process.exit(2);
  }
  const { code, expire } = await cles.creerCode(minutes);
  process.stdout.write(`Code d'enrôlement (usage unique, valable jusqu'à ${new Date(expire).toLocaleTimeString("fr-FR", { timeZone: "Europe/Paris" })}) : ${code}\n`
    + `Saisis-le dans Carnet > Décisions > Clés d'accès, depuis l'appareil à enregistrer.\n`);
} else if (commande === "liste") {
  const l = await cles.lister();
  if (!l.length) process.stdout.write("Aucune clé d'accès enregistrée.\n");
  for (const c of l) process.stdout.write(`${c.id.slice(0, 12)}  ${c.nom}  (${c.rpId}, créée ${c.cree}${c.utilisee ? `, utilisée ${c.utilisee}` : ""})\n`);
} else if (commande === "retirer" && (process.argv[3] ?? "").length >= 6) {
  const ok = await cles.retirer(process.argv[3]);
  process.stdout.write(ok ? "Clé retirée.\n" : "Aucune clé ne commence par cet identifiant.\n");
  process.exit(ok ? 0 : 1);
} else {
  process.stderr.write("Usage : admin-cles.ts code [--minutes N] | liste | retirer <début d'id>  [--etat DIR] [--espace NOM]\n");
  process.exit(2);
}
