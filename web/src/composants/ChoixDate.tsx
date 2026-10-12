// Lot 1 : choix d'une échéance (raccourcis + sélecteur de date du système). Utilisé par l'écran Aujourd'hui et par la
// pastille 📅 de l'éditeur. Renvoie la date AAAA-MM-JJ, null pour retirer l'échéance, ou rien (annulé).
import { useState } from "react";
import { Feuille } from "./Feuille";
import { dateDuJour, dateEnToutesLettres, plusJours } from "../taches-ui";

function lundiProchain(jour: string): string {
  const j = new Date(jour + "T12:00:00Z").getUTCDay(); // 0 = dimanche
  return plusJours(jour, ((8 - j) % 7) || 7);
}

export function DialogueDate({ titre, valeur, onChoisir, onFermer }: {
  titre: string;
  valeur: string | null;
  onChoisir: (v: string | null) => void;
  onFermer: () => void;
}) {
  const jour = dateDuJour();
  const [v, setV] = useState(valeur ?? "");
  const raccourcis: [string, string][] = [
    ["Aujourd'hui", jour],
    ["Demain", plusJours(jour, 1)],
    ["Lundi prochain", lundiProchain(jour)],
    ["Dans une semaine", plusJours(jour, 7)],
  ];
  const valide = /^\d{4}-\d{2}-\d{2}$/.test(v);
  return (
    <Feuille titre={titre} onFermer={onFermer}>
      <form className="dialogue__corps choix-date" onSubmit={(e) => { e.preventDefault(); if (valide) onChoisir(v); }}>
        <div className="choix-date__raccourcis" role="group" aria-label="Raccourcis">
          {raccourcis.map(([l, d]) => (
            <button key={l} type="button" className="choix-date__raccourci" data-actif={d === v ? "true" : undefined}
              onClick={() => onChoisir(d)} title={dateEnToutesLettres(d)}>
              <span>{l}</span>
              <span className="choix-date__jour">{new Intl.DateTimeFormat("fr-FR", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" }).format(new Date(d + "T12:00:00Z"))}</span>
            </button>
          ))}
        </div>
        <label className="capture__etiquette" htmlFor="choix-date-champ">Autre date</label>
        <input id="choix-date-champ" className="champ" type="date" value={v} onChange={(e) => setV(e.target.value)} data-sans-focus />
        <div className="boutons">
          {valeur && <button type="button" className="bouton choix-date__retirer" onClick={() => onChoisir(null)}>Retirer l'échéance</button>}
          <button type="button" className="bouton" onClick={onFermer}>Annuler</button>
          <button type="submit" className="bouton bouton--primaire" disabled={!valide || v === valeur}>Enregistrer</button>
        </div>
      </form>
    </Feuille>
  );
}
