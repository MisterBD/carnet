// V3 lot 6 « Pages » : nouvelle page depuis un modèle (dossier « Modèles/ ») et journal du jour.
// - Dialogue : liste des modèles, titre, Créer. Le serveur remplace {{date}}, {{heure}} et {{titre}} LITTÉRALEMENT et crée
//   un fichier unique (« Titre.md », « Titre (2).md »…) : le modèle n'est jamais modifié. Le même identifiant de geste
//   (X-Carnet-Requete) est renvoyé tant que le modèle, le titre et le parent ne changent pas (réessai après une panne
//   réseau : jamais deux pages).
// - Journal du jour : « Journal/AAAA-MM-JJ.md » (fuseau du serveur), créé une seule fois ; une seule requête en vol.
//   La route /journal ouvre la page du jour en REMPLAÇANT l'adresse (pas d'entrée d'historique en plus).
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, FilePlus2, LayoutTemplate } from "lucide-react";
import { apiModeles, ErreurApi, nouvelleRequete, type Modele, type ResultatJournal } from "../api";
import { useApp } from "../contexte-app";
import { naviguer } from "../navigation";
import { tactile } from "../outils";
import { Feuille } from "./Feuille";
import { IconePage } from "./Icone";
import { Entete } from "./Entete";
import { EtatVide } from "./EtatVide";
import { SquelettePage } from "./Squelettes";
import "../styles/pages-modeles.css";

function messageErreur(e: unknown, quoi: string): string {
  const statut = e instanceof ErreurApi ? e.statut : 0;
  if (statut === 0 || statut >= 500) return `${quoi} (réseau ou serveur). Réessaie : rien ne sera créé deux fois.`;
  return `${quoi} : ${(e as Error).message}`;
}

export function DialogueModele({ parent, titreParent, onFermer, onCree }: {
  /** Page sous laquelle créer (sous-page), ou null pour la racine. */
  parent: string | null;
  titreParent?: string | null;
  onFermer: () => void;
  onCree: (chemin: string) => void;
}) {
  const [modeles, setModeles] = useState<Modele[] | null>(null);
  const [chargement, setChargement] = useState<string | null>(null);
  const [choisi, setChoisi] = useState<string | null>(null);
  const [titre, setTitre] = useState("");
  const [envoi, setEnvoi] = useState(false);
  const [erreur, setErreur] = useState<string | null>(null);
  // Identifiant du geste : réutilisé tant que modèle, titre et parent ne changent pas (renvoi après une réponse perdue).
  const geste = useRef<{ requete: string; empreinte: string }>({ requete: nouvelleRequete(), empreinte: "" });

  useEffect(() => {
    let fini = false;
    apiModeles.liste()
      .then((r) => { if (fini) return; setModeles(r.modeles); setChoisi((c) => c ?? r.modeles[0]?.chemin ?? null); })
      .catch((e) => { if (!fini) setChargement(messageErreur(e, "Modèles non chargés")); });
    return () => { fini = true; };
  }, []);

  const creer = async () => {
    const t = titre.replace(/\s+/g, " ").trim();
    if (envoi || !choisi) return;
    if (!t) { setErreur("Donne un titre à la page."); return; }
    const empreinte = JSON.stringify([choisi, t, parent]);
    if (geste.current.empreinte && geste.current.empreinte !== empreinte) geste.current = { requete: nouvelleRequete(), empreinte };
    geste.current.empreinte = empreinte;
    setEnvoi(true);
    setErreur(null);
    try {
      const r = await apiModeles.creer(choisi, t, parent, geste.current.requete);
      onCree(r.chemin);
    } catch (e) {
      setErreur(messageErreur(e, "Page non créée"));
    } finally {
      setEnvoi(false);
    }
  };

  return (
    <Feuille titre="Nouvelle page depuis un modèle" onFermer={onFermer}>
      <form className="dialogue__corps modeles" onSubmit={(e) => { e.preventDefault(); void creer(); }}>
        {parent && <p className="modeles__lieu">Elle sera créée sous « {titreParent || parent.replace(/\.md$/i, "")} ».</p>}
        <label className="modeles__etiquette" htmlFor="modele-titre">Titre</label>
        <input id="modele-titre" className="champ modeles__titre" value={titre} onChange={(e) => setTitre(e.target.value)}
          maxLength={200} placeholder="Titre de la nouvelle page" autoCapitalize="sentences" enterKeyHint="go"
          {...(tactile ? { "data-sans-focus": true } : {})} />
        <div className="modeles__etiquette" id="modeles-liste">Modèle</div>
        {chargement && <p className="modeles__erreur" role="alert">{chargement}</p>}
        {!modeles && !chargement && <p className="modeles__attente">Chargement des modèles…</p>}
        {modeles && modeles.length === 0 && (
          <p className="modeles__vide">
            Aucun modèle pour l'instant. Crée d'abord une page dans le dossier « Modèles » : elle servira de modèle
            (<code>{"{{titre}}"}</code>, <code>{"{{date}}"}</code> et <code>{"{{heure}}"}</code> y sont remplacés).
          </p>
        )}
        {modeles && modeles.length > 0 && (
          <div className="modeles__liste" role="radiogroup" aria-labelledby="modeles-liste">
            {modeles.map((m) => (
              <button key={m.chemin} type="button" role="radio" aria-checked={choisi === m.chemin} className="modeles__choix"
                onClick={() => setChoisi(m.chemin)}>
                <span className="modeles__icone"><IconePage icone={m.icone} /></span>
                <span className="modeles__nom">{m.titre}</span>
              </button>
            ))}
          </div>
        )}
        {erreur && <p className="modeles__erreur" role="alert">{erreur}</p>}
        <div className="boutons">
          <button type="button" className="bouton" onClick={onFermer}>Annuler</button>
          <button type="submit" className="bouton bouton--primaire" disabled={envoi || !choisi || !modeles?.length}>
            <FilePlus2 size={17} /> {envoi ? "Création…" : "Créer la page"}
          </button>
        </div>
      </form>
    </Feuille>
  );
}

