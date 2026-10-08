// Artefact en plein écran, dans un cadre sandbox servi par le serveur d'artefacts (lien signé court via /_art).
import { useEffect, useRef } from "react";
import { X, ExternalLink } from "lucide-react";
import { enregistrerCadre, themeCadres } from "../editeur/cadres";

export function PleinEcran({ chemin, titre, onFermer }: { chemin: string; titre: string; onFermer: () => void }) {
  const cadre = useRef<HTMLIFrameElement>(null);
  const src = "/_art/" + chemin.split("/").map(encodeURIComponent).join("/");
  useEffect(() => {
    const f = (e: KeyboardEvent) => { if (e.key === "Escape") onFermer(); };
    window.addEventListener("keydown", f);
    const html = document.documentElement;
    const avant = html.style.overflow;
    html.style.overflow = "hidden";
    const desinscrire = cadre.current ? enregistrerCadre(cadre.current, () => {}) : () => {};
    return () => { window.removeEventListener("keydown", f); html.style.overflow = avant; desinscrire(); };
  }, [onFermer]);
  return (
    <div className="plein-ecran" role="dialog" aria-modal="true" aria-label={titre}>
      <div className="plein-ecran__tete">
        <h2 className="plein-ecran__titre">{titre}</h2>
        <a className="bouton-icone" href={src} target="_blank" rel="noopener noreferrer" aria-label="Ouvrir dans un onglet" title="Ouvrir dans un onglet">
          <ExternalLink size={19} />
        </a>
        <button type="button" className="bouton-icone" onClick={onFermer} aria-label="Fermer le plein écran">
          <X size={22} />
        </button>
      </div>
      <iframe
        ref={cadre}
        src={src}
        title={titre}
        sandbox="allow-scripts allow-downloads"
        referrerPolicy="no-referrer"
        onLoad={() => cadre.current?.contentWindow?.postMessage({ type: "hote:theme", theme: themeCadres() }, "*")}
      />
    </div>
  );
}
