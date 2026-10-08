// Carnet · découpage d'une page Markdown (partagé serveur + interface).
// Aucune dépendance : importable par Node 22 (types retirés à la volée) et par Vite.
//
// Une page = [frontmatter YAML brut] + [bloc titre « # Titre » s'il ouvre le corps] + [corps].
// Le frontmatter et le bloc titre sont conservés OCTET POUR OCTET : l'éditeur ne voit que le corps.

export interface Decoupe {
  /** Frontmatter brut, délimiteurs et saut de ligne final compris ("" s'il n'y en a pas). */
  frontmatter: string;
  /** Contenu YAML entre les délimiteurs (sans eux). */
  yaml: string;
  /** Bloc titre brut : lignes vides de tête + ligne « # Titre » + lignes vides qui suivent ("" sinon). */
  blocTitre: string;
  /** Texte du H1 (sans les #, sans # de fermeture), ou null. */
  titreH1: string | null;
  /** Le reste : ce que l'éditeur affiche et réécrit. */
  corps: string;
}

const RE_FM = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/;
const RE_H1 = /^ {0,3}#[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;

export function decouper(contenu: string): Decoupe {
  let frontmatter = "";
  let yaml = "";
  let reste = contenu;
  // Marque d'ordre des octets éventuelle : gardée telle quelle, devant le frontmatter.
  const bom = contenu.startsWith("\uFEFF") ? "\uFEFF" : "";
  const m = RE_FM.exec(bom ? contenu.slice(1) : contenu);
  if (m) {
    frontmatter = bom + m[0];
    yaml = m[1] ?? "";
    reste = contenu.slice(bom.length + m[0].length);
  }
  // Bloc titre : lignes vides éventuelles, puis un H1 ATX (« # Titre », pas « #etiquette »).
  let blocTitre = "";
  let titreH1: string | null = null;
  let i = 0;
  const n = reste.length;
  // sauter les lignes vides
  let debutLigne = 0;
  while (i < n) {
    const fin = reste.indexOf("\n", i);
    const ligne = reste.slice(i, fin === -1 ? n : fin).replace(/\r$/, "");
    if (ligne.trim() === "") {
      if (fin === -1) { i = n; break; }
      i = fin + 1;
      continue;
    }
    debutLigne = i;
    const h = RE_H1.exec(ligne);
    if (h) {
      titreH1 = h[1].trim();
      let j = fin === -1 ? n : fin + 1;
      // avaler les lignes vides qui suivent
      while (j < n) {
        const f2 = reste.indexOf("\n", j);
        const l2 = reste.slice(j, f2 === -1 ? n : f2).replace(/\r$/, "");
        if (l2.trim() !== "") break;
        j = f2 === -1 ? n : f2 + 1;
      }
      blocTitre = reste.slice(0, j);
      reste = reste.slice(j);
    }
    break;
  }
  void debutLigne;
  return { frontmatter, yaml, blocTitre, titreH1, corps: reste };
}

/** Réassemble une page. `titre` remplace le texte du H1 existant en gardant son habillage. */
export function assembler(d: Decoupe, corps: string, nouveauTitreH1?: string | null): string {
  let blocTitre = d.blocTitre;
  if (nouveauTitreH1 != null && d.titreH1 != null && nouveauTitreH1 !== d.titreH1) {
    blocTitre = remplacerTexteH1(d.blocTitre, nouveauTitreH1);
  }
  return d.frontmatter + blocTitre + corps;
}

export function remplacerTexteH1(blocTitre: string, texte: string): string {
  const lignes = blocTitre.split("\n");
  for (let k = 0; k < lignes.length; k++) {
    const cr = lignes[k].endsWith("\r") ? "\r" : "";
    const l = cr ? lignes[k].slice(0, -1) : lignes[k];
    const h = RE_H1.exec(l);
    if (h) {
      const indent = /^ */.exec(l)![0];
      lignes[k] = `${indent}# ${texte.replace(/\s*\n\s*/g, " ").trim()}${cr}`;
      break;
    }
  }
  return lignes.join("\n");
}

// ---------------------------------------------------------------------------------------------
// Frontmatter : lecture simple des clés de premier niveau et modification À LA LIGNE PRÈS
// (on ne réécrit jamais tout le YAML : le reste du fichier des agents reste intact).
// ---------------------------------------------------------------------------------------------

const RE_CLE = /^([A-Za-z_][\w-]*)[ \t]*:(.*)$/;

/** Valeur scalaire d'une clé de premier niveau (sans guillemets), ou undefined. Pour l'affichage seulement. */
export function lireChampSimple(yaml: string, cle: string): string | undefined {
  for (const brut of yaml.split("\n")) {
    const l = brut.replace(/\r$/, "");
    const m = RE_CLE.exec(l);
    if (m && m[1] === cle) {
      const v = m[2].trim();
      if (v === "" || v === "|" || v === ">") return undefined;
      return deguillemeter(v);
    }
  }
  return undefined;
}