// ---------------------------------------------------------------------------------------------
// État du dialogue dans l'application (App.tsx) : `ouvrir(parent, ouvrirPage)` → chemin créé ou null.
// ---------------------------------------------------------------------------------------------

interface EtatDialogue { parent: string | null; ouvrirPage: boolean; fin: (chemin: string | null) => void }

export function useDialogueModele(d: {
  rechargerArbre: () => Promise<void>;
  deplier: (chemin: string) => void;
  fermerTiroir: () => void;
  titreDe: (chemin: string) => string | null;
}): { ouvrir: (parent?: string | null, ouvrirPage?: boolean) => Promise<string | null>; couche: ReactNode } {
  const deps = useRef(d);
  deps.current = d;
  const [etat, setEtat] = useState<EtatDialogue | null>(null);
  const ouvrir = useCallback((parent: string | null = null, ouvrirPage = true) =>
    new Promise<string | null>((fin) => setEtat({ parent: parent || null, ouvrirPage, fin })), []);
  const couche = etat ? (
    <DialogueModele parent={etat.parent} titreParent={etat.parent ? deps.current.titreDe(etat.parent) : null}
      onFermer={() => { etat.fin(null); setEtat(null); }}
      onCree={(chemin) => {
        const x = deps.current;
        setEtat(null);
        if (etat.parent) x.deplier(etat.parent);
        void x.rechargerArbre().finally(async () => {
          // l'index de l'arbre (lu par l'éditeur pour résoudre le lien inséré) n'est à jour qu'au rendu suivant
          for (let i = 0; i < 30 && deps.current.titreDe(chemin) === null; i++) await new Promise((f) => window.setTimeout(f, 50));
          if (etat.ouvrirPage) { naviguer({ vue: "page", chemin }); x.fermerTiroir(); }
          etat.fin(chemin);
        });
      }} />
  ) : null;
  return { ouvrir, couche };
}

// ---------------------------------------------------------------------------------------------
// Journal du jour
// ---------------------------------------------------------------------------------------------

let journalEnVol: Promise<ResultatJournal> | null = null;

/** Une seule requête en vol : deux appuis rapides partagent la même réponse (le serveur est idempotent de toute façon). */
export function demanderJournal(): Promise<ResultatJournal> {
  if (!journalEnVol) {
    const p = apiModeles.journal(nouvelleRequete());
    journalEnVol = p;
    p.then(() => {}, () => {}).finally(() => { if (journalEnVol === p) journalEnVol = null; });
  }
  return journalEnVol;
}

/** Ouvre (et crée au besoin) le journal du jour ; depuis /journal, l'adresse est remplacée. Renvoie le message d'erreur ou null. */
export async function ouvrirJournal(d: { rechargerArbre: () => Promise<void>; fermerTiroir: () => void; notifier: (m: string) => void }): Promise<string | null> {
  try {
    const r = await demanderJournal();
    if (r.cree) await d.rechargerArbre();
    naviguer({ vue: "page", chemin: r.chemin }, location.pathname === "/journal");
    d.fermerTiroir();
    return null;
  } catch (e) {
    const m = messageErreur(e, "Journal du jour non ouvert");
    if (location.pathname !== "/journal") d.notifier(m);
    return m;
  }
}

/** Route /journal : ouvre la page du jour (squelette en attendant, erreur claire sinon). */
export function EcranJournal() {
  const app = useApp();
  const [erreur, setErreur] = useState<string | null>(null);
  const lancer = useCallback(() => { setErreur(null); void app.ouvrirJournal().then(setErreur); }, [app]);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { lancer(); }, []);
  return (
    <>
      <Entete fil={[{ titre: "Journal du jour" }]} />
      <main className="feuille" aria-busy={!erreur}>
        {!erreur ? <SquelettePage /> : (
          <EtatVide icone={<AlertTriangle size={20} />} titre="Journal du jour non ouvert" texte={erreur}
            actions={<button type="button" className="bouton" onClick={lancer}>Réessayer</button>} />
        )}
      </main>
    </>
  );
}

/** Icône des entrées « Depuis un modèle » (barre latérale, menu « / »). */
export const IconeModele = LayoutTemplate;
