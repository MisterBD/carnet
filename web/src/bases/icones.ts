// Carnet · bases : icône de chaque type de propriété (Lucide, ISC).
import { Calendar, CheckSquare, ChevronsUpDown, CircleDot, Hash, List, Type } from "lucide-react";
import type { TypePropriete } from "../../../shared/bases.ts";

export const ICONES_TYPES: Record<TypePropriete, typeof Type> = {
  texte: Type, nombre: Hash, case: CheckSquare, date: Calendar, statut: CircleDot, selection: ChevronsUpDown, liste: List,
};