function deguillemeter(v: string): string {
  const s = v.replace(/\s+#.*$/, "");
  if ((s.startsWith('"') && s.endsWith('"') && s.length >= 2)) {
    try { return JSON.parse(s); } catch { return s.slice(1, -1); }
  }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** Met une valeur YAML scalaire entre guillemets si nécessaire. */
export function scalaireYaml(v: string): string {
  if (v === "") return '""';
  const sur = /^[^\s:#\-?\[\]{},&*!|>'"%@`][^:#\n]*$/u.test(v) && !/\s$/.test(v)
    && !/^(true|false|null|yes|no|on|off|~|[-+]?\d[\d._]*(e[-+]?\d+)?)$/i.test(v);
  return sur ? v : JSON.stringify(v);
}

/**
 * Pose (ou retire, valeur null) une clé scalaire de premier niveau dans le frontmatter brut.
 * - clé présente sur une ligne « cle: valeur » simple : seule cette ligne change ;
 * - clé absente : ajoutée juste avant le délimiteur de fin ;
 * - pas de frontmatter : un bloc minimal est créé.
 * Renvoie le nouveau frontmatter brut (délimiteurs compris).
 */
export function poserChamp(frontmatter: string, cle: string, valeur: string | null): string {
  if (!frontmatter) {
    if (valeur == null) return "";
    return `---\n${cle}: ${scalaireYaml(valeur)}\n---\n`;
  }
  const nl = frontmatter.includes("\r\n") ? "\r\n" : "\n";
  const lignes = frontmatter.split(/\r?\n/);
  // lignes[0] = '---' ; dernière ligne non vide = délimiteur de fin
  let fin = lignes.length - 1;
  while (fin > 0 && lignes[fin].trim() === "") fin--;
  for (let k = 1; k < fin; k++) {
    const m = RE_CLE.exec(lignes[k]);
    if (m && m[1] === cle) {
      // valeur multiligne (bloc indenté, ou liste « - x » en colonne 0 façon PyYAML) : on remplace la ligne ET le
      // bloc ; les lignes vides ne comptent que si le bloc continue après elles.
      const vide = m[2].trim() === "";
      let k2 = k + 1;
      if (vide) {
        let j = k + 1;
        while (j < fin) {
          const l = lignes[j];
          if (/^[ \t]+\S/.test(l) || /^-( |$)/.test(l)) { k2 = j + 1; j++; continue; }
          if (/^[ \t]*$/.test(l)) { j++; continue; }
          break;
        }
      }
      const blocIndente = vide && k2 > k + 1;
      const nbASupprimer = blocIndente ? k2 - k : 1;
      if (valeur == null) lignes.splice(k, nbASupprimer);
      else lignes.splice(k, nbASupprimer, `${cle}: ${scalaireYaml(valeur)}`);
      return lignes.join(nl);
    }
  }
  if (valeur == null) return frontmatter;
  lignes.splice(fin, 0, `${cle}: ${scalaireYaml(valeur)}`);
  return lignes.join(nl);
}

// ---------------------------------------------------------------------------------------------
// Noms de pages et chemins
// ---------------------------------------------------------------------------------------------

/** Nom de fichier sûr à partir d'un titre saisi (sans extension). */
export function nomDeFichier(titre: string): string {
  let s = titre.normalize("NFC")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/[\/\\:*?"<>|#\[\]^]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "")
    .replace(/[. ]+$/, "");
  if (s.length > 120) s = s.slice(0, 120).trim();
  return s || "Sans titre";
}

/** « Démo/Page riche.md » -> « Démo/Page riche » (nom de page, forme des liens [[...]]). */
export function nomDePage(chemin: string): string {
  return chemin.replace(/\.md$/i, "");
}

/** Dernier segment lisible d'un chemin de page. */
export function feuille(chemin: string): string {
  const n = nomDePage(chemin);
  const i = n.lastIndexOf("/");
  return i === -1 ? n : n.slice(i + 1);
}

/** Dossier contenant la page (« » pour la racine). */
export function dossierDe(chemin: string): string {
  const i = chemin.lastIndexOf("/");
  return i === -1 ? "" : chemin.slice(0, i);
}

/** Résout un chemin relatif (« ../x/y.png ») depuis le dossier d'une page. null s'il sort de l'espace. */
export function resoudre(dossier: string, relatif: string): string | null {
  if (/^[a-z][a-z0-9+.-]*:/i.test(relatif) || relatif.startsWith("//")) return null;
  let r = relatif.split("#")[0].split("?")[0];
  try { r = decodeURIComponent(r); } catch { /* garder tel quel */ }
  const base = r.startsWith("/") ? [] : (dossier ? dossier.split("/") : []);
  for (const seg of r.split("/")) {
    if (seg === "" || seg === ".") continue;
    if (seg === "..") { if (!base.length) return null; base.pop(); continue; }
    base.push(seg);
  }
  return base.join("/");
}

/** Normalisation pour la recherche : minuscules, sans accents. */
export function plier(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}
