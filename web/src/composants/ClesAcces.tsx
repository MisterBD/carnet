// Lot 3 « Agents » : écran « Clés d'accès ». Une clé d'accès (Face ID sur iPhone, Touch ID sur Mac) prouve que c'est
// bien toi qui décides, et pas un agent qui passe par ton compte. Ajouter une clé demande un code à usage unique créé
// sur le serveur (aucun bouton de Carnet ne peut en créer : sinon un agent pourrait enregistrer la sienne).
import { useCallback, useEffect, useState } from "react";
import { KeyRound, ScanFace, ShieldCheck } from "lucide-react";
import { apiAgents, type CleAcces } from "../api";
import { useApp } from "../contexte-app";
import { creerCle, messageWebauthn, webauthnDisponible } from "../cles-acces";
import { Entete } from "./Entete";
import { quand } from "./BandeauxAgents";
import { dansAppIos, nomCle } from "./BarreDecision";
import { urlDe } from "../navigation";
import "../styles/agents.css";

export function ClesAcces() {
  const app = useApp();
  const [etat, setEtat] = useState<{ rpId: string; cles: CleAcces[]; enrolement: boolean } | null>(null);
  const [erreur, setErreur] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [nom, setNom] = useState(() => (/iPhone/.test(navigator.userAgent) ? "iPhone" : /iPad/.test(navigator.userAgent) ? "iPad" : /Mac/.test(navigator.platform) ? "Mac" : "Cet appareil"));
  const [occupe, setOccupe] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const charger = useCallback(() => {
    apiAgents.cles().then((r) => { setEtat(r); setErreur(null); }).catch((e) => setErreur((e as Error).message));
  }, []);
  useEffect(() => { charger(); }, [charger]);

  const enregistrer = async () => {
    setMessage(null);
    if (!webauthnDisponible()) { setMessage("Les clés d'accès demandent une adresse sécurisée (https, ou localhost en essai) et un navigateur compatible."); return; }
    setOccupe(true);
    try {
      const o = await apiAgents.defiCle(code.trim());
      const reponse = await creerCle(o);
      await apiAgents.enregistrerCle({ code: code.trim(), nom: nom.trim(), ...reponse });
      setCode("");
      app.notifier("Clé d'accès enregistrée");
      charger();
    } catch (e) {
      setMessage((e as { name?: string }).name ? messageWebauthn(e) : (e as Error).message);
    } finally {
      setOccupe(false);
    }
  };

  const ici = etat?.cles.filter((c) => c.ici) ?? [];
  return (
    <>
      <Entete fil={[{ titre: "Décisions", route: { vue: "decisions" } }, { titre: "Clés d'accès" }]} />
      <main className="feuille vue vue-agents">
        <header className="vue-tete">
          <h1 className="vue-tete__titre">Clés d'accès</h1>
          <p className="vue-tete__texte">
            Tes agents passent par le même compte que toi : sans autre preuve, Carnet ne peut pas savoir si c'est toi qui
            approuves. Une clé d'accès ({nomCle() === "ta clé d'accès" ? "Face ID, Touch ID" : nomCle()}) le prouve : chaque décision est signée par ton
            appareil, sur la proposition exacte. Sans clé, tes décisions restent possibles mais marquées « geste non prouvé » ;
            dès qu'une clé existe, toute décision l'exige.
          </p>
        </header>
        {erreur && <p className="etat-page">Les clés ne répondent pas : {erreur}</p>}
        {etat && (
          <>
            <section aria-labelledby="cles-liste">
              <h2 className="section-agents__titre" id="cles-liste">Clés enregistrées <span className="compteur">{etat.cles.length}</span></h2>
              {etat.cles.length === 0 ? (
                <p className="vue-agents__vide">Aucune clé pour l'instant : tes décisions sont marquées « geste non prouvé ».</p>
              ) : (
                <ul className="liste-agents">
                  {etat.cles.map((c) => (
                    <li key={c.id} className="cle-acces">
                      <span className="element-corbeille__icone" aria-hidden="true"><KeyRound size={18} /></span>
                      <span className="decision-ligne__texte">
                        <span className="decision-ligne__titre">{c.nom}</span>
                        <span className="decision-ligne__meta">
                          {c.rpId}{c.ici ? " (cette adresse)" : ""} · ajoutée le {quand(c.cree)}{c.utilisee ? ` · utilisée le ${quand(c.utilisee)}` : " · jamais utilisée"}
                        </span>
                      </span>
                      {c.ici && <ShieldCheck size={18} className="cle-acces__ok" aria-label="Utilisable ici" />}
                    </li>
                  ))}
                </ul>
              )}
              {etat.cles.length > 0 && ici.length === 0 && (
                <p className="decision__alerte">Aucune clé pour cette adresse ({etat.rpId}) : ouvre Carnet depuis l'adresse de ta clé pour décider.</p>
              )}
            </section>
            <section aria-labelledby="cles-ajout" className="cles-ajout">
              <h2 className="section-agents__titre" id="cles-ajout">Ajouter une clé sur cet appareil</h2>
              <ol className="cles-ajout__etapes">
                <li>Sur le serveur, crée un code à usage unique (valable 30 minutes) : <code>node server/src/admin-cles.ts code</code>
                  {" "}(dans le conteneur : <code>docker compose exec carnet node src/admin-cles.ts code</code>).</li>
                <li>Saisis-le ici, donne un nom à la clé, puis confirme avec {nomCle()}.</li>
              </ol>
              {etat.enrolement && <p className="cles-ajout__info">Un code est en attente sur le serveur.</p>}
              {dansAppIos() && (
                <p className="decision__alerte">
                  Dans l'app, les clés d'accès ne fonctionnent pas : <a href={`${urlDe({ vue: "cles" })}?ouvrir=safari`} target="_blank" rel="noopener">ouvre cette page dans Safari</a> pour enregistrer ta clé.
                </p>
              )}
              <form className="cles-ajout__form" onSubmit={(e) => { e.preventDefault(); void enregistrer(); }}>
                <label>
                  <span>Code d'enrôlement</span>
                  <input className="champ" value={code} onChange={(e) => setCode(e.target.value)} placeholder="ABCDE-FGHIJ" autoComplete="one-time-code"
                    autoCapitalize="characters" spellCheck={false} data-sans-focus />
                </label>
                <label>
                  <span>Nom de la clé</span>
                  <input className="champ" value={nom} onChange={(e) => setNom(e.target.value)} maxLength={60} data-sans-focus />
                </label>
                <button type="submit" className="bouton bouton--primaire" disabled={occupe || code.trim().length < 10}>
                  <ScanFace size={18} /> Enregistrer avec {nomCle()}
                </button>
              </form>
              {message && <p className="decision-feuille__erreur" role="alert">{message}</p>}
              {!webauthnDisponible() && (
                <p className="decision__alerte">Ici, les clés d'accès ne sont pas disponibles : il faut une adresse en https (ou localhost en essai).</p>
              )}
              <p className="vue-tete__texte cles-ajout__note">
                Retirer une clé se fait aussi sur le serveur : <code>node server/src/admin-cles.ts liste</code> puis <code>retirer</code>.
                Limite connue : un programme qui peut écrire dans l'état du serveur pourrait enrôler sa propre clé ; la clé
                protège contre l'erreur et l'agent naïf, pas contre un agent malveillant sur la même machine.
              </p>
            </section>
          </>
        )}
      </main>
    </>
  );
}
