// Vues du lot 3 « Agents » branchées par une seule ligne dans App.tsx : Décisions, Nouveautés, Clés d'accès.
// Chargées à la demande : elles ne pèsent rien au démarrage de l'appli.
import { lazy, Suspense } from "react";
import type { Route } from "../navigation";

const Decisions = lazy(() => import("./Decisions").then((m) => ({ default: m.Decisions })));
const Nouveautes = lazy(() => import("./Nouveautes").then((m) => ({ default: m.Nouveautes })));
const ClesAcces = lazy(() => import("./ClesAcces").then((m) => ({ default: m.ClesAcces })));

function Attente() {
  return (
    <main className="feuille" aria-busy="true">
      <div className="squelette" style={{ width: "40%", height: 34, marginTop: 30 }} />
      <div className="squelette" style={{ height: 64 }} />
      <div className="squelette" style={{ height: 64 }} />
    </main>
  );
}

export function VuesAgents({ route }: { route: Route }) {
  if (route.vue !== "decisions" && route.vue !== "nouveautes" && route.vue !== "cles") return null;
  return (
    <Suspense fallback={<Attente />}>
      {route.vue === "decisions" ? <Decisions /> : route.vue === "nouveautes" ? <Nouveautes /> : <ClesAcces />}
    </Suspense>
  );
}
