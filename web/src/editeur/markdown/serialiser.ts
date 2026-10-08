// Écriture du Markdown (mdast-util-to-markdown + GFM), réglée pour coller à l'écriture des agents :
// puces « - », _italique_, **gras**, tableaux « | --- | » sans alignement des colonnes, liens nus laissés nus,
// marqueurs d'origine conservés (* ou _, ~~ ou ~, puce, clôture de code, séparateur, titre souligné, saut de ligne),
// blocs maison (encadrés, repliables, couleurs, surlignage, liens de page, artefacts) réécrits dans leur forme.
import { toMarkdown, defaultHandlers, type Options, type State, type Info, type Handle } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "mdast-util-gfm";
import type { MNode } from "./mdast.ts";

type H = (node: MNode, parent: MNode | undefined, state: State, info: Info) => string;
const def = defaultHandlers as unknown as Record<string, H & { peek?: H }>;

/**
 * La sérialisation échappe tout « [ » du texte (« \[2026-07-30] »). On le rend tel quel quand le crochet fermant est
 * dans le même texte et ne peut pas former un lien (pas suivi de « ( », « [ » ou « : », pas une case « [ ] » / « [x] »).
 */
export function desechapperCrochets(v: string): string {
  if (!v.includes("\\[")) return v;
  let sortie = "";
  let i = 0;
  while (i < v.length) {
    const k = v.indexOf("\\[", i);
    if (k === -1) { sortie += v.slice(i); break; }
    let n = 0;
    while (k - 1 - n >= 0 && v[k - 1 - n] === "\\") n++;
    let j = k + 2;
    let fin = -1;
    while (j < v.length) {
      if (v[j] === "\\") { j += 2; continue; }
      if (v[j] === "[") break;
      if (v[j] === "]") { fin = j; break; }
      j++;
    }
    const interieur = fin === -1 ? "" : v.slice(k + 2, fin);
    const apres = fin === -1 ? "" : v[fin + 1] ?? "";
    const sur = n % 2 === 0 && fin !== -1 && !"([:".includes(apres || "§") && !/^( |x|X|\^.*)?$/.test(interieur)
      && (k === 0 || v[k - 1] !== "!") && !interieur.startsWith("[") && !interieur.endsWith("]");
    sortie += v.slice(i, k) + (sur ? "[" : "\\[");
    i = k + 2;
  }
  // « \]] » laissé par un crochet ouvrant non échappé : on garde l'échappement
  return sortie;
}

/** « \-- @camille » en début de ligne : l'échappement n'est utile que si la ligne pouvait devenir une liste ou un trait. */
function desechapperTirets(v: string): string {
  return v.replace(/(^|\n)\\--(?=[ \t]*[^\s-])/g, "$1--").replace(/(^|\n)\\-(?=[^\s-])/g, "$1-");
}

function avecOptions<T>(state: State, o: Partial<Options>, f: () => T): T {
  const opts = state.options as Record<string, unknown>;
  const avant: Record<string, unknown> = {};
  for (const k of Object.keys(o)) avant[k] = opts[k];
  Object.assign(opts, o);
  try { return f(); } finally { Object.assign(opts, avant); }
}

const echapperHtml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function enveloppe(ouvre: string, ferme: string): H {
  return (node, _p, state, info) => {
    const exit = state.enter("phrasing" as never);
    const t = state.createTracker(info);
    let v = t.move(ouvre);
    v += t.move(state.containerPhrasing(node as never, { ...t.current(), before: v, after: ferme[0] ?? "" }));
    v += t.move(ferme);
    exit();
    return v;
  };
}

