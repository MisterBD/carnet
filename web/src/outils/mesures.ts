// Mesures de fidélité Markdown (mêmes définitions que le banc de comparaison des éditeurs) : comparaison texte, « même rendu »
// (arbres CommonMark + GFM égaux à l'espacement près), constructions préservées ou perdues, lignes touchées hors bloc.
import { analyserBrut } from "../editeur/markdown/analyse.ts";
import type { MNode } from "../editeur/markdown/mdast.ts";

const sansFinLigne = (s: string) => s.replace(/\n+$/, "");
export const memeTexte = (a: string, b: string) => sansFinLigne(a) === sansFinLigne(b);

function versChaine(n: MNode): string {
  if (typeof n.value === "string") return n.value;
  if (n.type === "image") return n.alt ?? "";
  return (n.children ?? []).map(versChaine).join("");
}

function normaliser(n: unknown): unknown {
  if (Array.isArray(n)) return n.map(normaliser);
  if (!n || typeof n !== "object") return n;
  const o: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(n as Record<string, unknown>).sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    if (k === "position" || k === "spread" || k === "data") continue;
    o[k] = normaliser(v);
  }
  if (Array.isArray(o.children)) {
    const enf: Array<Record<string, unknown>> = [];
    for (const c of o.children as Array<Record<string, unknown>>) {
      const d = enf[enf.length - 1];
      if (c.type === "text" && d?.type === "text") d.value = String(d.value) + String(c.value);
      else enf.push({ ...c });
    }
    for (const c of enf) if (c.type === "text") c.value = String(c.value).replace(/\s+/g, " ");
    o.children = enf.filter((c) => !(c.type === "text" && c.value === ""));
  }
  if (o.type === "html") o.value = String(o.value).trim();
  return o;
}

function visiter(n: MNode, f: (n: MNode, parents: MNode[]) => void, parents: MNode[] = []): void {
  f(n, parents);
  for (const c of n.children ?? []) visiter(c, f, [...parents, n]);
}

function resoudreReferences(arbre: MNode): MNode {
  const defs = new Map<string, MNode>();
  visiter(arbre, (n) => { if (n.type === "definition") defs.set(String(n.identifier), n); });
  const remplacer = (n: MNode): MNode => {
    if (!n.children) return n;
    n.children = n.children.filter((c) => c.type !== "definition").map((c) => {
      const d = defs.get(String(c.identifier));
      if (c.type === "linkReference" && d) return remplacer({ type: "link", url: d.url, title: d.title ?? null, children: c.children });
      if (c.type === "imageReference" && d) return { type: "image", url: d.url, title: d.title ?? null, alt: c.alt };
      return remplacer(c);
    });
    return n;
  };
  return remplacer(arbre);
}

export function memeRendu(a: string, b: string): boolean {
  try {
    return JSON.stringify(normaliser(resoudreReferences(analyserBrut(a)))) === JSON.stringify(normaliser(resoudreReferences(analyserBrut(b))));
  } catch { return false; }
}

function texteBrut(n: MNode): string {
  if (n.type === "break") return " ";
  if (typeof n.value === "string") return n.value;
  if (n.type === "image") return n.alt ?? "";
  return (n.children ?? []).map(texteBrut).join(n.type === "root" || n.type === "list" || n.type === "blockquote" ? " " : "");
}

const RE_WIKI = /(?<!\\)\[\[([^\]\n]+)\]\]/g;
const RE_ALERTE = /^ {0,3}>[ \t]*\[!([A-Za-z]+)\]([+-]?)/gm;

