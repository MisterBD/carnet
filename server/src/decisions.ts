// Carnet · preuve d'une décision : objet CALCULÉ par le serveur, renvoyé par GET /api/page HORS du contenu
// Markdown, pour toute page `type: decision`. Le Markdown d'une décision n'est qu'une DÉCLARATION ; seule une attestation
// valide (server/src/attestations.ts) dont l'empreinte est celle de la proposition ACTUELLE vaut preuve du geste.
// Et même alors : une attestation de décision n'est PAS une autorisation d'exécution ; l'outil qui exécute une action
// engageante vérifie lui-même la preuve au moment d'agir.
//
// Méthode d'empreinte par défaut « socle-v1 » (le lot 3 peut la remplacer par definirCalculDecision, en la documentant
// dans docs/format-agents.md) :
//   demande = propriété `id` ; statut déclaré = propriété `statut` ;
//   proposition = lignes qui suivent le titre `## Proposition` jusqu'au titre suivant de niveau 1 ou 2 (hors blocs de
//   code), fins de ligne « \n », espaces de fin de ligne retirés, lignes vides de début et de fin retirées ;
//   empreinte = « sha256: » + SHA-256 hexadécimal du texte UTF-8 ainsi obtenu.
import { decouper, lireChampSimple, plier, sansBlancsFinaux } from "../../shared/page.ts";
import { marquerCode } from "../../shared/taches.ts";
import type { Attestations, EtatPreuve, Geste } from "./attestations.ts";
import { sha256 } from "./journal-ecritures.ts";

export interface PreuveDecision {
  etat: EtatPreuve;
  /** Identifiant de la demande (propriété `id`). */
  demande: string | null;
  /** Empreinte de la proposition ACTUELLE (méthode `methode`). */
  empreinte: string | null;
  /** Résultat ATTESTÉ par la dernière attestation valide (jamais celui déclaré dans le Markdown). */
  resultat: string | null;
  portee: string | null;
  attestationId: string | null;
  /** « cle-d-acces » = geste prouvé (WebAuthn, lot 3) ; « identite-seule » = geste NON prouvé. */
  geste: Geste | null;
  /** Le `statut` déclaré dans le fichier correspond-il au résultat attesté ? (null sans attestation) */
  declarationConforme: boolean | null;
  methode: string;
}

export interface ElementsDecision {
  demande: string | null;
  empreinte: string | null;
  statut: string | null;
}

export type CalculDecision = (contenu: string) => ElementsDecision;

const RE_TITRE = /^ {0,3}(#{1,6})[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

/** Texte normalisé de la section « ## Proposition » (null si absente). */
export function sectionProposition(contenu: string): string | null {
  const lignes = decouper(contenu).corps.replace(/\r\n/g, "\n").split("\n");
  const code = marquerCode(lignes);
  let debut = -1;
  let fin = lignes.length;
  for (let i = 0; i < lignes.length; i++) {
    if (code[i]) continue;
    const m = RE_TITRE.exec(lignes[i]);
    if (!m) continue;
    if (debut === -1) {
      if (m[1].length === 2 && plier(m[2].trim()) === "proposition") debut = i + 1;
    } else if (m[1].length <= 2) {
      fin = i;
      break;
    }
  }
  if (debut === -1) return null;
  const section = lignes.slice(debut, fin).map(sansBlancsFinaux);
  while (section.length && section[0] === "") section.shift();
  while (section.length && section[section.length - 1] === "") section.pop();
  return section.join("\n");
}

export function calculParDefaut(contenu: string): ElementsDecision {
  const yaml = decouper(contenu).yaml;
  const section = sectionProposition(contenu);
  return {
    demande: lireChampSimple(yaml, "id") ?? null,
    empreinte: section === null || section === "" ? null : "sha256:" + sha256(section),
    statut: lireChampSimple(yaml, "statut") ?? null,
  };
}

let calcul: { methode: string; f: CalculDecision } = { methode: "socle-v1", f: calculParDefaut };

/** Remplace la méthode d'empreinte (lot 3). `methode` est renvoyé dans preuveDecision. */
export function definirCalculDecision(methode: string, f: CalculDecision): void {
  calcul = { methode, f };
}

export function elementsDecision(contenu: string): ElementsDecision & { methode: string } {
  return { ...calcul.f(contenu), methode: calcul.methode };
}

export function estDecision(contenu: string): boolean {
  const t = lireChampSimple(decouper(contenu).yaml, "type");
  return t !== undefined && plier(t).trim() === "decision";
}

/** Preuve calculée d'une page `type: decision` (null pour une autre page). */
export async function preuveDecision(attestations: Attestations, contenu: string): Promise<PreuveDecision | null> {
  if (!estDecision(contenu)) return null;
  const e = elementsDecision(contenu);
  const vide: PreuveDecision = {
    etat: "indeterminee", demande: e.demande, empreinte: e.empreinte, resultat: null, portee: null, attestationId: null, geste: null,
    declarationConforme: null, methode: e.methode,
  };
  if (!e.demande || !e.empreinte) return vide; // format incomplet : rien ne peut être prouvé
  const { etat, attestation } = await attestations.etat(e.demande, e.empreinte);
  if (!attestation) return { ...vide, etat };
  return {
    etat, demande: e.demande, empreinte: e.empreinte, resultat: attestation.resultat, portee: attestation.portee, attestationId: attestation.id,
    geste: attestation.geste, declarationConforme: e.statut === null ? false : plier(e.statut).trim() === plier(attestation.resultat).trim(), methode: e.methode,
  };
}
