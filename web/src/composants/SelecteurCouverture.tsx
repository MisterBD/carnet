// Choix d'une couverture : dégradés maison (aucune image externe) ou image de l'espace (dont un envoi depuis
// l'iPhone, rangé dans `_assets/` à côté de la page). La valeur va dans le frontmatter `cover:`.
import { useEffect, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { api, urlFichier } from "../api";
import { Feuille } from "./Feuille";
import { DEGRADES, type NomDegrade } from "../../../shared/navigation.ts";
import { dossierDe, resoudre } from "../../../shared/page.ts";

export const NOMS_DEGRADES: Record<NomDegrade, string> = {
  ocean: "Océan", aurore: "Aurore", lagon: "Lagon", sable: "Sable", foret: "Forêt", crepuscule: "Crépuscule", ardoise: "Ardoise", corail: "Corail",
};

export function SelecteurCouverture({ chemin, actuelle, onChoisir, onFermer }: {
  chemin: string;
  /** Valeur actuelle de `cover:` (null : aucune). */
  actuelle: string | null;
  onChoisir: (valeur: string | null) => void;
  onFermer: () => void;
}) {
  const [onglet, setOnglet] = useState<"degrades" | "images">(actuelle && !actuelle.startsWith("degrade-") ? "images" : "degrades");
  const [images, setImages] = useState<Array<{ chemin: string; relatif: string }> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [envoi, setEnvoi] = useState(false);
  const fichier = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (onglet !== "images" || images) return;
    api.couvertures(chemin).then((r) => setImages(r.images)).catch((e) => setErreur((e as Error).message));
  }, [onglet, images, chemin]);

  const envoyer = async (f: File | undefined) => {
    if (!f) return;
    setEnvoi(true);
    try {
      const r = await api.televerser(chemin, f);
      onChoisir(decodeURIComponent(r.relatif));
    } catch (e) {
      setErreur(`Image refusée : ${(e as Error).message}`);
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <Feuille titre="Couverture" onFermer={onFermer}>
      <div className="dialogue__corps selecteur-couverture">
        <div className="segments" role="tablist" aria-label="Type de couverture">
          <button type="button" role="tab" aria-selected={onglet === "degrades"} aria-checked={onglet === "degrades"} onClick={() => setOnglet("degrades")}>Dégradés</button>
          <button type="button" role="tab" aria-selected={onglet === "images"} aria-checked={onglet === "images"} onClick={() => setOnglet("images")}>Images</button>
        </div>
        {onglet === "degrades" && (
          <div className="grille-couvertures">
            {DEGRADES.map((d) => (
              <button type="button" key={d} className="vignette-couverture" aria-pressed={actuelle === `degrade-${d}`} onClick={() => onChoisir(`degrade-${d}`)}>
                <span className={`couverture__fond couverture--${d}`} aria-hidden="true" />
                <span className="vignette-couverture__nom">{NOMS_DEGRADES[d]}</span>
              </button>
            ))}
          </div>
        )}
        {onglet === "images" && (
          <>
            {erreur && <p className="dialogue__texte">{erreur}</p>}
            <div className="grille-couvertures">
              <button type="button" className="vignette-couverture vignette-couverture--envoi" disabled={envoi} onClick={() => fichier.current?.click()}>
                <span className="couverture__fond" aria-hidden="true"><ImagePlus size={26} strokeWidth={1.6} /></span>
                <span className="vignette-couverture__nom">{envoi ? "Envoi…" : "Envoyer une image"}</span>
              </button>
              {!images && !erreur && [0, 1, 2].map((i) => <span key={i} className="squelette vignette-couverture" />)}
              {images?.map((im) => (
                <button type="button" key={im.chemin} className="vignette-couverture" aria-pressed={actuelle !== null && resoudre(dossierDe(chemin), actuelle) === im.chemin}
                  onClick={() => onChoisir(decodeURIComponent(im.relatif))} title={im.chemin}>
                  <img className="couverture__fond" src={urlFichier(im.chemin)} alt="" loading="lazy" />
                  <span className="vignette-couverture__nom">{im.chemin.split("/").pop()}</span>
                </button>
              ))}
            </div>
            {images && images.length === 0 && <p className="dialogue__texte">Aucune image dans l'espace pour l'instant : envoies-en une.</p>}
            <input ref={fichier} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden data-sans-focus=""
              onChange={(e) => { void envoyer(e.target.files?.[0]); e.target.value = ""; }} />
          </>
        )}
        {actuelle && (
          <div className="boutons">
            <button type="button" className="bouton" onClick={() => onChoisir(null)}><X size={16} /> Retirer la couverture</button>
          </div>
        )}
      </div>
    </Feuille>
  );
}