const handlers: Record<string, H & { peek?: H; attention?: unknown }> = {
  // Texte : échappements réduits au strict nécessaire
  text: (node, parent, state, info) => {
    let v = desechapperTirets(desechapperCrochets(def.text(node, parent, state, info)));
    // caractère seul de son espèce dans le paragraphe (et sans gras ni italique) : il ne peut rien ouvrir ni fermer
    const seuls = String(node.data?.seuls ?? "");
    for (const c of seuls) v = v.replace(new RegExp(`(?<=[^\\n\\\\])\\\\\\${c}`, "g"), c);
    return v;
  },

  // Paragraphes vides au premier niveau (lignes laissées vides dans l'éditeur) : rien dans le fichier
  root: (node, parent, state, info) => {
    const enfants = (node.children ?? []).filter((c) => !(c.type === "paragraph" && !(c.children && c.children.length)));
    return def.root({ ...node, children: enfants }, parent, state, info);
  },

  heading: (node, parent, state, info) => avecOptions(state, { setext: Boolean(node.data?.setext) }, () => def.heading(node, parent, state, info)),

  thematicBreak: (node, parent, state, info) => {
    const brut = String(node.data?.brut ?? "");
    if (/^(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(brut)) return brut;
    return def.thematicBreak(node, parent, state, info);
  },

  code: (node, parent, state, info) => {
    const cloture = String(node.data?.cloture ?? "```");
    const indente = Boolean(node.data?.indente) && !node.lang;
    const v = avecOptions(state, { fences: !indente, fence: (cloture[0] === "~" ? "~" : "`") as "`" | "~" }, () => def.code(node, parent, state, info));
    if (indente) return v;
    // longueur de clôture d'origine, si elle reste valable
    const m = /^(`{3,}|~{3,})/.exec(v);
    if (m && cloture.length > m[1].length && cloture[0] === m[1][0]) {
      const fin = v.lastIndexOf(m[1]);
      return cloture + v.slice(m[1].length, fin) + cloture + v.slice(fin + m[1].length);
    }
    return v;
  },

  list: (node, parent, state, info) => {
    const m = String(node.data?.marqueur ?? "");
    const o: Partial<Options> = node.ordered
      ? (m === ")" || m === "." ? { bulletOrdered: m as "." | ")" } : {})
      : (m === "-" || m === "*" || m === "+" ? { bullet: m as "-" | "*" | "+", bulletOther: (m === "-" ? "*" : "-") as "-" | "*" | "+" } : {});
    return avecOptions(state, o, () => def.list(node, parent, state, info));
  },

  // Gras, italique : marqueur d'origine (« ** » ou « __ », « _ » ou « * »), changé seulement si nécessaire
  strong: Object.assign(((node, p, state, info) => def.strong(node, p, state, info)) as H, {
    peek: (node: MNode) => (node.data?.marqueur === "_" ? "_" : "*"),
    attention: (node: MNode) => ({ construct: "strong", markers: node.data?.marqueur === "_" ? ["_", "*"] : ["*", "_"], sizes: [2] }),
  }),
  emphasis: Object.assign(((node, p, state, info) => def.emphasis(node, p, state, info)) as H, {
    peek: (node: MNode) => (node.data?.marqueur === "*" ? "*" : "_"),
    attention: (node: MNode) => ({ construct: "emphasis", markers: node.data?.marqueur === "*" ? ["*", "_"] : ["_", "*"], sizes: [1] }),
  }),

  link: Object.assign(((node, parent, state, info) => {
    const seul = node.children?.length === 1 && node.children[0].type === "text" ? node.children[0].value : null;
    const url = node.url ?? "";
    if (!node.title && seul === url && /^https?:\/\/[^\s<>()[\]`*"']+$/.test(url)
      && !/[.,:;!?]$/.test(url) && !/^[\w\-/.]/.test(info?.after ?? "")) {
      if (node.data?.forme === "chevrons") return `<${url}>`;
      return url; // lien nu (autolien GFM), comme les agents l'écrivent
    }
    return def.link(node, parent, state, info);
  }) as H, { peek: def.link.peek }),

  break: (node, parent, state, info) => {
    if (node.data?.forme === "espaces") return "  \n";
    return def.break(node, parent, state, info);
  },

  // Liens de page
  wikiLink: Object.assign(((node) => `[[${node.value ?? ""}]]`) as H, { peek: () => "[" }),

  // Couleurs, souligné, surlignage (grammaire fermée)
  couleur: Object.assign(((node, p, state, info) => {
    const nom = String(node.couleur ?? "gray") + (node.fond ? "_bg" : "");
    return enveloppe(`<span color="${nom}">`, "</span>")(node, p, state, info);
  }) as H, { peek: () => "<" }),
  souligne: Object.assign(enveloppe("<u>", "</u>"), { peek: () => "<" }),
  surligne: Object.assign(((node, p, state, info) => {
    if (node.forme === "mark") return enveloppe("<mark>", "</mark>")(node, p, state, info);
    return enveloppe("==", "==")(node, p, state, info);
  }) as H, { peek: (node: MNode) => (node.forme === "mark" ? "<" : "=") }),

  // Encadré : « > [!NOTE] titre » puis le contenu cité
  encadre: (node, _p, state, info) => {
    const sortie = state.enter("blockquote");
    const suivi = state.createTracker(info);
    suivi.move("> ");
    suivi.shift(2);
    const titre = String(node.titre ?? "");
    const tete = `[!${String(node.genre ?? "NOTE")}]${String(node.pli ?? "")}${titre ? " " + titre : ""}`;
    const corps = node.children && node.children.length ? state.containerFlow(node as never, suivi.current()) : "";
    const valeur = state.indentLines(corps ? tete + "\n" + corps : tete, (ligne, _i, vide) => ">" + (vide ? "" : " ") + ligne);
    sortie();
    return valeur;
  },

  // Repliable : <details> / <summary> ; forme compacte gardée si le contenu le permet
  details: (node, _p, state, info) => {
    const ouvre = node.ouvert ? "<details open>" : "<details>";
    const resume = node.sansResume ? null : `<summary>${echapperHtml(String(node.resume ?? ""))}</summary>`;
    const corps = node.children && node.children.length ? state.containerFlow(node as never, state.createTracker(info).current()) : "";
    if (node.forme === "compact" && resume && corps && !/\n[ \t]*\n/.test(corps) && !/^[ \t]*</m.test(corps)) {
      return `${ouvre}\n${resume}\n${corps}\n</details>`;
    }
    const tete = resume ? (node.forme === "separe" ? `${ouvre}\n\n${resume}` : `${ouvre}\n${resume}`) : ouvre;
    return corps ? `${tete}\n\n${corps}\n\n</details>` : `${tete}\n\n</details>`;
  },

  // Carte d'artefact : un lien (avec ou sans image d'aperçu) seul dans son paragraphe
  artefactCarnet: (node) => {
    const urlMd = (u: string) => u.replace(/ /g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
    const texteMd = (t: string) => t.replace(/([\\[\]])/g, "\\$1");
    const url = urlMd(String(node.url ?? ""));
    if (node.image) return `[![${texteMd(String(node.alt ?? ""))}](${urlMd(String(node.image))})](${url})`;
    return `[${texteMd(String(node.titre ?? ""))}](${url})`;
  },
};

