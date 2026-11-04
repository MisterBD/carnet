// Langages des blocs de code : noms en français, alias, coloration par lowlight (highlight.js, BSD-3-Clause).
// Liste choisie (pas les 190 langages) : le poids reste faible, aucune détection automatique (lente et hasardeuse).
import { createLowlight } from "lowlight";
import bash from "highlight.js/lib/languages/bash";
import c from "highlight.js/lib/languages/c";
import cpp from "highlight.js/lib/languages/cpp";
import csharp from "highlight.js/lib/languages/csharp";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import dockerfile from "highlight.js/lib/languages/dockerfile";
import go from "highlight.js/lib/languages/go";
import ini from "highlight.js/lib/languages/ini";
import java from "highlight.js/lib/languages/java";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import kotlin from "highlight.js/lib/languages/kotlin";
import markdown from "highlight.js/lib/languages/markdown";
import php from "highlight.js/lib/languages/php";
import powershell from "highlight.js/lib/languages/powershell";
import python from "highlight.js/lib/languages/python";
import ruby from "highlight.js/lib/languages/ruby";
import rust from "highlight.js/lib/languages/rust";
import shell from "highlight.js/lib/languages/shell";
import sql from "highlight.js/lib/languages/sql";
import swift from "highlight.js/lib/languages/swift";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";

export interface Langue { id: string | null; nom: string; alias?: string[] }

/** Langages proposés, dans l'ordre du menu. `id` = valeur écrite après les ``` dans le fichier. */
export const LANGUES: Langue[] = [
  { id: null, nom: "Texte brut", alias: ["text", "txt", "plaintext", "aucun"] },
  { id: "mermaid", nom: "Schéma (Mermaid)", alias: ["diagramme"] },
  { id: "vega-lite", nom: "Graphique (Vega-Lite)", alias: ["vegalite", "graphique"] },
  { id: "bash", nom: "Shell (bash)", alias: ["sh", "zsh", "terminal"] },
  { id: "python", nom: "Python", alias: ["py"] },
  { id: "javascript", nom: "JavaScript", alias: ["js", "jsx", "mjs"] },
  { id: "typescript", nom: "TypeScript", alias: ["ts", "tsx"] },
  { id: "json", nom: "JSON" },
  { id: "yaml", nom: "YAML", alias: ["yml"] },
  { id: "html", nom: "HTML", alias: ["xml", "svg"] },
  { id: "css", nom: "CSS" },
  { id: "sql", nom: "SQL" },
  { id: "markdown", nom: "Markdown", alias: ["md"] },
  { id: "diff", nom: "Différences (diff)", alias: ["patch"] },
  { id: "dockerfile", nom: "Dockerfile", alias: ["docker"] },
  { id: "ini", nom: "INI / TOML", alias: ["toml", "conf"] },
  { id: "go", nom: "Go", alias: ["golang"] },
  { id: "rust", nom: "Rust", alias: ["rs"] },
  { id: "java", nom: "Java" },
  { id: "kotlin", nom: "Kotlin", alias: ["kt"] },
  { id: "swift", nom: "Swift" },
  { id: "php", nom: "PHP" },
  { id: "ruby", nom: "Ruby", alias: ["rb"] },
  { id: "c", nom: "C", alias: ["h"] },
  { id: "cpp", nom: "C++", alias: ["c++", "hpp"] },
  { id: "csharp", nom: "C#", alias: ["cs", "c#"] },
  { id: "powershell", nom: "PowerShell", alias: ["ps1", "ps"] },
  { id: "shell", nom: "Session de terminal", alias: ["console", "shell-session"] },
];

const APERCUS: Record<string, "mermaid" | "vega-lite"> = { mermaid: "mermaid", "vega-lite": "vega-lite", vegalite: "vega-lite" };

export function typeApercu(langue: string | null | undefined): "mermaid" | "vega-lite" | null {
  return APERCUS[(langue || "").trim().toLowerCase()] ?? null;
}

export function libelleLangue(langue: string | null | undefined): string {
  const l = (langue || "").trim().toLowerCase();
  if (!l) return "Texte brut";
  const t = LANGUES.find((x) => x.id === l || x.alias?.includes(l));
  return t ? t.nom : langue!;
}

const ll = createLowlight({
  bash, c, cpp, csharp, css, diff, dockerfile, go, ini, java, javascript, json, kotlin, markdown, php, powershell,
  python, ruby, rust, shell, sql, swift, typescript, xml, yaml,
});
ll.registerAlias({ xml: ["html", "svg"], ini: ["toml"], bash: ["zsh"], shell: ["shell-session"], javascript: ["mjs"] });

/** lowlight sans détection automatique : un langage inconnu (mermaid, vega-lite…) reste du texte simple. */
export const lowlightCarnet = {
  highlight: ll.highlight,
  highlightAuto: (value: string) => ({ type: "root" as const, children: [{ type: "text" as const, value }], data: { language: undefined, relevance: 0 } }),
  listLanguages: ll.listLanguages,
  registered: ll.registered,
  register: ll.register,
  registerAlias: ll.registerAlias,
};
