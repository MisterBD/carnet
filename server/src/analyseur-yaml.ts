// Carnet · analyseur YAML injecté dans shared/proprietes.ts (paquet `yaml`, YAML 1.2 schéma core).
// Importer ce module (ou server/src/ecriture.ts, qui l'importe) suffit : l'analyseur est installé au chargement.
import YAML from "yaml";
import type { Node as NoeudYaml, Pair } from "yaml";
import { installerAnalyseurYaml } from "../../shared/proprietes.ts";
import type { AnalyseYaml, PaireYaml, ValeurYaml } from "../../shared/proprietes.ts";

function genreDe(n: unknown): ValeurYaml["genre"] {
  if (YAML.isAlias(n)) return "alias";
  if (YAML.isSeq(n)) return "liste";
  if (YAML.isMap(n)) return "table";
  return "scalaire";
}

export function analyserYaml(source: string): AnalyseYaml {
  const res: AnalyseYaml = { erreurs: [], racine: "vide", paires: [], valeurs: {}, doublons: [], interdits: [] };
  let doc: YAML.Document.Parsed;
  try {
    doc = YAML.parseDocument(source, { uniqueKeys: false, prettyErrors: false, keepSourceTokens: false });
  } catch (e) {
    res.erreurs.push(String((e as Error).message));
    return res;
  }
  for (const e of doc.errors) res.erreurs.push(String(e.message));
  if (res.erreurs.length) return res;
  const racine = doc.contents;
  if (racine === null || racine === undefined) return res;
  if (!YAML.isMap(racine)) {
    res.racine = "autre";
    return res;
  }
  res.racine = "table";
  if (racine.flow) res.interdits.push("table en style flux à la racine");
  const vues = new Map<string, number>();
  for (const p of racine.items as Pair<unknown, unknown>[]) {
    const k = p.key as NoeudYaml | null;
    if (!k || !YAML.isScalar(k) || !k.range) {
      res.interdits.push("clé complexe");
      continue;
    }
    const v = p.value as NoeudYaml | null;
    let valeur: ValeurYaml | null = null;
    if (v && v.range) {
      const flux = Boolean((v as { flow?: boolean }).flow);
      let fin = v.range[1];
      // liste en bloc : fin = fin du dernier élément (le commentaire qui le suit reste hors de la plage, donc conservé)
      if (YAML.isSeq(v) && !flux && v.items.length) {
        const dernier = v.items[v.items.length - 1] as NoeudYaml | null;
        if (dernier && dernier.range) fin = dernier.range[1];
      }
      valeur = { debut: v.range[0], fin, genre: genreDe(v), flux };
    }
    const paire: PaireYaml = { cle: k.value, debutCle: k.range[0], finCle: k.range[1], valeur };
    res.paires.push(paire);
    const nom = String(k.value);
    vues.set(nom, (vues.get(nom) ?? 0) + 1);
  }
  for (const [k, n] of vues) if (n > 1) res.doublons.push(k);
  const interdits = new Set<string>(res.interdits);
  YAML.visit(doc, {
    Node(_cle, n) {
      if (YAML.isAlias(n)) interdits.add("alias");
      else {
        if ((n as { anchor?: string }).anchor) interdits.add("ancre");
        if ((n as { tag?: string }).tag) interdits.add("étiquette");
      }
    },
    Pair(_cle, p) {
      const k = p.key;
      if (YAML.isScalar(k) && k.value === "<<") interdits.add("clé de fusion");
      else if (k !== null && !YAML.isScalar(k)) interdits.add("clé complexe");
    },
  });
  res.interdits = [...interdits];
  try {
    const js: unknown = doc.toJS({ maxAliasCount: 50 });
    if (js && typeof js === "object" && !Array.isArray(js)) res.valeurs = js as Record<string, unknown>;
  } catch (e) {
    res.erreurs.push(String((e as Error).message));
  }
  return res;
}

installerAnalyseurYaml(analyserYaml);
