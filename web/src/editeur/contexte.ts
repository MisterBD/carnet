// Ce que l'éditeur d'une page sait de l'application (fourni par PageVue, une instance par page ouverte).
export interface ContexteEditeur {
  /** Chemin de la page ouverte, relatif à l'espace, avec .md */
  chemin: string;
  /** Dossier de la page (pour résoudre les liens relatifs) */
  dossier: string;
  /** Origine qui sert les artefacts et les rendus isolés (serveur d'artefacts) */
  artBase: string;
  /** URL d'affichage d'un fichier de l'espace référencé depuis la page (images) */
  urlFichier(url: string): string;
  /** Navigation interne vers une page (nom de page = chemin sans .md) */
  ouvrirPage(nomDePage: string): void;
  /** Titre lisible d'une page (arbre), ou null si inconnue */
  titreDe(nomDePage: string): string | null;
  /** Envoie une image, renvoie l'URL relative à écrire dans le Markdown */
  televerserImage(f: File): Promise<string>;
  /** Demande un titre, crée la sous-page, renvoie son nom de page (ou null si annulé) */
  creerSousPage(): Promise<string | null>;
  /** Choisir une page existante à lier */
  choisirPage(): Promise<string | null>;
  /** Choisir un artefact existant (chemin relatif à artefacts/) */
  choisirArtefact(): Promise<{ chemin: string; titre: string } | null>;
  /** Ouvre un artefact en plein écran */
  pleinEcranArtefact(cheminArtefact: string, titre: string): void;
  /** Thème courant */
  theme(): "clair" | "sombre";
  /** Petit message (toast) de l'appli */
  notifier(message: string): void;
}
