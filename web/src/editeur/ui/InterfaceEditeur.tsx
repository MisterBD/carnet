// Interface flottante de l'éditeur, rendue à part (dans le morceau de l'éditeur, chargé à la demande).
import type { Magasin } from "./magasin";
import type { ContexteEditeur } from "../contexte";
import { MenuSlash } from "./MenuSlash";
import { MenuBloc } from "./MenuBloc";
import { BulleFormat, EditionLien, MenuLangue, BarreTableau } from "./Bulles";
import { MenuCollage } from "./MenuCollage";
import { useSyncExternalStore } from "react";

export function InterfaceEditeur({ magasin }: { magasin: Magasin; contexte: ContexteEditeur }) {
  // lot 6 : abonné à la seule « modifiabilité » (pas un rendu de plus à chaque frappe)
  const modifiable = useSyncExternalStore(magasin.abonner, () => magasin.editeur?.isEditable ?? true);
  // lot 6 : page verrouillée (éditeur non modifiable) : ni bulle, ni menu « / », ni menu de bloc, ni barre de tableau
  if (!modifiable) return null;
  return (
    <>
      <BarreTableau magasin={magasin} />
      <BulleFormat magasin={magasin} />
      <MenuSlash magasin={magasin} />
      <EditionLien magasin={magasin} />
      <MenuLangue magasin={magasin} />
      <MenuBloc magasin={magasin} />
      <MenuCollage magasin={magasin} />
    </>
  );
}
