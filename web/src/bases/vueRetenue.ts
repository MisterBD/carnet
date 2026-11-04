// Carnet · bases (lot 12) : vue à ouvrir en arrivant sur une page (lien « À relancer : N » de l'écran Aujourd'hui).
// État d'interface seulement (sessionStorage, par onglet), jamais dans les fichiers ; tout accès peut échouer
// (navigation privée, stockage bloqué) : sans lui, la base s'ouvre simplement sur sa première vue.

const CLE = "carnet:vue-base:";

export function retenirVueBase(chemin: string, nomVue: string): void {
  try { sessionStorage.setItem(CLE + chemin, nomVue); } catch { /* stockage indisponible */ }
}

/** Nom de vue retenu pour cette page (une page peut avoir plusieurs bases : chacune regarde si la vue est à elle). */
export function vueBaseRetenue(chemin: string): string | null {
  try { return sessionStorage.getItem(CLE + chemin); } catch { return null; }
}

/** La base qui avait cette vue l'a ouverte : on l'oublie (un seul affichage). */
export function oublierVueBase(chemin: string): void {
  try { sessionStorage.removeItem(CLE + chemin); } catch { /* stockage indisponible */ }
}
