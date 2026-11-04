// Petits utilitaires pour l'arbre Markdown (mdast) : type souple, parcours, tranches de source.
export interface Position { start: { offset?: number; line?: number; column?: number }; end: { offset?: number; line?: number; column?: number } }

export interface MNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MNode[];
  position?: Position;
  data?: Record<string, unknown>;
  [cle: string]: unknown;
}

/** Texte source d'un nœud (ou null si sa position est inconnue). */
export function tranche(src: string, n: MNode): string | null {
  const d = n.position?.start.offset;
  const f = n.position?.end.offset;
  if (d == null || f == null || f < d || f > src.length) return null;
  return src.slice(d, f);
}

/** Texte brut d'un nœud. */
export function texteDe(n: MNode): string {
  if (typeof n.value === "string") return n.value;
  if (n.type === "image") return n.alt ?? "";
  return (n.children ?? []).map(texteDe).join("");
}

/** Parcourt tous les nœuds parents (pour remplacer des enfants). */
export function parcourirParents(arbre: MNode, f: (parent: MNode) => void): void {
  const visiter = (n: MNode) => {
    if (!n.children) return;
    f(n);
    for (const c of n.children) visiter(c);
  };
  visiter(arbre);
}

/** Décale toutes les positions d'un sous-arbre (contenu analysé à part, puis replacé dans la source). */
export function decalerPositions(n: MNode, delta: number): void {
  if (n.position) {
    if (n.position.start.offset != null) n.position.start.offset += delta;
    if (n.position.end.offset != null) n.position.end.offset += delta;
  }
  for (const c of n.children ?? []) decalerPositions(c, delta);
}

/** Retire les positions d'un sous-arbre (contenu dont la source n'est pas contiguë). */
export function oublierPositions(n: MNode): void {
  delete n.position;
  for (const c of n.children ?? []) oublierPositions(c);
}
