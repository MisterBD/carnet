// Carnet · expressions régulières en temps linéaire sur le contenu des pages (une page piégée ne bloque pas le serveur).
// Chaque remplacement est comparé à l'expression d'origine sur des milliers de lignes aléatoires courtes (où l'origine
// reste rapide), puis chronométré sur une ligne piégée longue.
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { lireChampListe, lireSousTitre, normaliserProposition, rubriquesVides } from "../../shared/decision.ts";
import { sansBlancsFinaux } from "../../shared/page.ts";
import { analyserTache } from "../../shared/taches.ts";
import { sansCommentairesHtml } from "../src/preparation.ts";

let graine = 12345;
const hasard = (n: number) => { graine = (graine * 1103515245 + 12345) % 2147483648; return graine % n; };
const ligne = (alphabet: string[], max: number) => Array.from({ length: hasard(max + 1) }, () => alphabet[hasard(alphabet.length)]).join("");
const ESSAIS = 20_000;
const rapide = (f: () => void, ms = 1500) => { const t0 = performance.now(); f(); const d = performance.now() - t0; assert.ok(d < ms, `trop lent : ${Math.round(d)} ms`); };

describe("équivalence avec les expressions d'origine", () => {
  test("sansBlancsFinaux = replace(/[ \\t]+$/, \"\")", () => {
    const A = [" ", "\t", "a", "\u00a0", "\n", "#"];
    for (let i = 0; i < ESSAIS; i++) { const l = ligne(A, 12); assert.equal(sansBlancsFinaux(l), l.replace(/[ \t]+$/, ""), JSON.stringify(l)); }
  });
  test("lireSousTitre = /^###[ \\t]+(.*?)[ \\t#]*$/", () => {
    const A = ["#", " ", "\t", "a", "\u2028", "\r", "x"];
    for (let i = 0; i < ESSAIS; i++) {
      const l = (hasard(3) ? "###" : "") + ligne(A, 10);
      const o = /^###[ \t]+(.*?)[ \t#]*$/.exec(l);
      const n = lireSousTitre(l);
      assert.deepEqual(n ? n[1] : null, o ? o[1] : null, JSON.stringify(l));
    }
  });
  test("lireChampListe = /^[-*+][ \\t]+([^:]+?)[ \\t\\u00a0\\u202f]*:[ \\t\\u00a0\\u202f]*(.*)$/", () => {
    const A = ["-", "*", "+", " ", "\t", ":", "a", "\u00a0", "\u202f", "\u2028", "é"];
    for (let i = 0; i < ESSAIS; i++) {
      const l = (hasard(3) ? ["- ", "* ", "+\t", "-  "][hasard(4)] : "") + ligne(A, 10);
      const o = /^[-*+][ \t]+([^:]+?)[ \t\u00a0\u202f]*:[ \t\u00a0\u202f]*(.*)$/.exec(l);
      const n = lireChampListe(l);
      assert.deepEqual(n ? [n[1], n[2]] : null, o ? [o[1], o[2]] : null, JSON.stringify(l));
    }
  });
  test("sansCommentairesHtml = replace(/<!--[\\s\\S]*?-->/g, \" \")", () => {
    const A = ["<!--", "-->", "<", "!", "-", ">", "a", "\n"];
    for (let i = 0; i < ESSAIS; i++) { const l = ligne(A, 10); assert.equal(sansCommentairesHtml(l), l.replace(/<!--[\s\S]*?-->/g, " "), JSON.stringify(l)); }
  });
});

describe("lignes piégées : temps linéaire", () => {
  const ESP = " ".repeat(200_000);
  test("tâches : longues suites d'espaces, d'étiquettes et de marqueurs", () => {
    rapide(() => {
      analyserTache("- [ ] a" + ESP + "x");
      analyserTache("- [ ] a" + ESP + "#x y");
      analyserTache("- [ ] a" + ESP + "^x y");
      analyserTache("- [ ] a" + ESP + "📅 x");
      analyserTache("- [ ] " + "#a ".repeat(50_000) + "!");
    });
  });
  test("décisions : rubriques, champs et sous-titres", () => {
    rapide(() => {
      lireChampListe("- " + ESP + "x");
      lireChampListe("- a" + ESP + "x:");
      lireSousTitre("### a" + ESP + "x");
      normaliserProposition(("a" + ESP + "x\n").repeat(3));
      rubriquesVides("## Proposition\n\n- Objet :\n" + "a" + " ".repeat(20_000) + "x\n- Action demandée :\n");
    });
  });
  test("commentaires HTML non fermés", () => {
    rapide(() => sansCommentairesHtml("<!--".repeat(500_000)));
  });
});
