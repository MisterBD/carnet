// Vues du chantier « navigation » branchées par une seule ligne dans App.tsx : Corbeille et Historique d'une page.
// Chargées à la demande : elles ne pèsent rien au démarrage de l'appli.
import { lazy, Suspense } from "react";
import type { Route } from "../navigation";
import "../styles/navigation.css";

const Corbeille = lazy(() => import("./Corbeille").then((m) => ({ default: m.Corbeille })));
const Historique = lazy(() => import("./Historique").then((m) => ({ default: m.Historique })));

function Attente() {
  return (
    <main className="feuille" aria-busy="true">
      <div className="squelette" style={{ width: "40%", height: 34, marginTop: 30 }} />
      <div className="squelette" style={{ height: 64 }} />
      <div className="squelette" style={{ height: 64 }} />
    </main>
  );
}

export function VuesNavigation({ route }: { route: Route }) {
  if (route.vue !== "corbeille" && route.vue !== "historique") return null;
  return (
    <Suspense fallback={<Attente />}>
      {route.vue === "corbeille" ? <Corbeille /> : <Historique key={route.chemin} chemin={route.chemin} />}
    </Suspense>
  );
}
