// Carnet · bases (lot 2 V3) : exécution d'une vue tableau sur l'index des pages, et routes de l'API.
//   GET  /api/base?chemin=<page>&bloc=<n>[&vue=<i>]   bloc ```base n° n de la page (sur le disque)
//   POST /api/base/evaluer   { chemin, source, vue }    même chose pour le YAML affiché (éditeur), sans rien écrire
//   POST /api/base/reecrire  { source, vue, changement } nouveau YAML (filtres, tri), ou 422 si non conservable
//   POST /api/base/dossier   { page, nom }              crée le dossier d'une nouvelle base (menu « /base »)
//   GET  /api/proprietes?chemin=<page>                  propriétés typées d'une page (panneau « Propriétés »)
// Les écritures de fichiers (cellule, propriété, nouvelle entrée) passent par l'Ecrivain du socle : voir api.ts.
import fs from "node:fs";
import path from "node:path";
import { dossierDe, nomDeFichier, plier } from "../../shared/page.ts";
import {
  analyserExpression, CLES_PROVENANCE, collateurFr, decrireFiltreSimple, evaluerFiltre, FUSEAU_DEFAUT, Indetermine, lireFiltreSimple, lireReference, trier,
  typeDeValeur,
} from "../../shared/bases.ts";
import type {
  Filtre, Noeud,
  CelluleBase, ColonneBase, DeclarationPropriete, EntreeBase, ErreurBase, FiltreAffiche, LigneBase, ResultatBase,
  ValeurBrute,
} from "../../shared/bases.ts";
import type { Config } from "./config.ts";
import { creerDossiers, lireConfine, lstatOuNull, resoudre, verifierEcriture } from "./disque.ts";
import type { Espace, Page } from "./espace.ts";
import { DOSSIER_MODELES, estModele } from "./espace.ts"; // lot 6
import { chaine, ErreurHttp } from "./http.ts";
import { cheminAutorise, cheminPage, zoneInterdite } from "./securite.ts";
import "./analyseur-yaml.ts";
import { lireProprietes } from "../../shared/proprietes.ts";
import type { TypePropriete as TypeSocle } from "../../shared/proprietes.ts";
import {
  entreeDePage, lireDefinition, MAX_SOURCE_BASE, reecriturePossible, trouverBlocsBase,
} from "./bases-yaml.ts";
import type { ChangementVue, ChangementVues, DeclarationAujourdhui, DefinitionBase, EtatVue } from "./bases-yaml.ts";
import { dateDuJour } from "../../shared/identifiants.ts";
import { lireDate } from "../../shared/bases.ts";

/** Échéances (11/10/2026) : une fiche de base non faite et datée, montrée dans Aujourd'hui à côté des tâches. */
export interface FicheDatee {
  chemin: string;
  titre: string;
  icone: string | null;
  /** Échéance (AAAA-MM-JJ, jour dans le fuseau du carnet). */
  echeance: string;
  priorite?: "plus-haute" | "haute" | "moyenne" | "basse" | "plus-basse";
  anomalies: string[];
  fiche: {
    /** Page qui porte la base (provenance) et son titre. */
    base: string; baseTitre: string; bloc: number;
    /** Révision de la fiche lue (If-Match du geste « cocher »). */
    etag: string;
    /** Propriété et valeur qui veulent dire « fait » (déclarées par la base). */
    propriete: string; valeur: string | boolean;
    /** Valeur actuelle de cette propriété (pour « Annuler ») ; absente = clé absente du fichier. */
    avant?: ValeurBrute; absente?: boolean;
  };
}

/** Priorité d'une fiche (Haute / Moyenne / Basse, et leurs équivalents anglais) ; sinon rien. */
function prioriteDeFiche(v: unknown): FicheDatee["priorite"] | undefined {
  if (typeof v !== "string") return undefined;
  const x = plier(v).trim();
  if (/^(tres haute|critique|urgente?|highest)$/.test(x)) return "plus-haute";
  if (/^(haute|elevee|high|p1)$/.test(x)) return "haute";
  if (/^(moyenne|normale?|medium|p2)$/.test(x)) return "moyenne";
  if (/^(basse|faible|low|p3)$/.test(x)) return "basse";
  if (/^(tres basse|lowest)$/.test(x)) return "plus-basse";
  return undefined;
}

const MAX_LIGNES = 2000;

const LIBELLES_FICHIER: Record<string, string> = {
  name: "Nom", basename: "Nom", path: "Chemin", folder: "Dossier", ext: "Extension", size: "Taille", mtime: "Modifiée le",
  ctime: "Changée le", tags: "Étiquettes",
};

/** Clés gérées par l'en-tête de page (titre, icône, couverture) : pas montrées dans le panneau Propriétés. */
export const CLES_EN_TETE = new Set(["title", "icon", "cover", "pageDecoration"]);

export class Bases {
  cfg: Config;
  espace: Espace;
  #cache = new Map<string, { etag: string; entree: EntreeBase }>();
  #cacheBlocs = new Map<string, { etag: string; blocs: ReturnType<typeof trouverBlocsBase> }>();

  constructor(cfg: Config, espace: Espace) {
    this.cfg = cfg;
    this.espace = espace;
  }

  /** Entrée (typée) d'une page de l'index, mise en cache par etag. */
  entree(p: Page): EntreeBase {
    const c = this.#cache.get(p.chemin);
    if (c && c.etag === p.etag) return c.entree;
    const ctime = Number(p.cle.split(":")[1]);
    const e = entreeDePage({
      chemin: p.chemin, titre: p.titre, icone: p.icone, etag: p.etag, taille: p.taille, mtime: p.mtime,
      ctime: Number.isFinite(ctime) ? Math.floor(ctime) : p.mtime, contenu: p.contenu,
    });
    // même juge que l'écriture (socle) : un en-tête qu'il refusera de modifier est montré en lecture seule
    try {
      const lp = lireProprietes(p.contenu);
      e.nonModifiable = lp.modifiable ? null : (lp.problemes[0] ?? "en-tête non modifiable");
    } catch (x) {
      e.nonModifiable = (x as Error).message;
    }
    this.#cache.set(p.chemin, { etag: p.etag, entree: e });
    return e;
  }

