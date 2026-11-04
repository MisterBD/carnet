// Grille d'emojis de l'icône de page (chargée à la demande : données d'emojis hors du paquet principal).
import { useMemo, useState } from "react";
import { Shuffle, X } from "lucide-react";
import { GROUPES_EMOJI, TOUS_EMOJIS } from "./emojis";
import { plier } from "../../../shared/page.ts";
import { tactile } from "../outils";

const CLE_EMOJIS_RECENTS = "carnet:emojis-recents";

function emojisRecents(): string[] {
  try {
    const v: unknown = JSON.parse(localStorage.getItem(CLE_EMOJIS_RECENTS) ?? "[]");
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 16) : [];
  } catch {
    return [];
  }
}

function noterEmoji(e: string): void {
  try { localStorage.setItem(CLE_EMOJIS_RECENTS, JSON.stringify([e, ...emojisRecents().filter((x) => x !== e)].slice(0, 16))); } catch { /* privé */ }
}

/** Choix d'une icône de page : recherche en français (sans accents), récents, au hasard, retirer. Aucun réseau. */
export default function SelecteurEmoji({ onChoisir, avecRetrait }: { onChoisir: (e: string) => void; avecRetrait: boolean }) {
  const [texte, setTexte] = useState("");
  const recents = useMemo(emojisRecents, []);
  const choisir = (e: string) => { if (e) noterEmoji(e); onChoisir(e); };
  const t = plier(texte.trim());
  const trouves = t ? TOUS_EMOJIS.filter((x) => t.split(/\s+/).every((m) => plier(x.mots).includes(m))) : null;
  const grille = (liste: string[]) => (
    <div className="grille-emoji">
      {liste.map((e) => (
        <button type="button" key={e} onClick={() => choisir(e)} aria-label={`Choisir ${e}`} title={TOUS_EMOJIS.find((x) => x.e === e)?.mots.split(" ")[0]}>{e}</button>
      ))}
    </div>
  );
  return (
    <>
      <div className="selecteur-emoji__tete">
        <input
          className="champ"
          type="search"
          value={texte}
          onChange={(e) => setTexte(e.target.value)}
          placeholder="Chercher : cafe, fusee, maison…"
          aria-label="Chercher un emoji"
          data-sans-focus={tactile ? "" : undefined}
          enterKeyHint="search"
          autoComplete="off"
          onKeyDown={(e) => { if (e.key === "Enter" && trouves?.length) { e.preventDefault(); choisir(trouves[0].e); } }}
        />
        <div className="selecteur-emoji__actions">
          <button type="button" className="bouton bouton--petit" onClick={() => choisir(TOUS_EMOJIS[Math.floor(Math.random() * TOUS_EMOJIS.length)].e)}>
            <Shuffle size={16} /> Au hasard
          </button>
          {avecRetrait && (
            <button type="button" className="bouton bouton--petit" onClick={() => onChoisir("")}>
              <X size={16} /> Retirer l'icône
            </button>
          )}
        </div>
      </div>
      <div className="dialogue__corps selecteur-emoji__corps">
        {trouves ? (
          trouves.length ? grille(trouves.map((x) => x.e)) : <p className="dialogue__texte">Aucun emoji pour « {texte.trim()} ».</p>
        ) : (
          <>
            {recents.length > 0 && (
              <div>
                <div className="groupe-emoji">Récents</div>
                {grille(recents)}
              </div>
            )}
            {GROUPES_EMOJI.map((g) => (
              <div key={g.nom}>
                <div className="groupe-emoji">{g.nom}</div>
                {grille(g.emojis.map((x) => x.e))}
              </div>
            ))}
          </>
        )}
      </div>
    </>
  );
}

