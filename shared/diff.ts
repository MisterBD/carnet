// Carnet · différences de texte (algorithme de Myers, O((N+M)·D)), par lignes puis par mots.
// Sert à l'historique des versions : « ce qui a changé » entre deux contenus d'une page. Aucune dépendance.

export type Op<T> = { type: "=" | "+" | "-"; elements: T[] };

/** Suite minimale d'opérations pour passer de `a` à `b` (« = » commun, « - » retiré de a, « + » ajouté dans b). */
export function differences<T>(a: T[], b: T[], egal: (x: T, y: T) => boolean = (x, y) => x === y, maxD = 4000): Op<T>[] {
  // Préfixe et suffixe communs : la plupart des modifications sont locales.
  let debut = 0;
  while (debut < a.length && debut < b.length && egal(a[debut], b[debut])) debut++;
  let finA = a.length;
  let finB = b.length;
  while (finA > debut && finB > debut && egal(a[finA - 1], b[finB - 1])) { finA--; finB--; }
  const ops: Op<T>[] = [];
  const pousser = (type: Op<T>["type"], els: T[]) => {
    if (!els.length) return;
    const der = ops[ops.length - 1];
    if (der && der.type === type) der.elements.push(...els);
    else ops.push({ type, elements: [...els] });
  };
  pousser("=", a.slice(0, debut));
  const A = a.slice(debut, finA);
  const B = b.slice(debut, finB);
  for (const op of myers(A, B, egal, maxD)) pousser(op.type, op.elements);
  pousser("=", a.slice(finA));
  return ops;
}

function myers<T>(a: T[], b: T[], egal: (x: T, y: T) => boolean, maxD: number): Op<T>[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 && m === 0) return [];
  if (n === 0) return [{ type: "+", elements: [...b] }];
  if (m === 0) return [{ type: "-", elements: [...a] }];
  const max = n + m;
  const decalage = max;
  let v: Int32Array = new Int32Array(2 * max + 2);
  const traces: Int32Array[] = [];
  let trouve = -1;
  const limite = Math.min(max, maxD);
  for (let d = 0; d <= limite; d++) {
    traces.push(v.slice());
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[decalage + k - 1] < v[decalage + k + 1])) x = v[decalage + k + 1];
      else x = v[decalage + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && egal(a[x], b[y])) { x++; y++; }
      v[decalage + k] = x;
      if (x >= n && y >= m) { trouve = d; break; }
    }
    if (trouve !== -1) break;
  }
  if (trouve === -1) {
    // Trop différent : tout remplacer (rare ; évite un calcul déraisonnable sur un fichier réécrit).
    return [{ type: "-", elements: [...a] }, { type: "+", elements: [...b] }];
  }
  // Remontée du chemin.
  const pas: Array<{ type: "=" | "+" | "-"; i: number }> = [];
  let x = n;
  let y = m;
  for (let d = trouve; d > 0; d--) {
    v = traces[d];
    const k = x - y;
    let kPrec: number;
    if (k === -d || (k !== d && v[decalage + k - 1] < v[decalage + k + 1])) kPrec = k + 1;
    else kPrec = k - 1;
    const xPrec = v[decalage + kPrec];
    const yPrec = xPrec - kPrec;
    while (x > xPrec && y > yPrec) { x--; y--; pas.push({ type: "=", i: x }); }
    if (x === xPrec) { y--; pas.push({ type: "+", i: y }); } else { x--; pas.push({ type: "-", i: x }); }
  }
  while (x > 0 && y > 0) { x--; y--; pas.push({ type: "=", i: x }); }
  pas.reverse();
  const ops: Op<T>[] = [];
  for (const p of pas) {
    const el = p.type === "+" ? b[p.i] : a[p.i];
    const der = ops[ops.length - 1];
    if (der && der.type === p.type) der.elements.push(el);
    else ops.push({ type: p.type, elements: [el] });
  }
  return ops;
}

/** Découpe une ligne en mots, espaces et ponctuation (les espaces restent attachés pour un rendu fidèle). */
export function mots(ligne: string): string[] {
  return ligne.match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_'’-]/gu) ?? [];
}

export interface Morceau { type: "=" | "+" | "-"; texte: string }

/** Une ligne modifiée : différences au niveau du mot entre l'ancienne et la nouvelle ligne. */
export function differencesMots(avant: string, apres: string): Morceau[] {
  return differences(mots(avant), mots(apres)).map((o) => ({ type: o.type, texte: o.elements.join("") }));
}

export type LigneDiff =
  | { type: "="; texte: string; avant: number; apres: number }
  | { type: "+"; texte: string; apres: number }
  | { type: "-"; texte: string; avant: number }
  | { type: "~"; morceaux: Morceau[]; avant: number; apres: number };

/**
 * Différences par lignes, puis par mots pour les lignes remplacées une à une (bloc « - » suivi d'un bloc « + » :
 * chaque paire de lignes assez proches devient une ligne « ~ » avec ses mots changés).
 */
export function differencesLignes(avant: string, apres: string): LigneDiff[] {
  const a = avant.split("\n");
  const b = apres.split("\n");
  const ops = differences(a, b);
  const res: LigneDiff[] = [];
  let ia = 0;
  let ib = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.type === "=") {
      for (const l of op.elements) res.push({ type: "=", texte: l, avant: ia++, apres: ib++ });
      continue;
    }
    if (op.type === "-" && ops[k + 1]?.type === "+") {
      const sup = op.elements;
      const aj = ops[k + 1].elements;
      const n = Math.min(sup.length, aj.length);
      for (let i = 0; i < n; i++) {
        if (proches(sup[i], aj[i])) res.push({ type: "~", morceaux: differencesMots(sup[i], aj[i]), avant: ia++, apres: ib++ });
        else {
          res.push({ type: "-", texte: sup[i], avant: ia++ });
          res.push({ type: "+", texte: aj[i], apres: ib++ });
        }
      }
      for (let i = n; i < sup.length; i++) res.push({ type: "-", texte: sup[i], avant: ia++ });
      for (let i = n; i < aj.length; i++) res.push({ type: "+", texte: aj[i], apres: ib++ });
      k++;
      continue;
    }
    if (op.type === "-") for (const l of op.elements) res.push({ type: "-", texte: l, avant: ia++ });
    else for (const l of op.elements) res.push({ type: "+", texte: l, apres: ib++ });
  }
  return res;
}

/** Deux lignes « proches » : au moins 40 % de mots en commun (sinon on montre suppression + ajout). */
function proches(x: string, y: string): boolean {
  if (!x.trim() || !y.trim()) return false;
  const mx = mots(x).filter((t) => t.trim());
  const my = mots(y).filter((t) => t.trim());
  if (!mx.length || !my.length) return false;
  const communs = differences(mx, my).filter((o) => o.type === "=").reduce((s, o) => s + o.elements.length, 0);
  return communs / Math.max(mx.length, my.length) >= 0.4;
}

/** Résumé chiffré d'un diff : mots ajoutés et retirés. */
export function bilan(lignes: LigneDiff[]): { ajouts: number; retraits: number } {
  let ajouts = 0;
  let retraits = 0;
  const compter = (t: string) => mots(t).filter((m) => /[\p{L}\p{N}]/u.test(m)).length;
  for (const l of lignes) {
    if (l.type === "+") ajouts += compter(l.texte);
    else if (l.type === "-") retraits += compter(l.texte);
    else if (l.type === "~") for (const m of l.morceaux) { if (m.type === "+") ajouts += compter(m.texte); else if (m.type === "-") retraits += compter(m.texte); }
  }
  return { ajouts, retraits };
}
