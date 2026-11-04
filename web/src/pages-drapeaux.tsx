// Carnet V3 · lot 6 « Pages » : verrou et archive, deux PROPRIÉTÉS de l'en-tête (`verrou: true`, `archive: true`).
// - Verrou : protection contre les FAUSSES MANIPULATIONS dans Carnet (éditeur, titre, propriétés et collage en lecture
//   seule ; le serveur refuse aussi les routes d'édition, 423). Ce n'est PAS un contrôle d'accès : un agent ou Obsidian
//   peuvent toujours écrire le fichier. Le libellé le dit.
// - Archive : la page sort des listes par défaut (arbre : groupe replié « Archives » ; recherche sauf « Inclure les
//   archives » ; accueil, récents, Aujourd'hui, bases sans filtre explicite) ; le lien direct marche toujours.
// Poser / retirer = POST /api/propriete (une seule ligne de l'en-tête change ; retirer rend le fichier à l'octet).
import { Archive, ArchiveRestore, Lock, LockOpen } from "lucide-react";
import { lireChampSimple } from "../../shared/page.ts";
import { surLienInterne, urlDe } from "./navigation";
import "./styles/pages.css";

export const LIBELLE_VERROU = "Verrouillée contre les fausses manipulations : les agents peuvent toujours écrire le fichier";

export type Drapeau = "verrou" | "archive";

/** Lecture des deux drapeaux dans l'en-tête YAML brut (booléen YAML `true`, comme le serveur). */
export function drapeaux(yaml: string): { verrou: boolean; archive: boolean } {
  const vrai = (cle: string) => /^(true|True|TRUE)$/.test(lireChampSimple(yaml, cle) ?? "");
  return { verrou: vrai("verrou"), archive: vrai("archive") };
}

/** Libellés des gestes (menu « … », bandeaux, notifications). */
export function libelleGeste(cle: Drapeau, poser: boolean): string {
  if (cle === "verrou") return poser ? "Verrouiller la page" : "Déverrouiller";
  return poser ? "Archiver" : "Désarchiver";
}

export function iconeGeste(cle: Drapeau, poser: boolean, taille = 18) {
  if (cle === "verrou") return poser ? <Lock size={taille} /> : <LockOpen size={taille} />;
  return poser ? <Archive size={taille} /> : <ArchiveRestore size={taille} />;
}

export function messageFait(cle: Drapeau, poser: boolean): string {
  if (cle === "verrou") return poser ? "Page verrouillée (les agents peuvent toujours écrire le fichier)" : "Page déverrouillée";
  return poser ? "Page archivée : elle n'apparaît plus dans les listes" : "Page désarchivée";
}

/** Bandeaux en tête d'une page verrouillée et / ou archivée (au-dessus de l'éditeur). */
export function BandeauxPage({ verrou, archive, basculer, occupe, archiveeAvec }: {
  verrou: boolean;
  archive: boolean;
  basculer: (cle: Drapeau, poser: boolean) => void;
  occupe: boolean;
  /** K11-03 (finale V3) : page parente archivée dont cette sous-page suit l'archive (ouverte par lien direct). */
  archiveeAvec?: { chemin: string; titre: string } | null;
}) {
  if (!verrou && !archive && !archiveeAvec) return null;
  return (
    <div className="bandeaux-page">
      {verrou && (
        <div className="bandeau-page bandeau-page--verrou" role="status" data-drapeau="verrou">
          <Lock size={17} aria-hidden="true" />
          <p>{LIBELLE_VERROU}.</p>
          <button type="button" disabled={occupe} onClick={() => basculer("verrou", false)}>Déverrouiller</button>
        </div>
      )}
      {archive && (
        <div className="bandeau-page bandeau-page--archive" role="status" data-drapeau="archive">
          <Archive size={17} aria-hidden="true" />
          <p>Page archivée : absente des listes et de la recherche par défaut, toujours ouverte par son lien.</p>
          <button type="button" disabled={occupe || verrou} title={verrou ? "Déverrouille d'abord la page" : undefined}
            onClick={() => basculer("archive", false)}>Désarchiver</button>
        </div>
      )}
      {!archive && archiveeAvec && (
        <div className="bandeau-page bandeau-page--archive" role="status" data-drapeau="archive-heritee">
          <Archive size={17} aria-hidden="true" />
          <p>
            Archivée avec «{"\u00a0"}{archiveeAvec.titre}{"\u00a0"}» : cette sous-page suit l'archive de sa page parente (absente des
            listes et de la recherche par défaut, toujours ouverte par son lien).
          </p>
          <a className="bouton-lien" href={urlDe({ vue: "page", chemin: archiveeAvec.chemin })}
            onClick={(e) => surLienInterne(e, { vue: "page", chemin: archiveeAvec.chemin })}>Ouvrir «{"\u00a0"}{archiveeAvec.titre}{"\u00a0"}» pour désarchiver</a>
        </div>
      )}
    </div>
  );
}
