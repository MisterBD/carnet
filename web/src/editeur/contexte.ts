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
  /** Navigation interne vers une page (nom de page = chemin sans .md), au titre `ancre` s'il est donné ([[Page#Titre]]) ;
   *  nom vide et ancre : titre de la page ouverte ([[#Titre]]). */
  ouvrirPage(nomDePage: string, ancre?: string | null): void;
  /** Titre lisible d'une page (arbre), ou null si inconnue */
  titreDe(nomDePage: string): string | null;
  /** Envoie une image, renvoie l'URL relative à écrire dans le Markdown */
  televerserImage(f: File): Promise<string>;
  /** Demande un titre, crée la sous-page, renvoie son nom de page (ou null si annulé) */
  creerSousPage(): Promise<string | null>;
  /** Lot 3 : demande un titre, crée une demande de décision sous cette page (modèle), renvoie son nom de page */
  creerDecision?(): Promise<string | null>;
  /** Lot 6 : choisit un modèle et un titre, crée la page sous celle-ci, renvoie son nom de page (ou null si annulé) */
  creerDepuisModele?(): Promise<string | null>;
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
  /** Demande un texte (dialogue de l'appli) ; facultatif (V3 lot 2 : nom d'une nouvelle base). */
  demanderTexte?(o: { titre: string; texte?: string; valeur?: string; placeholder?: string; bouton?: string }): Promise<string | null>;
}