export function constructions(md: string) {
  const arbre = analyserBrut(md);
  const c = {
    tableaux: [] as string[], alignements: [] as string[], taches: [] as string[], mermaid: [] as string[], code: [] as string[],
    html: [] as string[], imbrications: [] as string[], sauts: 0, images: [] as string[], liens: [] as string[], titres: [] as string[],
    wikiliens: [] as string[], alertes: [] as string[], texte: "",
  };
  visiter(arbre, (n, parents) => {
    if (n.type === "table") {
      c.tableaux.push(JSON.stringify((n.children ?? []).map((r) => (r.children ?? []).map((x) => versChaine(x).trim()))));
      c.alignements.push(JSON.stringify(n.align ?? []));
    } else if (n.type === "listItem" && typeof n.checked === "boolean") {
      c.taches.push(`${n.checked ? "x" : " "} ${versChaine(n.children?.[0] ?? { type: "text", value: "" }).trim()}`);
    } else if (n.type === "code") {
      (n.lang === "mermaid" ? c.mermaid : c.code).push(`${n.lang ?? ""}\n${n.value}`);
    } else if (n.type === "html") {
      c.html.push(String(n.value).trim());
    } else if (n.type === "list" && parents.some((p) => p.type === "listItem")) {
      c.imbrications.push(`${parents.filter((p) => p.type === "list").length}:${n.children?.length}`);
    } else if (n.type === "break") {
      c.sauts++;
    } else if (n.type === "image") {
      c.images.push(`${n.url}|${n.alt ?? ""}|${n.title ?? ""}`);
    } else if (n.type === "link") {
      c.liens.push(`${n.url}|${versChaine(n)}`);
    } else if (n.type === "heading") {
      c.titres.push(`${n.depth}:${versChaine(n)}`);
    }
  });
  c.wikiliens = [...md.matchAll(RE_WIKI)].map((m) => m[1]);
  c.alertes = [...md.matchAll(RE_ALERTE)].map((m) => m[1].toUpperCase() + m[2]);
  c.texte = texteBrut(arbre).replace(/\s+/g, " ").trim();
  return c;
}

const egal = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/** Constructions présentes dans l'original : « intact » ou le type de perte. */
export function pertes(original: string, sortie: string): Record<string, string> {
  const a = constructions(original);
  const b = constructions(sortie);
  const r: Record<string, string> = {};
  if (a.tableaux.length) {
    if (!egal(a.tableaux, b.tableaux)) r.tableaux = b.tableaux.length < a.tableaux.length ? "perdu" : "cellules altérées";
    else r.tableaux = egal(a.alignements, b.alignements) ? "intact" : "alignement des colonnes perdu";
  }
  if (a.taches.length) r.taches = egal(a.taches, b.taches) ? "intact" : b.taches.length ? "altéré" : "perdu";
  if (a.alertes.length) r.alertes = egal(a.alertes, b.alertes) ? "intact" : /\\\[!/.test(sortie) ? "échappé" : "perdu";
  if (a.mermaid.length) r.mermaid = egal(a.mermaid, b.mermaid) ? "intact" : "altéré";
  if (a.code.length) r.code = egal(a.code, b.code) ? "intact" : "altéré";
  if (a.wikiliens.length) r.wikiliens = egal(a.wikiliens, b.wikiliens) ? "intact" : "perdu ou échappé";
  if (a.html.length) r.html = egal(a.html, b.html) ? "intact" : b.html.length ? "partiellement converti" : "converti ou perdu";
  if (a.imbrications.length) r.listesImbriquees = egal(a.imbrications, b.imbrications) ? "intact" : "structure changée";
  if (a.sauts) {
    if (a.sauts !== b.sauts) r.sautsDeLigne = "perdu";
    else {
      const forme = (s: string) => (s.match(/ {2,}\n/g) ?? []).length + ":" + (s.match(/\\\n/g) ?? []).length;
      r.sautsDeLigne = forme(original) === forme(sortie) ? "intact" : "forme changée (même rendu)";
    }
  }
  if (a.images.length) r.images = egal(a.images, b.images) ? "intact" : b.images.length < a.images.length ? "perdu" : "altéré";
  if (a.liens.length) r.liens = egal(a.liens, b.liens) ? "intact" : "altéré";
  r.texte = a.texte === b.texte ? "intact" : "texte modifié";
  return r;
}

export function opcodes(a: string[], b: string[]): Array<[string, number, number, number, number]> {
  let d = 0;
  while (d < a.length && d < b.length && a[d] === b[d]) d++;
  let fa = a.length, fb = b.length;
  while (fa > d && fb > d && a[fa - 1] === b[fb - 1]) { fa--; fb--; }
  const m = fa - d, n = fb - d;
  const ops: Array<[string, number, number, number, number]> = [];
  if (m * n > 25_000_000) { ops.push(["replace", d, fa, d, fb]); return ops; }
  const L = n + 1;
  const dp = new Uint32Array((m + 1) * (n + 1));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--)
    dp[i * L + j] = a[d + i] === b[d + j] ? dp[(i + 1) * L + j + 1] + 1 : Math.max(dp[(i + 1) * L + j], dp[i * L + j + 1]);
  let i = 0, j = 0, ci = 0, cj = 0;
  const vider = () => { if (i > ci || j > cj) ops.push([i > ci && j > cj ? "replace" : i > ci ? "delete" : "insert", d + ci, d + i, d + cj, d + j]); };
  while (i < m && j < n) {
    if (a[d + i] === b[d + j]) { vider(); i++; j++; ci = i; cj = j; }
    else if (dp[(i + 1) * L + j] >= dp[i * L + j + 1]) i++;
    else j++;
  }
  i = m; j = n; vider();
  return ops;
}

