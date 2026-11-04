// Pages ouvertes et leurs enregistrements en attente (lot 4, K2-02 et #9).
//
// Avant de renommer, déplacer, dupliquer ou mettre à la corbeille une page depuis un menu, on « gèle » la page ouverte :
// sa saisie en attente est écrite tout de suite (au bon chemin, avec la bonne version), puis elle ne relit plus le
// disque tant que l'opération n'est pas finie (sinon elle redemande sa page à l'ancien chemin et reçoit un 404).
// Une PageVue s'inscrit ici avec son chemin courant ; le registre ne garde rien d'autre (aucune donnée de page).

export interface PageOuverte {
  /** Chemin courant de la page (change quand la page est renommée sur place). */
  chemin(): string;
  /** Écrit la saisie en attente ; vrai si tout est enregistré. */
  vider(): Promise<boolean>;
  /** Suspend la relecture du disque et les enregistrements ; renvoie la fonction qui les reprend. */
  suspendre(): () => void;
}

const ouvertes = new Set<PageOuverte>();

export function inscrirePage(p: PageOuverte): () => void {
  ouvertes.add(p);
  return () => { ouvertes.delete(p); };
}

/** La page `chemin` ou une de ses sous-pages est-elle concernée par une opération sur `racine` ? */
function concernee(chemin: string, racine: string): boolean {
  const base = racine.replace(/\.md$/i, "");
  return chemin === racine || chemin.startsWith(base + "/");
}

/**
 * Écrit la saisie en attente des pages ouvertes touchées par une opération sur `racine` (la page et ses
 * sous-pages), puis les suspend jusqu'à l'appel de la fonction renvoyée (à appeler dans un `finally`).
 * Une page qui ne peut pas être enregistrée (conflit, panne) le signale elle-même ; l'opération continue.
 */
export async function gelerPages(racine: string): Promise<() => void> {
  const touchees = [...ouvertes].filter((p) => concernee(p.chemin(), racine));
  await Promise.all(touchees.map((p) => p.vider().catch(() => false)));
  const reprises = touchees.map((p) => p.suspendre());
  let fait = false;
  return () => {
    if (fait) return;
    fait = true;
    reprises.forEach((f) => f());
  };
}
