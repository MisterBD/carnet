// Interface flottante de l'éditeur, rendue à part (dans le morceau de l'éditeur, chargé à la demande).
import type { Magasin } from "./magasin";
import type { ContexteEditeur } from "../contexte";
import { MenuSlash } from "./MenuSlash";
import { MenuBloc } from "./MenuBloc";
import { BulleFormat, EditionLien, MenuLangue, BarreTableau } from "./Bulles";

export function InterfaceEditeur({ magasin }: { magasin: Magasin; contexte: ContexteEditeur }) {
  return (
    <>
      <BarreTableau magasin={magasin} />
      <BulleFormat magasin={magasin} />
      <MenuSlash magasin={magasin} />
      <EditionLien magasin={magasin} />
      <MenuLangue magasin={magasin} />
      <MenuBloc magasin={magasin} />
    </>
  );
}