const gfm = gfmToMarkdown({ tablePipeAlign: false });
function gestionnaireGfm(nom: string, ext: { handlers?: Record<string, H>; extensions?: unknown[] } = gfm as never): H | undefined {
  if (ext.handlers?.[nom]) return ext.handlers[nom];
  for (const e of ext.extensions ?? []) {
    const h = gestionnaireGfm(nom, e as never);
    if (h) return h;
  }
  return undefined;
}
// Tâche vide : « - [ ] » (sans contenu, la case disparaîtrait)
const elementGfm = gestionnaireGfm("listItem")!;
handlers.listItem = (node, parent, state, info) => {
  const v = elementGfm(node, parent, state, info);
  if (typeof node.checked === "boolean" && /^([*+-]|\d+[.)])$/.test(v.trim())) return `${v.trim()} [${node.checked ? "x" : " "}]`;
  return v;
};

// Barré : « ~~ » ou « ~ » selon l'original
const barreGfm = gestionnaireGfm("delete")!;
handlers.delete = Object.assign(((n, p, s, i) => barreGfm(n, p, s, i)) as H, {
  peek: () => "~",
  attention: (node: MNode) => ({ construct: "strikethrough", markers: ["~"], sizes: node.data?.marqueur === "~" ? [1, 2] : [2, 1] }),
});

// Tableaux : ligne de séparation en « --- » comme les agents (ou celle d'origine si les colonnes n'ont pas changé)
const tableauGfm = gestionnaireGfm("table")!;
handlers.table = (node, parent, state, info) => {
  const brut = tableauGfm(node, parent, state, info);
  const lignes = brut.split("\n");
  if (lignes.length > 1) {
    const sep = node.data?.separateur as string | null | undefined;
    const align = (node.align as Array<string | null> | undefined) ?? [];
    if (sep && Number(node.data?.colonnes) === align.length && alignementDe(sep, align.length) === align.map((a) => a ?? "").join(",")) {
      lignes[1] = sep;
    } else {
      lignes[1] = lignes[1].replace(/(\|\s*)(:?)-+(:?)(?=\s*\|)/g, (_m, a, g, d) => `${a}${g}---${d}`);
    }
  }
  return lignes.join("\n");
};

function alignementDe(sep: string, n: number): string {
  const cols = sep.replace(/^\s*\|/, "").replace(/\|\s*$/, "").split("|").map((c) => c.trim());
  if (cols.length !== n) return "?";
  return cols.map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.startsWith(":") ? "left" : c.endsWith(":") ? "right" : "")).join(",");
}

// Pas de ligne vide entre deux blocs qui étaient collés dans le fichier, quand c'est sans danger pour le sens
const SURS_APRES: Record<string, (droite: MNode) => boolean> = {
  heading: (d) => ["paragraph", "list", "code", "blockquote", "heading", "table", "encadre"].includes(d.type),
  paragraph: (d) => (d.type === "list" && (!d.ordered || (d.start ?? 1) === 1)) || d.type === "code" || d.type === "blockquote" || (d.type === "heading" && !d.data?.setext) || d.type === "encadre",
  list: (d) => d.type === "heading" && !d.data?.setext,
  code: (d) => d.type !== "code",
  table: (d) => d.type === "heading" && !d.data?.setext,
  blockquote: (d) => d.type === "heading" && !d.data?.setext,
};

const options: Options = {
  bullet: "-",
  bulletOther: "*",
  emphasis: "_",
  strong: "*",
  rule: "-",
  fence: "`",
  fences: true,
  listItemIndent: "one",
  incrementListMarker: true,
  handlers: handlers as unknown as Options["handlers"],
  extensions: [gfm],
  join: [(gauche, droite, parent) => {
    const g = gauche as unknown as MNode;
    const d = droite as unknown as MNode;
    const p = parent as unknown as MNode;
    const e = d.data?.ecart;
    if (typeof e !== "number") return undefined;
    if (p.type === "root") {
      if (e === 0) return SURS_APRES[g.type]?.(d) ? 0 : undefined;
      return Math.min(e, 4);
    }
    // éléments d'une liste : l'espacement d'origine (une liste « aérée » le reste, une liste serrée aussi)
    if (p.type === "list" && g.type === "listItem") return Math.min(e, 4);
    return undefined;
  }],
};

export function serialiser(arbre: MNode): string {
  return toMarkdown(arbre as never, options);
}

export type { Handle };
