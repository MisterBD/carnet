// Fidélité Markdown : quand la personne modifie une page, seuls les blocs qu'elle a touchés sont réécrits.
//
// N0 = sérialisation de la page telle qu'ouverte (forme « normalisée » par l'éditeur),
// N1 = sérialisation après modification. On aligne les blocs de premier niveau de N1 sur ceux de N0
// (plus longue sous-suite commune, par texte) ; un bloc inchangé est remplacé par le texte ORIGINAL du fichier,
// octet pour octet (et les séparateurs originaux entre deux blocs originaux consécutifs sont gardés).
// Si l'alignement original <-> N0 n'est pas sûr (nombre ou types de blocs différents), on renvoie N1 tel quel.

export type Analyseur = (md: string) => { children: Array<{ type: string; position?: { start: { offset?: number }; end: { offset?: number } } }> };

interface Bloc { type: string; debut: number; fin: number; texte: string }

export function decouperBlocs(md: string, analyser: Analyseur): Bloc[] | null {
  let arbre;
  try { arbre = analyser(md); } catch { return null; }
  const res: Bloc[] = [];
  for (const n of arbre.children) {
    const d = n.position?.start.offset;
    const f = n.position?.end.offset;
    if (d == null || f == null) return null;
    res.push({ type: n.type, debut: d, fin: f, texte: md.slice(d, f) });
  }
  return res;
}

function plusLongueSousSuite(a: string[], b: string[]): Array<[number, number]> {
  const m = a.length, n = b.length;
  // Préfixe et suffixe communs d'abord (cas courant : une seule zone modifiée), puis LCS sur le milieu.
  let debut = 0;
  while (debut < m && debut < n && a[debut] === b[debut]) debut++;
  let finA = m, finB = n;
  while (finA > debut && finB > debut && a[finA - 1] === b[finB - 1]) { finA--; finB--; }
  const paires: Array<[number, number]> = [];
  for (let k = 0; k < debut; k++) paires.push([k, k]);
  const ma = finA - debut, nb = finB - debut;
  if (ma > 0 && nb > 0 && ma * nb <= 4_000_000) {
    const dp = new Uint32Array((ma + 1) * (nb + 1));
    const L = nb + 1;
    for (let i = ma - 1; i >= 0; i--) {
      for (let j = nb - 1; j >= 0; j--) {
        dp[i * L + j] = a[debut + i] === b[debut + j] ? dp[(i + 1) * L + j + 1] + 1 : Math.max(dp[(i + 1) * L + j], dp[i * L + j + 1]);
      }
    }
    let i = 0, j = 0;
    while (i < ma && j < nb) {
      if (a[debut + i] === b[debut + j]) { paires.push([debut + i, debut + j]); i++; j++; }
      else if (dp[(i + 1) * L + j] >= dp[i * L + j + 1]) i++;
      else j++;
    }
  }
  for (let k = 0; k < m - finA; k++) paires.push([finA + k, finB + k]);
  return paires;
}

export function fusionner(original: string, n0: string, n1: string, analyser: Analyseur): string {
  if (n1 === n0) return original;
  const O = decouperBlocs(original, analyser);
  const N0 = decouperBlocs(n0, analyser);
  const N1 = decouperBlocs(n1, analyser);
  if (!O || !N0 || !N1) return n1;
  if (O.length !== N0.length || O.some((b, i) => b.type !== N0[i].type)) return n1;
  if (!N1.length) return n1;
  const paires = plusLongueSousSuite(N0.map((b) => b.texte), N1.map((b) => b.texte));
  const garde = new Map<number, number>(); // index N1 -> index original (bloc inchangé : texte original)
  for (const [i, j] of paires) garde.set(j, i);
  // Entre deux blocs gardés, si autant de blocs ont changé de chaque côté, le k-ième nouveau remplace le k-ième
  // ancien : on garde alors les séparateurs originaux autour de lui (pas de ligne vide ajoutée ou retirée).
  const place = new Map<number, number>(garde); // index N1 -> position dans l'original (gardé ou remplacé)
  const bornes: Array<[number, number]> = [[-1, -1], ...paires, [O.length, N1.length]];
  for (let k = 0; k + 1 < bornes.length; k++) {
    const [i1, j1] = bornes[k];
    const [i2, j2] = bornes[k + 1];
    if (i2 - i1 === j2 - j1) {
      for (let d = 1; d < j2 - j1; d++) if (O[i1 + d].type === N1[j1 + d].type) place.set(j1 + d, i1 + d);
    }
  }

  let sortie = "";
  for (let j = 0; j < N1.length; j++) {
    const i = place.get(j);
    const precI = j > 0 ? place.get(j - 1) : undefined;
    // séparateur avant le bloc j
    if (j === 0) {
      sortie += i === 0 ? original.slice(0, O[0].debut) : n1.slice(0, N1[0].debut);
    } else if (i !== undefined && precI !== undefined && precI === i - 1) {
      sortie += original.slice(O[i - 1].fin, O[i].debut);
    } else {
      sortie += n1.slice(N1[j - 1].fin, N1[j].debut);
    }
    const g = garde.get(j);
    sortie += g !== undefined ? O[g].texte : N1[j].texte;
  }
  const derI = place.get(N1.length - 1);
  sortie += derI === O.length - 1 ? original.slice(O[O.length - 1].fin) : n1.slice(N1[N1.length - 1].fin);
  // Filet de sécurité : la fusion doit donner exactement la même suite de blocs que l'éditeur, sinon on écrit N1.
  const verif = decouperBlocs(sortie, analyser);
  if (!verif || verif.length !== N1.length || verif.some((b, k) => b.type !== N1[k].type)) return n1;
  return sortie;
}
