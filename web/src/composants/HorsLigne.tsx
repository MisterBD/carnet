// Écrans « le carnet ne répond pas » : plein écran quand l'appli ne peut pas démarrer (réseau privé coupé, serveur arrêté),
// pastille discrète quand la connexion tombe en cours d'usage. Pas d'écran blanc, jamais de message anglais brut.
// L'écran servi par le service worker quand le réseau manque dès le lancement est public/hors-ligne.html (même texte, même mine).
import { useEffect, useRef, useState } from "react";
import { Wifi, WifiOff } from "lucide-react";
import { aideConnexion, useReseau, type AideConnexion, type Panne } from "../pwa";
import { Vague } from "./Icone";

// Textes neutres par défaut ; CARNET_RESEAU (« Tailscale »…) et CARNET_CONTACT les précisent (voir pwa.ts).
const TEXTES: Record<Panne["genre"], (p: Panne, a: AideConnexion) => { titre: string; question?: string; aide: string }> = {
  reseau: (_p, a) => ({
    titre: "Pas de connexion au carnet",
    question: a.reseau ? `${a.reseau} est-il allumé ?` : "Vérifie ta connexion (VPN, réseau privé, proxy), puis réessaie.",
    aide: a.reseau
      ? `Carnet ne s'ouvre que depuis ton réseau ${a.reseau}. Allume-le, puis reviens ici : la page se rouvre toute seule.`
      : "Dès que Carnet répond de nouveau, la page se rouvre toute seule.",
  }),
  acces: (_p, a) => ({
    titre: "Accès refusé",
    question: a.reseau ? `Es-tu connecté au bon compte ${a.reseau} ?` : "Es-tu connecté avec le bon compte ?",
    aide: a.reseau
      ? `Carnet reconnaît ton compte ${a.reseau} et rien d'autre. Ouvre-le depuis l'adresse habituelle, avec ${a.reseau} allumé.`
      : "Carnet n'accepte que les comptes autorisés. Ouvre-le depuis l'adresse habituelle, connecté avec ton compte.",
  }),
  serveur: (p, a) => ({
    titre: "Carnet ne répond pas",
    question: "Le serveur est joignable, mais il répond mal.",
    aide: `Erreur ${p.genre === "serveur" ? p.statut : ""}. Réessaie dans un instant ; si ça dure, ${a.contact ? `dis-le à ${a.contact}` : "préviens la personne qui gère ton Carnet"}.`,
  }),
  inconnue: (p) => ({
    titre: "Carnet n'a pas pu démarrer",
    question: "Un incident s'est produit au chargement.",
    aide: p.genre === "inconnue" ? p.message : "",
  }),
};

/** Sceau « endormi » : la vague du carnet, la seconde en pointillés (signal perdu). */
function SceauEteint() {
  return (
    <div className="ecran-etat__sceau" aria-hidden="true">
      <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
        <path d="M3 9.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        <path d="M3 15.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeDasharray="1 5" />
      </svg>
    </div>
  );
}

export function EcranHorsLigne({ panne, onReessayer }: { panne: Panne; onReessayer: () => Promise<boolean> }) {
  const [enCours, setEnCours] = useState(false);
  const [message, setMessage] = useState("");
  const occupe = useRef(false);
  const t = TEXTES[panne.genre](panne, aideConnexion());

  const essayer = async (manuel: boolean) => {
    if (occupe.current) return;
    occupe.current = true;
    if (manuel) { setEnCours(true); setMessage(""); }
    try {
      const ok = await onReessayer();
      if (!ok && manuel) setMessage(panne.genre === "reseau" ? "Toujours pas de connexion." : "Toujours pas de réponse.");
    } finally {
      occupe.current = false;
      setEnCours(false);
    }
  };

  // Retour du réseau, retour au premier plan (la personne vient de rallumer son VPN) : on réessaie sans qu'elle y pense.
  useEffect(() => {
    const f = () => { if (document.visibilityState === "visible") void essayer(false); };
    window.addEventListener("online", f);
    document.addEventListener("visibilitychange", f);
    const boucle = window.setInterval(f, 6000);
    return () => { window.removeEventListener("online", f); document.removeEventListener("visibilitychange", f); window.clearInterval(boucle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <main className="ecran-etat" aria-labelledby="titre-ecran-etat">
      <SceauEteint />
      <h1 className="ecran-etat__titre" id="titre-ecran-etat">{t.titre}</h1>
      {t.question && <p className="ecran-etat__question">{t.question}</p>}
      {t.aide && <p className="ecran-etat__aide">{t.aide}</p>}
      <button type="button" className="bouton bouton--primaire ecran-etat__bouton" onClick={() => void essayer(true)} disabled={enCours}>
        {enCours ? "Nouvel essai…" : "Réessayer"}
      </button>
      <p className="ecran-etat__etat" role="status" aria-live="polite">{message}</p>
      <span className="ecran-etat__vague" aria-hidden="true"><Vague largeur={96} hauteur={10} cretes={8} /></span>
    </main>
  );
}

/** Pastille en haut de l'écran quand la connexion tombe pendant l'usage ; elle disparaît seule au retour du réseau. */
export function PastilleReseau() {
  const { etat, reessayer } = useReseau();
  if (etat === "ok") return <div className="pastille-reseau-zone" role="status" aria-live="polite" />;
  return (
    <div className="pastille-reseau-zone" role="status" aria-live="polite">
      <div className="pastille-reseau" data-etat={etat}>
        {etat === "hors" ? <WifiOff size={18} aria-hidden="true" /> : <Wifi size={18} aria-hidden="true" />}
        {etat === "hors" ? (
          <>
            <span className="pastille-reseau__texte">Pas de connexion au carnet<span className="masque-visuel">. Garde cette page ouverte : tes modifications partiront au retour du réseau.</span></span>
            <button type="button" onClick={() => void reessayer()}>Réessayer</button>
          </>
        ) : (
          <span className="pastille-reseau__texte">De retour en ligne</span>
        )}
      </div>
    </div>
  );
}