export function lignesChangees(a: string, b: string): number {
  return opcodes(a.split("\n"), b.split("\n")).reduce((s, [, i1, i2, j1, j2]) => s + (i2 - i1) + (j2 - j1), 0);
}

/** Lignes originales touchées hors de [debut, fin) (bloc modifié). */
export function horsBloc(original: string, apres: string, debut: number, fin: number): string[] {
  const lignes = (t: string) => { const u = t.replace(/\n+$/, ""); return u === "" ? [] : u.split("\n"); };
  const A = lignes(original);
  const B = lignes(apres);
  const hors: string[] = [];
  for (const [op, i1, i2, j1, j2] of opcodes(A, B)) {
    if (op === "insert") { if (!(debut <= i1 && i1 <= fin)) hors.push(`+ ${B.slice(j1, j2).join(" ⏎ ")}`.slice(0, 160)); }
    else if (!(debut <= i1 && i2 <= fin)) hors.push(`${op} ${A.slice(i1, i2).join(" ⏎ ")} → ${B.slice(j1, j2).join(" ⏎ ")}`.slice(0, 200));
  }
  return hors;
}

/** Lignes [debut, fin) du premier paragraphe de premier niveau avec du texte, et de la 1re liste avec une case. */
export function blocsCibles(corps: string): { paragraphe: [number, number] | null; tache: [number, number] | null } {
  const arbre = analyserBrut(corps);
  const lignes = (n: MNode): [number, number] => [(n.position!.start.line ?? 1) - 1, n.position!.end.line ?? 1];
  let paragraphe: [number, number] | null = null, tache: [number, number] | null = null;
  for (const n of arbre.children ?? []) {
    if (!paragraphe && n.type === "paragraph") {
      let texte = false;
      visiter(n, (x) => { if ((x.type === "text" || x.type === "inlineCode") && String(x.value).trim()) texte = true; });
      if (texte) paragraphe = lignes(n);
    }
    if (!tache) {
      let trouve = false;
      visiter(n, (x) => { if (x.type === "listItem" && typeof x.checked === "boolean") trouve = true; });
      if (trouve) tache = lignes(n);
    }
  }
  return { paragraphe, tache };
}

export function texteDeMd(md: string): string {
  return versChaine(analyserBrut(md));
}

