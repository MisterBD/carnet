// Filet de sécurité : si un écran plante au rendu (éditeur, bloc, donnée inattendue), l'utilisateur voit un écran clair
// avec de quoi repartir, jamais une page blanche. La clé change avec la route : naviguer ailleurs relance le rendu.
import { Component, type ErrorInfo, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";

interface Props { cle: string; children: ReactNode; onAccueil: () => void }
interface Etat { erreur: Error | null; cle: string }

export class BarriereErreur extends Component<Props, Etat> {
  state: Etat = { erreur: null, cle: this.props.cle };

  static getDerivedStateFromError(erreur: Error): Partial<Etat> {
    return { erreur };
  }

  static getDerivedStateFromProps(props: Props, etat: Etat): Partial<Etat> | null {
    // Changer de page efface l'erreur : on réessaie le rendu
    return props.cle !== etat.cle ? { erreur: null, cle: props.cle } : null;
  }

  componentDidCatch(erreur: Error, info: ErrorInfo) {
    console.error("[carnet] erreur d'affichage", erreur, info.componentStack);
  }

  render() {
    const { erreur } = this.state;
    if (!erreur) return this.props.children;
    return (
      <main className="feuille feuille--centree">
        <div className="etat-vide" role="alert">
          <div className="etat-vide__icone" aria-hidden="true"><TriangleAlert size={26} /></div>
          <h1 className="etat-vide__titre">Cet écran n'a pas pu s'afficher</h1>
          <p className="etat-vide__texte">Ce qui était enregistré est intact. Recharge la page, ou reviens à l'accueil.</p>
          <div className="boutons">
            <button type="button" className="bouton" onClick={this.props.onAccueil}>Revenir à l'accueil</button>
            <button type="button" className="bouton bouton--primaire" onClick={() => location.reload()}>Recharger</button>
          </div>
          <details className="etat-vide__details">
            <summary>Détail technique</summary>
            <code>{erreur.message || String(erreur)}</code>
          </details>
        </div>
      </main>
    );
  }
}