  /**
   * Entrées candidates. Lot 6 : sans les pages archivées ni les modèles, SAUF filtre explicite : une base dont le
   * bloc cite `archive` (ex. `archive == true`, `file.hasProperty("archive")`) voit les pages archivées ; une base qui
   * cite « Modèles » voit les modèles.
   */
  entrees(archives = false, modeles = false): EntreeBase[] {
    const vues = new Set<string>();
    const res: EntreeBase[] = [];
    for (const p of this.espace.pagesVisibles()) {
      vues.add(p.chemin);
      if (!archives && this.espace.archivee(p)) continue;
      if (!modeles && estModele(p.chemin)) continue;
      res.push(this.entree(p));
    }
    if (this.#cache.size > vues.size + 64) for (const k of [...this.#cache.keys()]) if (!vues.has(k)) this.#cache.delete(k);
    return res;
  }

  /**
   * Lot 12 : « maintenant » des expressions (today(), now()). Horloge réelle, sauf recette : CARNET_HORLOGE_ESSAI
   * (fichier qui contient un instant ISO, relu à chaque évaluation pour pouvoir « passer au lendemain »).
   */
  maintenant(): number {
    return horlogeEssai(this.cfg) ?? Date.now();
  }

  /** Exécute la vue `vue` d'une définition. */
  executer(def: DefinitionBase, source: string, vue: number, maintenant = this.maintenant()): ResultatBase {
    const v = def.vues[vue];
    if (!v) throw new ErreurHttp(422, "Vue introuvable dans ce bloc.", "base_invalide", { raison: "base_invalide", erreurs: [{ ou: `views[${vue}]`, message: "Vue introuvable." }] });
    if (!v.prise) {
      throw new ErreurHttp(422, `Vue « ${v.type} » non prise en charge.`, "base_invalide", {
        raison: "base_invalide",
        erreurs: [{ ou: `views[${vue}]`, message: `La vue « ${v.nom} » est de type « ${v.type} » : Carnet n'affiche que les vues tableau (table).` }],
        vues: def.vues.map((x) => ({ nom: x.nom, type: x.type, prise: x.prise })),
      });
    }
    const ctx = { maintenant, fuseau: this.cfg.fuseau || FUSEAU_DEFAUT };
    const retenues: EntreeBase[] = [];
    const nonClassees: ResultatBase["nonClassees"] = [];
    const avecArchives = /\barchive\b/.test(source); // lot 6 : filtre explicite
    const avecModeles = source.normalize("NFC").includes(DOSSIER_MODELES);
    // lot 12 : pages de la base écartées par une comparaison de dates sur une valeur vide ou qui n'est pas une date
    const ecartees = new Map<string, { vides: Set<string>; nonDates: Map<string, string> }>();
    let dansLaBase = 0;
    for (const e of this.entrees(avecArchives, avecModeles)) {
      try {
        if (def.filtre && !evaluerFiltre(def.filtre, e, ctx)) continue;
        dansLaBase++;
        const vus: Array<[string, "vide" | "pas-une-date", string]> = [];
        if (v.filtre && !evaluerFiltre(v.filtre, e, { ...ctx, signaler: (c, n, val) => vus.push([c, n, val]) })) {
          for (const [cle, nature, val] of vus) {
            let x = ecartees.get(cle);
            if (!x) ecartees.set(cle, (x = { vides: new Set(), nonDates: new Map() }));
            if (nature === "vide") x.vides.add(e.chemin);
            else x.nonDates.set(e.chemin, val);
          }
          continue;
        }
        retenues.push(e);
      } catch (x) {
        if (!(x instanceof Indetermine)) throw x;
        if (nonClassees.length < 200) nonClassees.push({ chemin: e.chemin, titre: e.titre, raison: x.raison });
      }
    }
    const triees = trier(retenues, v.tris, ctx.fuseau);
    const limite = v.limite;
    const gardees = triees.slice(0, Math.min(limite ?? MAX_LIGNES, MAX_LIGNES));
    const avertissements = [...def.avertissements];
    if (triees.length > MAX_LIGNES && (limite === null || limite > MAX_LIGNES)) avertissements.push(`Seules les ${MAX_LIGNES} premières pages sont affichées (sur ${triees.length}).`);

    const colonnes = this.#colonnes(def, v.ordre, retenues);
    for (const c of colonnes) if (c.probleme) avertissements.push(`Colonne « ${c.libelle} » : ${c.probleme}`);
    const lignes: LigneBase[] = gardees.map((e) => ({
      chemin: e.chemin, titre: e.titre, icone: e.icone, etag: e.etag, ...(e.nonModifiable ? { nonModifiable: e.nonModifiable } : {}),
      cellules: Object.fromEntries(colonnes.map((c) => [c.id, cellule(c, e)])),
    }));
    nonClassees.sort((a, b) => collateurFr.compare(a.chemin, b.chemin));
    return {
      vues: def.vues.map((x) => ({ nom: x.nom, type: x.type, prise: x.prise })),
      vue, colonnes, lignes, total: triees.length, limite, nonClassees, avertissements, dossier: def.dossier, tri: v.tris,
      filtres: filtresAffiches(v.filtreBrut), filtresGlobaux: decrireFiltres(def.filtreBrut, def.libelles),
      reecriture: reecriturePossible(source, vue),
      ...(ecartees.size ? { exclusions: phrasesExclusions(ecartees, dansLaBase, def.libelles) } : {}),
      // Échéances : déclaration lue (ou null) et propriétés déclarées, pour « Afficher dans Aujourd'hui »
      aujourdhui: def.aujourdhui,
      declarees: [...def.declarations.entries()].map(([cle, d]) => ({
        cle, type: d.type, options: d.options, libelle: def.libelles.get(`note.${cle}`) ?? def.libelles.get(cle) ?? cle,
      })),
    };
  }

  #colonnes(def: DefinitionBase, ordre: string[] | null, entrees: EntreeBase[]): ColonneBase[] {
    let ids = ordre;
    if (!ids) {
      ids = ["file.name", ...[...def.declarations.keys()]];
      if (def.declarations.size === 0) {
        const vues = new Set<string>();
        for (const e of entrees.slice(0, 500)) for (const k of e.proprietes.keys()) if (!["title", "icon", "cover", "tags"].includes(k)) vues.add(k);
        ids.push(...[...vues].sort(collateurFr.compare).slice(0, 12));
      }
    }
    const vus = new Set<string>();
    const res: ColonneBase[] = [];
    for (const id of ids) {
      if (vus.has(id)) continue;
      vus.add(id);
      const r = lireReference(id);
      const lib = (cles: string[]) => cles.map((k) => def.libelles.get(k)).find(Boolean);
      if (r.nature === "note") {
        const d = def.declarations.get(r.cle) ?? null;
        res.push({
          id, nature: "note", cle: r.cle, libelle: lib([id, `note.${r.cle}`, r.cle]) ?? r.cle,
          type: d?.type ?? null, options: d?.options ?? null, modifiable: !CLES_PROVENANCE.has(r.cle), probleme: null,
        });
      } else if (r.nature === "fichier") {
        res.push({ id, nature: "fichier", cle: null, libelle: lib([id]) ?? LIBELLES_FICHIER[r.champ], type: null, options: null, modifiable: false, probleme: null });
      } else if (r.nature === "formule") {
        res.push({ id, nature: "formule", cle: null, libelle: lib([id]) ?? r.nom, type: null, options: null, modifiable: false, probleme: "les formules ne sont pas calculées par Carnet." });
      } else {
        res.push({ id, nature: "inconnue", cle: null, libelle: lib([id]) ?? id, type: null, options: null, modifiable: false, probleme: r.message });
      }
    }
    return res;
  }

