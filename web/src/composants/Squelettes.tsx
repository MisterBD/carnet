// Squelettes de chargement : ils ont la forme de ce qui arrive (titre, lignes, cartes, rangées d'arbre) pour que la page
// ne saute pas quand le contenu apparaît. Ils n'apparaissent qu'après 120 ms (voir .squelette dans app.css) :
// un chargement instantané ne clignote pas. Réduire les animations les rend fixes.
import type { CSSProperties } from "react";

const L = (largeur: string, hauteur?: number): CSSProperties => ({ width: largeur, ...(hauteur ? { height: hauteur } : {}) });

/** Page de note : titre, résumé, quelques lignes, un bloc. */
export function SquelettePage() {
  return (
    <div className="squelettes" aria-busy="true" aria-label="Chargement de la page" role="status">
      <div className="squelette squelette--titre" />
      <div className="squelette squelette--ligne" style={L("34%")} />
      <div className="squelette squelette--ligne" style={{ ...L("94%"), marginTop: 26 }} />
      <div className="squelette squelette--ligne" style={L("88%")} />
      <div className="squelette squelette--ligne" style={L("91%")} />
      <div className="squelette squelette--carte" style={{ height: 120, marginTop: 24 }} />
      <div className="squelette squelette--ligne" style={L("82%")} />
      <div className="squelette squelette--ligne" style={L("60%")} />
    </div>
  );
}

/** Accueil : salut, deux boutons, deux cartes. */
export function SqueletteAccueil() {
  return (
    <div className="squelettes" aria-busy="true" aria-label="Chargement" role="status" style={{ marginTop: 34 }}>
      <div className="squelette squelette--ligne" style={L("26%")} />
      <div className="squelette squelette--carte" style={{ height: 112 }} />
      <div className="squelette squelette--carte" style={{ height: 112 }} />
      <div className="squelette squelette--ligne" style={{ ...L("32%"), marginTop: 30 }} />
      <div className="squelette squelette--carte" style={{ height: 150 }} />
    </div>
  );
}

/** Liste de lignes (projets, dialogues, résultats). */
export function SqueletteListe({ lignes = 4, hauteur = 52 }: { lignes?: number; hauteur?: number }) {
  return (
    <div className="squelettes" aria-busy="true" aria-label="Chargement" role="status">
      {Array.from({ length: lignes }, (_, i) => <div key={i} className="squelette squelette--carte" style={{ height: hauteur }} />)}
    </div>
  );
}

/** Arbre de pages (barre latérale). */
export function SqueletteArbre({ lignes = 6 }: { lignes?: number }) {
  const largeurs = ["62%", "48%", "70%", "55%", "66%", "44%"];
  return (
    <div className="squelettes" aria-busy="true" aria-label="Chargement des pages" role="status">
      {Array.from({ length: lignes }, (_, i) => <div key={i} className="squelette squelette--rangee" style={{ width: largeurs[i % largeurs.length] }} />)}
    </div>
  );
}