export const CAS: Array<[string, string, ((s: string) => boolean) | null]> = [
  ["Frontmatter YAML", "---\ntitle: Essai\ntags: [a, b]\nstatut: en cours\n---\n\nTexte.", (s) => /^---\ntitle: Essai\ntags: \[a, b\]\nstatut: en cours\n---/.test(s)],
  ["Retour à la ligne simple (paragraphe coupé)", "Une phrase coupée\nau milieu par l'agent.", (s) => /coupée\s+au milieu/.test(s)],
  ["Saut de ligne forcé (deux espaces)", "Adresse :  \n12 rue du Port", null],
  ["Saut de ligne forcé (antislash)", "Adresse :\\\n12 rue du Port", null],
  ["Gras, italique _ et *", "Un **gras**, un _italique_ et un *autre*.", null],
  ["Puces « - »", "- un\n- deux", null],
  ["Puces « * »", "* un\n* deux", null],
  ["Liste numérotée à partir de 3", "3. trois\n4. quatre", null],
  ["Listes imbriquées (3 niveaux)", "- a\n  - b\n    - c\n- d", null],
  ["Liste aérée (lignes vides)", "- a\n\n- b", null],
  ["Titre collé à une liste", "## Titre\n- a\n- b", null],
  ["Cases à cocher", "- [ ] à faire\n- [x] fait", null],
  ["Cases imbriquées", "- [ ] parent\n  - [x] enfant", null],
  ["Tableau simple", "| a | b |\n| --- | --- |\n| 1 | 2 |", null],
  ["Tableau aligné", "| a | b | c |\n|:---|:---:|---:|\n| 1 | 2 | 3 |", null],
  ["Tableau avec cellule vide et barre échappée", "| a | b |\n| --- | --- |\n|  | x \\| y |", null],
  ["Alerte GFM", "> [!NOTE]\n> Contexte utile.", (s) => /^> \[!NOTE\]\n> Contexte utile\./m.test(s)],
  ["Alerte avec titre", "> [!WARNING] À vérifier\n> Facture non validée.", (s) => /^> \[!WARNING\] À vérifier\n> Facture non validée\./m.test(s)],
  ["Citation simple", "> Une citation.", null],
  ["Lien de page [[…]]", "Voir [[Projets/Refonte]] et [[Accueil|l'accueil]].", (s) => /(?<!\\)\[\[Projets\/Refonte\]\].*(?<!\\)\[\[Accueil\|l'accueil\]\]/.test(s)],
  ["Lien Markdown", "Un [lien](https://example.org \"titre\").", null],
  ["URL nue", "Voir https://example.org/page pour le détail.", (s) => /Voir https:\/\/example\.org\/page pour/.test(s)],
  ["Image avec titre", "![Légende](_assets/x.png \"titre\")", null],
  ["Image seule sans titre", "![Mer au petit matin](_assets/mer.webp)", null],
  ["Bloc mermaid", "```mermaid\nflowchart LR\n  A --> B\n```", null],
  ["Bloc vega-lite (langage inconnu)", "```vega-lite\n{\"mark\": \"bar\"}\n```", null],
  ["Bloc de code ~~~", "~~~python\nprint(1)\n~~~", null],
  ["HTML bloc <details>", "<details>\n<summary>Résumé</summary>\nContenu caché.\n</details>", (s) => /<details>[\s\S]*<summary>Résumé<\/summary>[\s\S]*<\/details>/.test(s)],
  ["HTML en ligne <kbd>", "Tape <kbd>Ctrl</kbd> + <kbd>K</kbd>.", (s) => /<kbd>Ctrl<\/kbd>/.test(s)],
  ["Note de bas de page", "Un fait[^1].\n\n[^1]: La source.", (s) => /\[\^1\]: La source/.test(s)],
  ["Maths $…$", "L'aire vaut $\\pi r^2$.", (s) => /\$\\pi r\^2\$/.test(s)],
  ["Séparateur ---", "Avant\n\n---\n\nAprès", null],
  ["Référence de lien", "Voir [la doc][1].\n\n[1]: https://example.org", null],
  ["Caractères à échapper", "Prix : 10 * 3 = 30 et chemin ~/.cache, crochets [2026-07-30].", null],
  ["Mention et signature", "-- @camille", null],
  ["Emoji et insécables", "Statut : 🟢 OK « entre guillemets »", null],
  ["Paragraphes séparés de 2 lignes vides", "Un.\n\n\nDeux.", null],
  // Nouveautés de Carnet V1 (grammaire fermée)
  ["Repliable aéré", "<details>\n<summary>Titre</summary>\n\nContenu **riche**.\n\n- a\n- b\n\n</details>", null],
  ["Repliable ouvert", "<details open>\n<summary>Ouvert</summary>\n\nTexte.\n\n</details>", null],
  ["Couleur de texte", "Un <span color=\"red\">mot rouge</span> et un <span color=\"blue_bg\">fond bleu</span>.", null],
  ["Surlignage == et <mark>", "Un ==passage surligné== et un <mark>autre</mark>.", null],
  ["Souligné", "Un mot <u>souligné</u>.", null],
  ["HTML hors grammaire", "Un <span style=\"color:red\">piège</span> et <script>alert(1)</script>.", null],
  ["Sommaire", "<!-- sommaire -->\n\n## Un\n\n## Deux", null],
  ["Date (lien de journal)", "Rendez-vous le [[2026-10-08]].", null],
  ["Encadré avec titre riche", "> [!TIP] **Bon** à savoir\n> Texte.", null],
  ["Liste ordonnée avec parenthèse", "1) un\n2) deux", null],
  ["Titre souligné (setext)", "Titre\n=====\n\nTexte.", null],
  ["Séparateur ***", "Avant\n\n***\n\nAprès", null],
  ["Barré simple ~", "Un ~mot~ barré.", null],
  ["Gras __", "Un __gras__ ici.", null],
  ["Tâche vide", "- [ ]\n- [x] faite", null],
  ["Lignes vides voulues entre deux blocs", "Un.\n\n\n\nDeux.", null],
  ["Bloc HTML hors grammaire", "<div class=\"x\">brut</div>\n\nTexte.", null],
];
