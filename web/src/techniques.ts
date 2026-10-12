// Lot 3 : règles des fichiers des agents, demandées une fois au serveur (GET /api/techniques) et partagées par la
// barre latérale (groupe « Fichiers des agents ») et la recherche (récents sans fichiers des agents).
import { useEffect, useState } from "react";
import { apiAgents } from "./api";
import { lireTechniques, type Techniques } from "../../shared/techniques.ts";

let promesse: Promise<Techniques | null> | null = null;
let connues: Techniques | null = null;

export function reglesTechniques(): Promise<Techniques | null> {
  promesse ??= apiAgents.techniques()
    .then((r) => (connues = lireTechniques(r.regles)))
    .catch(() => { promesse = null; return null; });
  return promesse;
}

export function useTechniques(): Techniques | null {
  const [t, setT] = useState<Techniques | null>(connues);
  useEffect(() => {
    let actif = true;
    void reglesTechniques().then((x) => { if (actif) setT(x); });
    return () => { actif = false; };
  }, []);
  return t;
}