  // -------------------------------------------------------------------------------------------
  // Évaluation à partir d'une page (disque) ou d'un YAML fourni
  // -------------------------------------------------------------------------------------------

  evaluerSource(source: string, vue: number): ResultatBase {
    const { def, erreurs } = lireDefinition(source);
    if (!def) throw erreurBase(erreurs);
    return this.executer(def, source, vue);
  }

  async blocsDePage(segs: string[]): Promise<{ contenu: string; blocs: ReturnType<typeof trouverBlocsBase> }> {
    const { contenu } = await lireConfine(this.cfg, await resoudre(this.cfg, segs), 5 * 1024 * 1024);
    return { contenu, blocs: trouverBlocsBase(contenu) };
  }

  #cacheDefs = new Map<string, DefinitionBase | null>();

  /** Définition d'un bloc, mise en cache par texte (les définitions sont relues à chaque ouverture de page). */
  #definition(source: string): DefinitionBase | null {
    if (this.#cacheDefs.has(source)) return this.#cacheDefs.get(source)!;
    const { def } = lireDefinition(source);
    if (this.#cacheDefs.size > 200) this.#cacheDefs.clear();
    this.#cacheDefs.set(source, def);
    return def;
  }

  /** Bases (blocs) de l'espace, avec leur définition valide : pour trouver la base dont une page est une entrée. */
  #basesDeLEspace(): Array<{ page: Page; index: number; def: DefinitionBase }> {
    const res: Array<{ page: Page; index: number; def: DefinitionBase }> = [];
    for (const p of this.espace.pagesVisibles()) {
      if (!p.contenu.includes("base")) continue;
      let c = this.#cacheBlocs.get(p.chemin);
      if (!c || c.etag !== p.etag) {
        c = { etag: p.etag, blocs: trouverBlocsBase(p.contenu) };
        this.#cacheBlocs.set(p.chemin, c);
      }
      for (const b of c.blocs) {
        const def = this.#definition(b.source);
        if (def) res.push({ page: p, index: b.index, def });
      }
    }
    return res.sort((a, b) => collateurFr.compare(a.page.chemin, b.page.chemin) || a.index - b.index);
  }

  /**
   * Lot 12 : vues nommées « À relancer » (casse et accents ignorés) des bases de l'espace, avec leur nombre de lignes
   * à l'instant (horloge des bases). Pour l'écran Aujourd'hui ; une vue invalide ou non prise en charge est ignorée.
   */
  vuesARelancer(): Array<{ chemin: string; titre: string; bloc: number; vue: number; nom: string; total: number }> {
    const res: Array<{ chemin: string; titre: string; bloc: number; vue: number; nom: string; total: number }> = [];
    const maintenant = this.maintenant();
    for (const b of this.#basesDeLEspace()) {
      if (estModele(b.page.chemin)) continue;
      b.def.vues.forEach((v, i) => {
        if (!v.prise || plier(v.nom).trim() !== "a relancer" || res.length >= 10) return;
        const src = trouverBlocsBase(b.page.contenu)[b.index]?.source;
        if (src === undefined) return;
        try {
          const r = this.executer(b.def, src, i, maintenant);
          res.push({ chemin: b.page.chemin, titre: b.page.titre, bloc: b.index, vue: i, nom: v.nom, total: r.total });
        } catch { /* vue non évaluable : ignorée */ }
      });
    }
    return res;
  }

  // -------------------------------------------------------------------------------------------
  // Échéances (11/10/2026) : fiches datées des bases qui le déclarent (`carnet.aujourdhui`)
  // -------------------------------------------------------------------------------------------

