// État vide : une icône, une phrase qui dit quoi faire, un bouton. Jamais une page muette.
import type { ReactNode } from "react";

export function EtatVide({ icone, titre, texte, actions, compact = false }: {
  icone?: ReactNode;
  titre: string;
  texte?: ReactNode;
  actions?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div className={compact ? "etat-vide etat-vide--compact" : "etat-vide"}>
      {icone && <div className="etat-vide__icone" aria-hidden="true">{icone}</div>}
      <h2 className="etat-vide__titre">{titre}</h2>
      {texte && <p className="etat-vide__texte">{texte}</p>}
      {actions && <div className="boutons">{actions}</div>}
    </div>
  );
}
