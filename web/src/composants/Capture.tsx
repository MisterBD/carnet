// Lot 1 : feuille de capture (＋ de la barre d'onglets, ⌘⇧N, bouton « Capturer »). Texte et lien facultatif, titre
// facultatif ; un seul geste pour enregistrer (bouton, Entrée dans un champ d'une ligne, ⌘/Ctrl + Entrée partout).
// La capture part dans la boîte de réception (une page par capture). Le lien est enregistré, jamais ouvert ni récupéré.
// Brouillon gardé dans ce navigateur (avec l'identifiant du geste) : une réponse perdue puis un renvoi, même après un
// rechargement, ne crée jamais de seconde capture (le serveur reconnaît l'identifiant).
import { useEffect, useRef, useState } from "react";
import { Inbox, Link2 } from "lucide-react";
import { api, nouvelleRequete, ErreurApi } from "../api";
import { Feuille } from "./Feuille";

const CLE_BROUILLON = "carnet:capture:brouillon";

interface Brouillon { texte: string; lien: string; titre: string; requete: string; empreinte: string }

function lireBrouillon(): Brouillon | null {
  try {
    const v = JSON.parse(localStorage.getItem(CLE_BROUILLON) ?? "null") as Brouillon | null;
    return v && typeof v.texte === "string" && typeof v.requete === "string" ? v : null;
  } catch {
    return null;
  }
}

function ecrireBrouillon(b: Brouillon | null): void {
  try {
    if (b && (b.texte || b.lien || b.titre)) localStorage.setItem(CLE_BROUILLON, JSON.stringify(b));
    else localStorage.removeItem(CLE_BROUILLON);
  } catch { /* navigation privée */ }
}

/** « exemple.org/x » → « https://exemple.org/x » ; null si ce n'est pas une adresse web. */
export function normaliserLien(brut: string): string | null {
  let l = brut.trim();
  if (!l) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(l) && /^[\w-]+(\.[\w-]+)+([/?#].*)?$/u.test(l)) l = "https://" + l;
  if (/\s/.test(l) || l.length > 2048) return null;
  try {
    const u = new URL(l);
    return u.protocol === "http:" || u.protocol === "https:" ? l : null;
  } catch {
    return null;
  }
}

const empreinteDe = (texte: string, lien: string, titre: string) => JSON.stringify([texte, lien.trim(), titre.trim()]);

export function FeuilleCapture({ dossier, onFermer, onEnregistree }: {
  dossier: string;
  onFermer: () => void;
  onEnregistree: (r: { chemin: string; titre: string }) => void;
}) {
  const initial = useRef(lireBrouillon());
  const [texte, setTexte] = useState(initial.current?.texte ?? "");
  const [lien, setLien] = useState(initial.current?.lien ?? "");
  const [titre, setTitre] = useState(initial.current?.titre ?? "");
  const [voirLien, setVoirLien] = useState(Boolean(initial.current?.lien || initial.current?.titre));
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Identifiant du geste : réutilisé tant que le contenu ne change pas (renvoi après une réponse perdue).
  const geste = useRef<{ requete: string; empreinte: string }>(
    initial.current ? { requete: initial.current.requete, empreinte: initial.current.empreinte } : { requete: nouvelleRequete(), empreinte: "" },
  );
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);

  useEffect(() => {
    const t = window.setTimeout(() => {
      const empreinte = empreinteDe(texte, lien, titre);
      ecrireBrouillon({ texte, lien, titre, requete: geste.current.requete, empreinte: geste.current.empreinte || empreinte });
    }, 250);
    return () => window.clearTimeout(t);
  }, [texte, lien, titre]);

  const lienNormalise = normaliserLien(lien);
  const vide = !texte.trim() && !lien.trim();

  const enregistrer = async () => {
    if (envoi || vide) return;
    if (lienNormalise === null) { setErreur("Ce lien n'est pas une adresse web (http ou https)."); return; }
    const empreinte = empreinteDe(texte, lien, titre);
    if (geste.current.empreinte && geste.current.empreinte !== empreinte) geste.current = { requete: nouvelleRequete(), empreinte };
    geste.current.empreinte = empreinte;
    ecrireBrouillon({ texte, lien, titre, ...geste.current });
    setEnvoi(true);
    setErreur(null);
    try {
      const r = await api.capturer({ texte, ...(lienNormalise ? { lien: lienNormalise } : {}), ...(titre.trim() ? { titre: titre.trim() } : {}) }, geste.current.requete);
      ecrireBrouillon(null);
      window.dispatchEvent(new Event("carnet:boite"));
      onEnregistree({ chemin: r.chemin, titre: titre.trim() || texte.trim().split("\n")[0].slice(0, 60) || "Capture" });
    } catch (e) {
      const statut = e instanceof ErreurApi ? e.statut : 0;
      setErreur(statut === 0 || statut >= 500
        ? "Pas enregistrée (réseau ou serveur). Ta note est gardée ici : réessaie, elle ne sera pas dupliquée."
        : `Pas enregistrée : ${(e as Error).message}`);
    } finally {
      setEnvoi(false);
    }
  };

  const surTouche = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void enregistrer(); }
  };

  return (
    <Feuille titre="Capturer" onFermer={onFermer} etiquette="Capturer une note">
      <form className="dialogue__corps capture" onSubmit={(e) => { e.preventDefault(); void enregistrer(); }} onKeyDown={surTouche}>
        <textarea
          className="champ capture__texte"
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          placeholder="Une idée, une chose à faire, un lien…"
          aria-label="Texte de la capture"
          autoCapitalize="sentences"
          rows={4}
          maxLength={200_000}
        />
        {!voirLien ? (
          <button type="button" className="capture__plus" onClick={() => setVoirLien(true)}>
            <Link2 size={17} /> Ajouter un lien ou un titre
          </button>
        ) : (
          <>
            <label className="capture__etiquette" htmlFor="capture-lien">Lien (facultatif)</label>
            <input id="capture-lien" className="champ" type="url" inputMode="url" value={lien} onChange={(e) => setLien(e.target.value)}
              placeholder="https://…" autoCapitalize="off" autoCorrect="off" spellCheck={false} enterKeyHint="done" data-sans-focus
              aria-invalid={lienNormalise === null ? true : undefined} />
            <label className="capture__etiquette" htmlFor="capture-titre">Titre (facultatif)</label>
            <input id="capture-titre" className="champ" value={titre} onChange={(e) => setTitre(e.target.value)} maxLength={200}
              placeholder="Sinon, le début du texte" autoCapitalize="sentences" enterKeyHint="done" data-sans-focus />
          </>
        )}
        {erreur && <p className="capture__erreur" role="alert">{erreur}</p>}
        <p className="capture__aide">
          Rangée dans la <strong>Boîte</strong> ({dossier}/), à trier plus tard. Le lien est noté, jamais ouvert par Carnet.
          <span className="capture__raccourci"> {mac ? "⌘" : "Ctrl"} Entrée pour enregistrer.</span>
        </p>
        <div className="boutons">
          <button type="button" className="bouton" onClick={onFermer}>Fermer</button>
          <button type="submit" className="bouton bouton--primaire" disabled={vide || envoi}>
            <Inbox size={17} /> {envoi ? "Enregistrement…" : "Enregistrer"}
          </button>
        </div>
      </form>
    </Feuille>
  );
}
