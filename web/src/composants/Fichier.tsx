// Fichier non-Markdown de l'espace (PDF, image, texte…) : aperçu des images, téléchargement du reste.
// Rien n'est interprété sur l'origine de l'appli (le serveur sert ces fichiers en pièce jointe).
import { Download } from "lucide-react";
import { useApp, ancetres } from "../contexte-app";
import { urlFichier } from "../api";
import { feuille } from "../../../shared/page.ts";
import { Entete } from "./Entete";
import { IconePage } from "./Icone";

const IMAGES = ["png", "jpg", "jpeg", "webp", "gif", "avif"];

export function FichierVue({ chemin }: { chemin: string }) {
  const app = useApp();
  const ext = (chemin.split(".").pop() ?? "").toLowerCase();
  const nom = chemin.split("/").pop() || chemin;
  const fil = [
    ...ancetres(chemin.replace(/\.[^./]+$/, "") + ".md").map((c) => ({ titre: app.index.get(c)?.titre ?? feuille(c), route: { vue: "page" as const, chemin: c } })),
    { titre: nom },
  ];
  return (
    <>
      <Entete fil={fil} />
      <main className="feuille">
        <div className="tete-page">
          <span className="tete-page__icone" aria-hidden="true"><IconePage fichier ext={ext} taille={40} /></span>
          <h1 className="titre-page" style={{ height: "auto" }}>{nom}</h1>
        </div>
        <div className="apercu-fichier">
          {IMAGES.includes(ext) ? (
            <img src={urlFichier(chemin)} alt={nom} />
          ) : (
            <div className="apercu-fichier__vide">
              <p>Ce fichier ne s'affiche pas dans le carnet ({ext.toUpperCase() || "fichier"}).</p>
              <a className="bouton bouton--primaire" href={urlFichier(chemin)} download style={{ display: "inline-flex", alignItems: "center", gap: 8, textDecoration: "none" }}>
                <Download size={18} /> Télécharger
              </a>
            </div>
          )}
        </div>
      </main>
    </>
  );
}