  /** Bases qui déclarent `carnet.aujourdhui`, avec le dossier de leurs fiches (ni modèle, ni page archivée). */
  #basesAujourdhui(): Array<{ page: Page; index: number; def: DefinitionBase; decl: DeclarationAujourdhui; dossier: string }> {
    const res: Array<{ page: Page; index: number; def: DefinitionBase; decl: DeclarationAujourdhui; dossier: string }> = [];
    for (const b of this.#basesDeLEspace()) {
      if (!b.def.aujourdhui || estModele(b.page.chemin) || this.espace.archivee(b.page)) continue;
      const brut = b.def.dossier ?? dossierDuFiltre(b.def.filtre);
      if (!brut) continue; // sans dossier connu, une base retiendrait tout l'espace : rien ne remonte
      let segs: string[];
      try { segs = this.dossierAutorise(brut); } catch { continue; }
      res.push({ ...b, decl: b.def.aujourdhui, dossier: segs.join("/") });
    }
    return res;
  }

  /** La page est-elle une fiche de cette base ? Dans son dossier, et retenue par son filtre global (sinon : enfants directs). */
  #estFiche(b: { page: Pick<Page, "chemin">; def: DefinitionBase; dossier: string }, e: EntreeBase, ctx: { maintenant: number; fuseau: string }): boolean {
    if (e.chemin === b.page.chemin || !e.chemin.startsWith(b.dossier + "/")) return false;
    if (!b.def.filtre) return dossierDe(e.chemin) === b.dossier;
    try { return evaluerFiltre(b.def.filtre, e, ctx) === true; } catch { return false; }
  }

  /** Fiches non faites et datées des bases qui le déclarent ; une fiche n'apparaît qu'une fois (première base). */
  fichesDatees(): FicheDatee[] {
    const bases = this.#basesAujourdhui();
    if (!bases.length) return [];
    const vues = new Set<string>();
    const res: FicheDatee[] = [];
    const entrees = this.entrees();
    for (const b of bases) res.push(...this.#fichesDe(b, entrees, vues).fiches);
    return res;
  }

  #fichesDe(b: { page: Pick<Page, "chemin" | "titre">; index: number; def: DefinitionBase; decl: DeclarationAujourdhui; dossier: string }, entrees: EntreeBase[], vues: Set<string>): { fiches: FicheDatee[]; sansDate: number; faites: number } {
    const fuseau = this.cfg.fuseau || FUSEAU_DEFAUT;
    const ctx = { maintenant: this.maintenant(), fuseau };
    const fiches: FicheDatee[] = [];
    let sansDate = 0, faites = 0;
    for (const e of entrees) {
      if (vues.has(e.chemin) || !this.#estFiche(b, e, ctx)) continue;
      if (e.yamlInvalide) continue; // état illisible : jamais deviné
      const f = e.proprietes.get(b.decl.fait.propriete);
      if (f?.etat === "anomalie") continue;
      if (f?.etat === "valeur" && f.valeur === b.decl.fait.valeur) { faites++; continue; }
      const d = e.proprietes.get(b.decl.echeance);
      const date = d?.etat === "valeur" && typeof d.valeur === "string" ? lireDate(d.valeur.trim(), fuseau) : null;
      if (!date || d?.etat !== "valeur" || typeof d.valeur !== "string") { sansDate++; continue; }
      const echeance = date.jour ? d.valeur.trim().slice(0, 10) : dateDuJour(fuseau, new Date(date.ms));
      vues.add(e.chemin);
      const pr = b.decl.priorite ? e.proprietes.get(b.decl.priorite) : undefined;
      const priorite = pr?.etat === "valeur" ? prioriteDeFiche(pr.valeur) : undefined;
      fiches.push({
        chemin: e.chemin, titre: e.titre, icone: e.icone, echeance, ...(priorite ? { priorite } : {}),
        anomalies: e.nonModifiable ? [`en-tête non modifiable : ${e.nonModifiable}`] : [],
        fiche: {
          base: b.page.chemin, baseTitre: b.page.titre, bloc: b.index, etag: e.etag,
          propriete: b.decl.fait.propriete, valeur: b.decl.fait.valeur,
          ...(f ? { avant: f.valeur } : { absente: true }),
        },
      });
    }
    return { fiches, sansDate, faites };
  }

  /** Aperçu de « Afficher dans Aujourd'hui » pour un bloc pas encore enregistré (page `page`, définition `def`). */
  apercuAujourdhui(page: string, def: DefinitionBase): { fiches: number; enRetard: number; aujourdhui: number; aVenir: number; sansDate: number; faites: number; dossier: string | null } {
    const vide = { fiches: 0, enRetard: 0, aujourdhui: 0, aVenir: 0, sansDate: 0, faites: 0 };
    const brut = def.dossier ?? dossierDuFiltre(def.filtre);
    if (!def.aujourdhui || !brut) return { ...vide, dossier: null };
    let dossier: string;
    try { dossier = this.dossierAutorise(brut).join("/"); } catch { return { ...vide, dossier: null }; }
    const p = this.espace.pages.get(page);
    const r = this.#fichesDe({ page: { chemin: page, titre: p?.titre ?? page }, index: 0, def, decl: def.aujourdhui, dossier }, this.entrees(), new Set());
    const jour = dateDuJour(this.cfg.fuseau || FUSEAU_DEFAUT); // même jour que l'écran Aujourd'hui
    return {
      fiches: r.fiches.length, enRetard: r.fiches.filter((f) => f.echeance < jour).length, aujourdhui: r.fiches.filter((f) => f.echeance === jour).length,
      aVenir: r.fiches.filter((f) => f.echeance > jour).length, sansDate: r.sansDate, faites: r.faites, dossier,
    };
  }

  /** Déclaration `carnet.aujourdhui` qui s'applique à cette page (même règle que la liste), sinon null. */
  declarationDeFiche(chemin: string): { base: string; decl: DeclarationAujourdhui; def: DefinitionBase } | null {
    const p = this.espace.pages.get(chemin);
    if (!p) return null;
    const e = this.entree(p);
    const ctx = { maintenant: this.maintenant(), fuseau: this.cfg.fuseau || FUSEAU_DEFAUT };
    for (const b of this.#basesAujourdhui()) if (this.#estFiche(b, e, ctx)) return { base: b.page.chemin, decl: b.decl, def: b.def };
    return null;
  }

  /** Base dont la page est une entrée : d'abord celle dont `carnet.dossier` est le dossier de la page, puis celle dont les filtres la retiennent. */
  baseDe(chemin: string): { page: Page; index: number; def: DefinitionBase } | null {
    const p = this.espace.pages.get(chemin);
    if (!p) return null;
    const bases = this.#basesDeLEspace().filter((b) => b.page.chemin !== chemin);
    const dossier = dossierDe(chemin);
    const parDossier = bases.find((b) => b.def.dossier !== null && b.def.dossier === dossier);
    if (parDossier) return parDossier;
    const e = this.entree(p);
    const ctx = { maintenant: this.maintenant(), fuseau: this.cfg.fuseau || FUSEAU_DEFAUT };
    for (const b of bases) {
      if (!b.def.filtre && !b.def.vues.some((v) => v.filtre)) continue; // une base sans filtre retient tout : pas significatif
      try {
        if (b.def.filtre && !evaluerFiltre(b.def.filtre, e, ctx)) continue;
        const v = b.def.vues.find((x) => x.prise);
        if (v?.filtre && !evaluerFiltre(v.filtre, e, ctx)) continue;
        return b;
      } catch { /* indéterminé : pas cette base */ }
    }
    return null;
  }

  // -------------------------------------------------------------------------------------------
  // Panneau « Propriétés »
  // -------------------------------------------------------------------------------------------

  proprietesDe(p: Page): {
    etag: string; yamlInvalide: string | null; nonModifiable: string | null;
    proprietes: Array<{ cle: string; libelle?: string; etat: "valeur" | "anomalie"; valeur?: ValeurBrute; raison?: string; type: string | null; declare: boolean; options: string[] | null; horsListe?: boolean }>;
    base: { page: string; titre: string; bloc: number } | null;
    declarations: Array<{ cle: string; type: string; options: string[] | null }>;
  } {
    const e = this.entree(p);
    const b = this.baseDe(p.chemin);
    const decl = b?.def.declarations ?? new Map<string, DeclarationPropriete>();
    // libellé de la base (properties.<clé>.displayName), affiché à la place de la clé
    const lib = (cle: string) => {
      const l = b?.def.libelles.get(cle) ?? b?.def.libelles.get(`note.${cle}`);
      return l && l !== cle ? { libelle: l } : {};
    };
    const proprietes = [...e.proprietes.entries()].filter(([k]) => !CLES_EN_TETE.has(k)).map(([cle, lue]) => {
      const d = decl.get(cle) ?? null;
      if (lue.etat === "anomalie") return { cle, ...lib(cle), etat: "anomalie" as const, raison: lue.raison, type: d?.type ?? null, declare: !!d, options: d?.options ?? null };
      const horsListe = !!d && (d.type === "statut" || d.type === "selection") && typeof lue.valeur === "string" && !!d.options && !d.options.includes(lue.valeur);
      return {
        cle, ...lib(cle), etat: "valeur" as const, valeur: lue.valeur, type: d?.type ?? typeDeValeur(lue.valeur), declare: !!d, options: d?.options ?? null,
        ...(horsListe ? { horsListe } : {}),
      };
    });
    return {
      etag: p.etag, yamlInvalide: e.yamlInvalide, nonModifiable: e.nonModifiable ?? null, proprietes,
      base: b ? { page: b.page.chemin, titre: b.page.titre, bloc: b.index } : null,
      declarations: [...decl.entries()].map(([cle, d]) => ({ cle, type: d.type, options: d.options })),
    };
  }

  /** Déclaration d'une propriété pour une page : celle de la base indiquée (cellule) ou de la base dont elle est une entrée. */
  declarationPour(chemin: string, cle: string, source?: string | null): DeclarationPropriete | null {
    if (source != null) {
      const { def } = lireDefinition(source);
      return def?.declarations.get(cle) ?? null;
    }
    return this.baseDe(chemin)?.def.declarations.get(cle) ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Dossier d'une nouvelle base (menu « /base »)
  // -------------------------------------------------------------------------------------------

  async creerDossier(page: string, nom: string): Promise<{ dossier: string }> {
    const segsPage = cheminPage(this.cfg, page);
    const base = nomDeFichier(nom);
    const parent = [...segsPage.slice(0, -1), segsPage[segsPage.length - 1].slice(0, -3)];
    for (let k = 1; k <= 200; k++) {
      const n = k === 1 ? base : `${base} ${k}`;
      const segs = [...parent, n];
      if (zoneInterdite(this.cfg, segs)) continue;
      const { abs, st } = await verifierEcriture(this.cfg, segs);
      const md = await lstatOuNull(abs + ".md");
      if (st || md) continue;
      await creerDossiers(this.cfg, abs);
      this.espace.appliquer(await this.espace.traiter([segs.join("/")]));
      return { dossier: segs.join("/") };
    }
    throw new ErreurHttp(409, "Trop de dossiers portent déjà ce nom.", "conflit_nom");
  }

  // -------------------------------------------------------------------------------------------
  // K10-01 : « Ajouter à <base> » au rangement (Boîte, « Déplacer vers… »)
  // -------------------------------------------------------------------------------------------

  /**
   * Destinations de rangement : une par base de l'espace (bloc ```base``` valide d'une page ni archivée ni modèle) dont
   * le DOSSIER DES ENTRÉES est connu : `carnet.dossier`, sinon l'unique `file.inFolder("…")` du filtre global (pris
   * seulement dans une conjonction « et » : sous un « ou » ou un « non », le dossier ne suffit pas à entrer dans la base).
   * Dossier confiné (`cheminAutorise` : ni zone masquée, ni fichier caché, ni artefacts), réel (pas un lien), existant.
   * `parent` est la valeur à passer telle quelle à POST /api/deplacer (la porte d'écriture habituelle).
   */
  async destinations(): Promise<Array<{ titre: string; page: string; bloc: number; dossier: string; parent: string; icone: string | null }>> {
    const res: Array<{ titre: string; page: string; bloc: number; dossier: string; parent: string; icone: string | null }> = [];
    const vus = new Set<string>();
    for (const b of this.#basesDeLEspace()) {
      if (estModele(b.page.chemin) || (b.page.fm !== null && b.page.fm.archive === true)) continue;
      const brut = b.def.dossier ?? dossierDuFiltre(b.def.filtre);
      if (!brut) continue;
      let segs: string[];
      try { segs = this.dossierAutorise(brut); } catch { continue; }
      const dossier = segs.join("/");
      if (vus.has(dossier)) continue;
      let st: Awaited<ReturnType<typeof lstatOuNull>> = null;
      try { st = await lstatOuNull(await resoudre(this.cfg, segs)); } catch { st = null; }
      if (!st || !st.isDirectory()) continue;
      vus.add(dossier);
      res.push({ titre: b.page.titre, page: b.page.chemin, bloc: b.index, dossier, parent: dossier + ".md", icone: b.page.icone });
    }
    return res.sort((a, b) => collateurFr.compare(a.titre, b.titre) || a.page.localeCompare(b.page));
  }

  /** Dossier déclaré d'une base, confiné à l'espace (segments). */
  dossierAutorise(dossier: string): string[] {
    const segs = cheminAutorise(this.cfg, dossier);
    if (segs[segs.length - 1].endsWith(".md")) throw new ErreurHttp(400, "Le dossier d'une base n'est pas une page.", "pas_un_dossier");
    if (segs.includes("_assets")) throw new ErreurHttp(403, "Chemin interdit.", "assets");
    return segs;
  }

}

/**
 * K10-01 : dossier visé par le filtre global d'une base : l'unique `file.inFolder("<littéral>")` atteint par des « et »
 * seulement (liste `and:` ou `&&`) ; plusieurs dossiers différents, un « ou », un « non » ou un argument calculé : null.
 */
export function dossierDuFiltre(f: Filtre | null): string | null {
  if (!f) return null;
  const trouves = new Set<string>();
  const noeud = (n: Noeud): void => {
    if (n.k === "et") { noeud(n.g); noeud(n.d); return; }
    if (n.k === "fnFichier" && n.fn === "inFolder" && n.args.length === 1 && n.args[0].k === "lit" && typeof n.args[0].v === "string") {
      const d = n.args[0].v.replace(/^\/+|\/+$/g, "");
      if (d) trouves.add(d);
    }
  };
  const filtre = (x: Filtre): void => {
    if (x.k === "expr") noeud(x.ast);
    else if (x.k === "and") x.enfants.forEach(filtre);
  };
  filtre(f);
  return trouves.size === 1 ? [...trouves][0] : null;
}

/** Type de l'écriture (socle) correspondant à un type déclaré : statut et sélection s'écrivent comme une sélection. */
export function typeSocle(d: DeclarationPropriete | null | undefined): TypeSocle | undefined {
  if (!d) return undefined;
  return d.type === "statut" ? "selection" : d.type;
}

// ------------------------------------------------------------------------------------------------ cellules

function cellule(c: ColonneBase, e: EntreeBase): CelluleBase {
  if (c.nature === "note") {
    if (e.yamlInvalide) return { etat: "anomalie", raison: `en-tête YAML illisible : ${e.yamlInvalide}` };
    const p = e.proprietes.get(c.cle!);
    if (!p) return { etat: "absente" };
    if (p.etat === "anomalie") return { etat: "anomalie", raison: p.raison, texte: p.brut };
    if (p.valeur === null) return { etat: "nulle" };
    const res: CelluleBase = { etat: "valeur", valeur: p.valeur };
    if ((c.type === "statut" || c.type === "selection") && c.options && typeof p.valeur === "string" && !c.options.includes(p.valeur)) res.horsListe = true;
    return res;
  }
  if (c.nature === "fichier") {
    const r = lireReference(c.id);
    if (r.nature !== "fichier") return { etat: "absente" };
    const nom = e.chemin.slice(e.chemin.lastIndexOf("/") + 1);
    switch (r.champ) {
      case "name": return { etat: "valeur", valeur: nom, texte: e.titre };
      case "basename": return { etat: "valeur", valeur: nom.replace(/\.md$/i, ""), texte: e.titre };
      case "path": return { etat: "valeur", valeur: e.chemin };
      case "folder": return { etat: "valeur", valeur: dossierDe(e.chemin) };
      case "ext": return { etat: "valeur", valeur: path.extname(nom).slice(1) };
      case "size": return { etat: "valeur", valeur: e.taille };
      case "mtime": return { etat: "valeur", valeur: e.mtime };
      case "ctime": return { etat: "valeur", valeur: e.ctime };
      case "tags": return { etat: "valeur", valeur: [...e.etiquettes] };
    }
  }
  return { etat: "absente" };
}

function filtresAffiches(brut: unknown): FiltreAffiche[] | null {
  if (brut === undefined || brut === null) return [];
  if (typeof brut === "string") return [{ index: 0, expression: brut, simple: lireFiltreSimple(brut) }];
  if (brut && typeof brut === "object" && !Array.isArray(brut)) {
    const o = brut as Record<string, unknown>;
    if (Object.keys(o).length === 1 && Array.isArray(o.and) && o.and.every((x) => typeof x === "string")) {
      return (o.and as string[]).map((expression, index) => ({ index, expression, simple: lireFiltreSimple(expression) }));
    }
  }
  return null;
}

/** Lot 12 : « 2 pages sans « Prochaine relance » ne sont pas retenues. » (phrases toujours affichées sous les filtres). */
function phrasesExclusions(ecartees: Map<string, { vides: Set<string>; nonDates: Map<string, string> }>, dansLaBase: number, libelles: Map<string, string>): string[] {
  const res: string[] = [];
  const pages = (n: number) => `${n} page${n > 1 ? "s" : ""}`;
  for (const [cle, x] of [...ecartees.entries()].sort((a, b) => collateurFr.compare(a[0], b[0]))) {
    const nom = libelles.get(cle) ?? libelles.get(`note.${cle}`) ?? cle;
    if (x.vides.size && x.vides.size === dansLaBase && !x.nonDates.size) {
      res.push(`Aucune page de la base n'a de « ${nom} » : vérifie le nom de la propriété dans le filtre.`);
      continue;
    }
    if (x.vides.size) res.push(`${pages(x.vides.size)} sans « ${nom} » ${x.vides.size > 1 ? "ne sont" : "n'est"} pas retenue${x.vides.size > 1 ? "s" : ""}.`);
    if (x.nonDates.size) {
      const ex = [...new Set(x.nonDates.values())].slice(0, 3).map((t) => `« ${t.length > 40 ? t.slice(0, 39) + "…" : t} »`).join(", ");
      const n = x.nonDates.size;
      res.push(`${pages(n)} dont « ${nom} » n'est pas une date (${ex}) ${n > 1 ? "ne sont" : "n'est"} pas retenue${n > 1 ? "s" : ""}.`);
    }
  }
  return res;
}

/** Filtres globaux en français lisible (pastilles) ; une expression non reconnue est montrée telle quelle. */
function decrireFiltres(brut: unknown, libelles: Map<string, string>, prof = 0): string[] {
  if (brut === undefined || brut === null || prof > 4) return [];
  if (typeof brut === "string") return [decrireExpression(brut, libelles)];
  if (brut && typeof brut === "object" && !Array.isArray(brut)) {
    const [k, v] = Object.entries(brut as Record<string, unknown>)[0] ?? [];
    if (Array.isArray(v)) {
      const parties = v.flatMap((x) => decrireFiltres(x, libelles, prof + 1).map((t) => (typeof x === "string" ? t : `(${t})`)));
      if (k === "and") return prof === 0 ? parties : [parties.join(" et ")];
      if (k === "or") return parties.length ? [parties.join(" ou ")] : [];
      if (k === "not") return parties.length ? [`aucun de : ${parties.join(" ; ")}`] : [];
    }
  }
  return [JSON.stringify(brut)];
}

function decrireExpression(src: string, libelles: Map<string, string>): string {
  const simple = lireFiltreSimple(src);
  const nom = (cle: string) => libelles.get(cle) ?? libelles.get(`note.${cle}`) ?? cle;
  if (simple) return decrireFiltreSimple(simple, nom(simple.propriete));
  let n: Noeud;
  try { n = analyserExpression(src); } catch { return src; }
  const lit = (x: Noeud) => (x.k === "lit" && typeof x.v === "string" ? x.v : null);
  if (n.k === "cmp" && n.op === "==" && n.g.k === "fichier" && n.g.champ === "folder" && lit(n.d) !== null) {
    return `dans « ${lit(n.d) || "la racine"} » (sans sous-dossiers)`;
  }
  if (n.k === "fnFichier" && n.args.every((a) => lit(a) !== null)) {
    const a = n.args.map((x) => lit(x)!);
    if (n.fn === "inFolder") return `dans « ${a[0] || "tout l'espace"} »`;
    if (n.fn === "hasTag") return `étiquette ${a.map((t) => `#${t.replace(/^#/, "")}`).join(" ou ")}`;
    if (n.fn === "hasProperty") return `a la propriété « ${nom(a[0])} »`;
  }
  return src;
}

/**
 * Lot 12 : horloge de recette. CARNET_HORLOGE_ESSAI = chemin d'un fichier contenant un instant ISO 8601 avec fuseau
 * (« 2026-10-11T09:00:00+02:00 »). Absent, vide ou illisible : horloge réelle. Jamais en production (avertissement
 * au démarrage, voir config.ts).
 */
export function horlogeEssai(cfg: Config): number | null {
  const f = cfg.horlogeEssai;
  if (!f) return null;
  try {
    const t = Date.parse(fs.readFileSync(f, "utf8").trim());
    return Number.isFinite(t) ? t : null;
  } catch {
    return null;
  }
}

export function erreurBase(erreurs: ErreurBase[]): ErreurHttp {
  const premier = erreurs[0]?.message ?? "Bloc invalide.";
  return new ErreurHttp(422, `Base non prise en charge : ${premier}`, "base_invalide", { raison: "base_invalide", erreurs });
}

// ------------------------------------------------------------------------------------------------ lecture des corps de requête

export function lireSource(v: unknown): string {
  const s = chaine(v, "source", MAX_SOURCE_BASE);
  return s;
}

export function lireVue(v: unknown): number {
  if (v === undefined || v === null || v === "") return 0;
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 19) throw new ErreurHttp(400, "Vue invalide.", "champ_invalide");
  return n;
}

export function lireChangement(v: unknown): ChangementVue & ChangementVues & { aujourdhui?: DeclarationAujourdhui | null } {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new ErreurHttp(400, "Champ « changement » invalide.", "champ_invalide");
  const o = v as Record<string, unknown>;
  const ch: ChangementVue = {};
  if (o.tri !== undefined) {
    if (o.tri !== null && (!Array.isArray(o.tri) || o.tri.length > 10)) throw new ErreurHttp(400, "Tri invalide.", "champ_invalide");
    ch.tri = o.tri === null ? null : (o.tri as unknown[]).map((t) => {
      const x = t as Record<string, unknown>;
      return { propriete: chaine(x?.propriete, "propriete", 300), sens: x?.sens === "DESC" ? "DESC" : x?.sens === "ASC" ? "ASC" : (() => { throw new ErreurHttp(400, "Sens de tri invalide.", "champ_invalide"); })() };
    });
  }
  if (o.ajouterFiltre !== undefined) ch.ajouterFiltre = chaine(o.ajouterFiltre, "ajouterFiltre", 2000);
  if (o.retirerFiltre !== undefined) {
    if (typeof o.retirerFiltre !== "number" || !Number.isInteger(o.retirerFiltre) || o.retirerFiltre < 0) throw new ErreurHttp(400, "Rang de filtre invalide.", "champ_invalide");
    ch.retirerFiltre = o.retirerFiltre;
  }
  // K14-01 : vues (un seul changement de la liste des vues par requête, jamais mêlé aux filtres ou au tri)
  const cv = ch as ChangementVue & ChangementVues & { aujourdhui?: DeclarationAujourdhui | null };
  if (o.nouvelleVue !== undefined) {
    const n = o.nouvelleVue as Record<string, unknown> | null;
    if (!n || typeof n !== "object" || Array.isArray(n) || typeof n.nom !== "string" || n.nom.length > 400) throw new ErreurHttp(400, "Nouvelle vue invalide.", "champ_invalide");
    cv.nouvelleVue = { nom: n.nom };
    if (n.filtres !== undefined) {
      if (!Array.isArray(n.filtres) || n.filtres.length > 20) throw new ErreurHttp(400, "Filtres invalides.", "champ_invalide");
      cv.nouvelleVue.filtres = n.filtres.map((x, i) => chaine(x, `filtres[${i}]`, 2000));
    }
    if (n.tri !== undefined) {
      if (!Array.isArray(n.tri) || n.tri.length > 10) throw new ErreurHttp(400, "Tri invalide.", "champ_invalide");
      cv.nouvelleVue.tri = (n.tri as unknown[]).map((t) => {
        const x = t as Record<string, unknown>;
        if (x?.sens !== "ASC" && x?.sens !== "DESC") throw new ErreurHttp(400, "Sens de tri invalide.", "champ_invalide");
        return { propriete: chaine(x?.propriete, "propriete", 300), sens: x.sens };
      });
    }
    if (n.retablir !== undefined) {
      const r = n.retablir as Record<string, unknown> | null;
      if (!r || typeof r !== "object" || Array.isArray(r) || Object.keys(r).some((k) => k !== "filters" && k !== "sort")) throw new ErreurHttp(400, "« retablir » invalide.", "champ_invalide");
      cv.nouvelleVue.retablir = r as EtatVue;
    }
  }
  if (o.dupliquerVue !== undefined) {
    if (o.dupliquerVue !== true) throw new ErreurHttp(400, "« dupliquerVue » invalide.", "champ_invalide");
    cv.dupliquerVue = true;
  }
  if (o.renommerVue !== undefined) {
    if (typeof o.renommerVue !== "string" || o.renommerVue.length > 400) throw new ErreurHttp(400, "Nom de vue invalide.", "champ_invalide");
    cv.renommerVue = o.renommerVue;
  }
  if (o.supprimerVue !== undefined) {
    if (o.supprimerVue !== true) throw new ErreurHttp(400, "« supprimerVue » invalide.", "champ_invalide");
    cv.supprimerVue = true;
  }
  // Échéances (11/10/2026) : « Afficher dans Aujourd'hui » (null = ne plus afficher), seul dans sa requête
  if (o.aujourdhui !== undefined) {
    if (o.aujourdhui === null) cv.aujourdhui = null;
    else {
      const a = o.aujourdhui as Record<string, unknown>;
      const f = (a && typeof a === "object" && !Array.isArray(a) ? a.fait : null) as Record<string, unknown> | null;
      if (!a || typeof a !== "object" || Array.isArray(a) || !f || typeof f !== "object" || Array.isArray(f)) throw new ErreurHttp(400, "« aujourdhui » invalide.", "champ_invalide");
      if (typeof f.valeur !== "string" && typeof f.valeur !== "boolean") throw new ErreurHttp(400, "« aujourdhui.fait.valeur » invalide.", "champ_invalide");
      cv.aujourdhui = {
        echeance: chaine(a.echeance, "echeance", 64), fait: { propriete: chaine(f.propriete, "propriete", 64), valeur: typeof f.valeur === "string" ? chaine(f.valeur, "valeur", 200) : f.valeur },
        priorite: a.priorite === undefined || a.priorite === null ? null : chaine(a.priorite, "priorite", 64),
      };
    }
    if (Object.keys(o).length > 1) throw new ErreurHttp(400, "Un seul changement à la fois.", "champ_invalide");
    return cv;
  }
  const nVues = ["nouvelleVue", "dupliquerVue", "renommerVue", "supprimerVue"].filter((k) => (cv as Record<string, unknown>)[k] !== undefined).length;
  const nAutres = [ch.tri, ch.ajouterFiltre, ch.retirerFiltre].filter((x) => x !== undefined).length;
  if (nVues > 1 || (nVues && nAutres)) throw new ErreurHttp(400, "Un seul changement de vue à la fois.", "champ_invalide");
  if (!nVues && !nAutres) throw new ErreurHttp(400, "Aucun changement demandé.", "champ_invalide");
  return cv;
}


