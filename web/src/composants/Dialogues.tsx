// Dialogues : saisie d'un nom, confirmation, menu d'actions, choix d'emoji, choix d'artefact.
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AppWindow } from "lucide-react";
import { Feuille } from "./Feuille";
import { EtatVide } from "./EtatVide";
import { SqueletteListe } from "./Squelettes";
import { api } from "../api";

export function DialogueTexte({ titre, texte, valeur = "", placeholder, bouton = "Valider", onValider, onFermer }: {
  titre: string; texte?: string; valeur?: string; placeholder?: string; bouton?: string;
  onValider: (v: string) => void; onFermer: () => void;
}) {
  const [v, setV] = useState(valeur);
  return (
    <Feuille titre={titre} onFermer={onFermer}>
      <form className="dialogue__corps" onSubmit={(e) => { e.preventDefault(); if (v.trim()) onValider(v.trim()); }}>
        {texte && <p className="dialogue__texte">{texte}</p>}
        <input
          className="champ"
          value={v}
          placeholder={placeholder}
          onChange={(e) => setV(e.target.value)}
          enterKeyHint="done"
          autoCapitalize="sentences"
          aria-label={titre}
          onFocus={(e) => e.currentTarget.select()}
        />
        <div className="boutons">
          <button type="button" className="bouton" onClick={onFermer}>Annuler</button>
          <button type="submit" className="bouton bouton--primaire" disabled={!v.trim()}>{bouton}</button>
        </div>
      </form>
    </Feuille>
  );
}

export function DialogueConfirmation({ titre, texte, bouton, danger, onValider, onFermer }: {
  titre: string; texte: string; bouton: string; danger?: boolean; onValider: () => void; onFermer: () => void;
}) {
  return (
    <Feuille titre={titre} onFermer={onFermer}>
      <div className="dialogue__corps">
        <p className="dialogue__texte">{texte}</p>
        <div className="boutons">
          <button type="button" className="bouton" onClick={onFermer}>Annuler</button>
          <button type="button" className={`bouton ${danger ? "bouton--danger" : "bouton--primaire"}`} onClick={onValider} data-autofocus>{bouton}</button>
        </div>
      </div>
    </Feuille>
  );
}

export interface ActionMenu { cle: string; libelle: string; icone?: ReactNode; danger?: boolean }

export function DialogueActions({ titre, items, onChoisir, onFermer }: {
  titre: string; items: ActionMenu[]; onChoisir: (cle: string) => void; onFermer: () => void;
}) {
  return (
    <Feuille titre={titre} onFermer={onFermer}>
      <ul className="menu-actions">
        {items.map((it, i) => (
          <li key={it.cle}>
            <button type="button" data-danger={it.danger ? "true" : undefined} onClick={() => onChoisir(it.cle)} data-autofocus={i === 0 ? true : undefined}>
              {it.icone}
              <span>{it.libelle}</span>
            </button>
          </li>
        ))}
      </ul>
    </Feuille>
  );
}

const SelecteurEmoji = lazy(() => import("./SelecteurEmoji"));

/** Choix d'une icône de page (grille chargée à la demande). */
export function DialogueEmoji({ onChoisir, onFermer, avecRetrait }: { onChoisir: (e: string) => void; onFermer: () => void; avecRetrait: boolean }) {
  return (
    <Feuille titre="Icône de la page" onFermer={onFermer}>
      <Suspense fallback={<div className="dialogue__corps"><div className="squelette" style={{ height: 46 }} /><div className="squelette" style={{ height: 220 }} /></div>}>
        <SelecteurEmoji onChoisir={onChoisir} avecRetrait={avecRetrait} />
      </Suspense>
    </Feuille>
  );
}

export function DialogueArtefact({ onChoisir, onFermer }: { onChoisir: (a: { chemin: string; titre: string }) => void; onFermer: () => void }) {
  const [liste, setListe] = useState<Array<{ chemin: string; titre: string; date?: string }> | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  useEffect(() => {
    api.artefacts().then((r) => setListe(r.artefacts)).catch((e) => setErreur(String(e.message ?? e)));
  }, []);
  return (
    <Feuille titre="Insérer un artefact" onFermer={onFermer}>
      <div className="dialogue__corps">
        {erreur && <p className="dialogue__texte">Impossible de lister les artefacts : {erreur}</p>}
        {!liste && !erreur && <SqueletteListe lignes={3} hauteur={48} />}
        {liste && liste.length === 0 && (
          <EtatVide compact icone={<AppWindow size={20} />} titre="Aucun artefact pour l'instant"
            texte={<>Les agents les déposent dans <code>artefacts/AAAA-MM-JJ-nom/index.html</code>.</>} />
        )}
        {liste && liste.length > 0 && (
          <ul className="menu-actions" style={{ padding: 0 }}>
            {liste.map((a) => (
              <li key={a.chemin}>
                <button type="button" onClick={() => onChoisir({ chemin: a.chemin, titre: a.titre })}>
                  <AppWindow size={20} />
                  <span>{a.titre}{a.date ? <span style={{ color: "var(--encre-3)" }}> · {a.date}</span> : null}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Feuille>
  );
}
