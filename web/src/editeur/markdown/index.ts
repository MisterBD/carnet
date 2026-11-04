// Markdown <-> document de l'éditeur. Point d'entrée unique de la couche Markdown de Carnet.
import type { Node as PMNode, Schema } from "@tiptap/pm/model";
import { analyser } from "./analyse.ts";
import { versDoc, versBlocs, versMdast, blocMd } from "./convertir.ts";
import { serialiser } from "./serialiser.ts";
import type { MNode } from "./mdast.ts";

export { analyser, analyserBrut, COULEURS, GENRES_ENCADRE } from "./analyse.ts";
export { serialiser, desechapperCrochets } from "./serialiser.ts";

/** Fichier Markdown (corps de page) -> document. */
export function mdVersDoc(md: string, schema: Schema): PMNode {
  return versDoc(analyser(md), md, schema);
}

/** Markdown collé -> blocs. */
export function mdVersBlocs(md: string, schema: Schema): PMNode[] {
  return versBlocs(analyser(md), md, schema);
}

/** Document -> Markdown. */
export function docVersMd(doc: PMNode): string {
  return serialiser(versMdast(doc));
}

/** Quelques blocs (copie vers le presse-papiers) -> Markdown. */
export function blocsVersMd(blocs: PMNode[]): string {
  const enfants = blocs.map(blocMd).filter((b): b is MNode => b !== null);
  return serialiser({ type: "root", children: enfants });
}

/** Découpage en blocs de premier niveau, avec positions : sert à la fusion bloc par bloc (fidelite.ts). */
export function analyseurBlocs(md: string): { children: MNode[] } {
  return { children: analyser(md).children ?? [] };
}
