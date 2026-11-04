// Carnet · nouveautés : pages modifiées, créées, renommées ou supprimées depuis la version que le lecteur a MARQUÉE
// comme vue. L'état vit HORS de l'espace (`CARNET_ETAT/nouveautes/<espace>/<lecteur>/`), par espace et par lecteur :
//   vu.json          { version: 1, lecteur, depart, pages: { "<chemin>": { etag, copie, t, titre, id? } } }
//   copies/<sha>.md  copie exacte de chaque version marquée vue (adressée par son SHA-256, vérifiée à la relecture)
// Aucun champ « vu » n'est jamais écrit dans les .md.
//
// Règles :
// - ouvrir une page ne la marque pas vue ; « Marquer comme vu » enregistre la version PRÉSENTÉE (etag envoyé par
//   l'interface) : une version arrivée entre-temps reste nouvelle ;
// - premier lancement (pas d'état pour ce lecteur) : point de départ = maintenant ; toutes les pages existantes sont
//   considérées comme vues (avec leur copie), pour ne pas noyer le lecteur sous des centaines de « nouveautés » ;
// - une version écrite par Carnet sous l'identité du lecteur n'est pas une nouveauté (et devient sa référence) ;
// - auteur : « non vérifié » sauf si Carnet a écrit cette version (identité du réseau, qui ne prouve PAS qu'un humain
//   l'a faite) ; `maj_par` / `maj_motif` du frontmatter sont des déclarations, affichées comme telles ;
// - renommage suivi (journal de Carnet, sinon contenu identique ou même `id:`), suppression signalée ;
// - fichiers des agents (shared/techniques.ts) exclus par défaut.
import crypto from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import { bilan, differencesLignes } from "../../shared/diff.ts";
import { horodatageIso } from "../../shared/identifiants.ts";
import { nomDeFichier } from "../../shared/page.ts";
import { estTechnique } from "../../shared/techniques.ts";
import type { Config } from "./config.ts";
import { ecrireAtomique, etagDe } from "./disque.ts";
import type { Changements, Espace, Page } from "./espace.ts";
import { texte } from "./espace.ts";
import { ErreurHttp, journal } from "./http.ts";
import { cheminPage } from "./securite.ts";

export interface PorteProvenance {
  /**
   * Identité (principal) sous laquelle Carnet a écrit CETTE version de la page (la dernière écriture de Carnet à ce
   * chemin a produit exactement ce contenu), ou null (version externe, ou provenance ambiguë : « auteur non vérifié »).
   */
  auteurCarnet(chemin: string, etag: string): string | null;
  /** Dernier renommage / déplacement (vers = nouveau chemin) ou suppression (vers = null) fait par Carnet depuis ce chemin. */
  mouvement(chemin: string): { vers: string | null; principal: string; t: number } | null;
  /** Exécute après les écritures de Carnet en cours (verrou des mutations), pour lire un journal à jour. */
  apresEcritures<T>(f: () => Promise<T>): Promise<T>;
}

interface EntreeVue { etag: string; copie: string; t: string; titre: string; id?: string }
interface EtatLecteur { version: 1; lecteur: string; depart: string; pages: Record<string, EntreeVue> }

export type EtatNouveaute = "modifiee" | "nouvelle" | "renommee" | "supprimee";

export interface Nouveaute {
  chemin: string;
  titre: string;
  icone: string | null;
  mtime: number;
  etat: EtatNouveaute;
  vers: string | null;
  auteur: string;
  maj_par_declare: string | null;
  motif_declare: string | null;
  /** Version présentée (à renvoyer pour la marquer vue) ; null pour une page supprimée. */
  etag: string | null;
  technique: boolean;
  /** Renommée ET modifiée. */
  modifiee?: boolean;
  /** Date où la version de référence a été marquée vue. */
  vu_le: string | null;
  ajouts?: number;
  retraits?: number;
}

const MAX_PRESENTEES = 1000;
const MAX_RESUMES = 60;
const MAX_MARQUES = 500;

function sha256(s: string): string {
  return crypto.createHash("sha256").update(s, "utf8").digest("hex");
}

/** Dossier d'un lecteur : identité en minuscules, caractères sûrs seulement (+ empreinte courte si transformée). */
export function dossierLecteur(login: string): string {
  const l = login.trim().toLowerCase();
  let d = l.replace(/[^a-z0-9@._-]/g, "_");
  if (d !== l || d.startsWith(".")) d = "_" + d.replace(/^\.+/, "") + "-" + sha256(l).slice(0, 8);
  return d.slice(0, 120) || "_";
}

export class Nouveautes {
  #cfg: Config;
  #espace: Espace;
  #prov: PorteProvenance;
  #racine: string;
  #etats = new Map<string, EtatLecteur>();
  #presentees = new Map<string, string>();
  #file: Promise<unknown> = Promise.resolve();

  constructor(cfg: Config, espace: Espace, prov: PorteProvenance) {
    this.#cfg = cfg;
    this.#espace = espace;
    this.#prov = prov;
    this.#racine = path.join(cfg.etat, "nouveautes", nomDeFichier(cfg.nomEspace));
  }

  #serie<T>(f: () => Promise<T>): Promise<T> {
    const r = this.#file.then(f);
    this.#file = r.then(() => undefined, () => undefined);
    return r;
  }

  #dossier(lecteur: string): string {
    return path.join(this.#racine, dossierLecteur(lecteur));
  }

  async #copier(lecteur: string, contenu: string): Promise<string> {
    const h = sha256(contenu);
    const d = path.join(this.#dossier(lecteur), "copies");
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    try {
      await fsp.writeFile(path.join(d, h + ".md"), contenu, { flag: "wx", mode: 0o600 });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
    return h;
  }

  async #lireCopie(lecteur: string, h: string): Promise<string | null> {
    if (!/^[0-9a-f]{64}$/.test(h)) return null;
    try {
      const c = await fsp.readFile(path.join(this.#dossier(lecteur), "copies", h + ".md"), "utf8");
      return sha256(c) === h ? c : null; // copie abîmée (panne) : comparaison indisponible plutôt que fausse
    } catch {
      return null;
    }
  }

  async #enregistrer(lecteur: string, etat: EtatLecteur, anciennes: Iterable<string> = []): Promise<void> {
    const d = this.#dossier(lecteur);
    await fsp.mkdir(d, { recursive: true, mode: 0o700 });
    await ecrireAtomique(path.join(d, "vu.json"), JSON.stringify(etat) + "\n", { mode: 0o600 });
    const utilisees = new Set(Object.values(etat.pages).map((e) => e.copie));
    for (const h of new Set(anciennes)) {
      if (!utilisees.has(h)) await fsp.rm(path.join(d, "copies", h + ".md"), { force: true }).catch(() => {});
    }
  }

  #entree(p: Page, copie: string, t: string): EntreeVue {
    const id = p.fm ? texte(p.fm.id) : null;
    return { etag: p.etag, copie, t, titre: p.titre, ...(id ? { id } : {}) };
  }

  /** État du lecteur ; au premier appel : point de départ = maintenant, toutes les pages actuelles vues. */
  async #etat(lecteur: string): Promise<EtatLecteur> {
    // Lot 5 : clé en minuscules, comme `observer` (le dossier l'est déjà) : un seul état en mémoire par lecteur.
    const cle = lecteur.toLowerCase();
    const deja = this.#etats.get(cle);
    if (deja) return deja;
    try {
      const v = JSON.parse(await fsp.readFile(path.join(this.#dossier(lecteur), "vu.json"), "utf8")) as EtatLecteur;
      if (v && v.version === 1 && v.pages && typeof v.pages === "object") {
        this.#etats.set(cle, v);
        return v;
      }
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") journal({ niveau: "avertissement", quoi: "nouveautes", erreur: String((e as Error).message).slice(0, 200) });
    }
    const t = horodatageIso(new Date(), this.#cfg.fuseau);
    const etat: EtatLecteur = { version: 1, lecteur, depart: t, pages: {} };
    for (const p of this.#espace.pagesVisibles()) etat.pages[p.chemin] = this.#entree(p, await this.#copier(lecteur, p.contenu), t);
    await this.#enregistrer(lecteur, etat);
    this.#etats.set(cle, etat);
    return etat;
  }

  /** Lot 5 : version marquée vue d'une page pour ce lecteur (contenu null si la copie est illisible), ou null. */
  async reference(lecteur: string, chemin: string): Promise<{ etag: string; t: string; titre: string; contenu: string | null } | null> {
    return this.#serie(async () => {
      const etat = await this.#etat(lecteur);
      const e = etat.pages[chemin];
      if (!e) return null;
      return { etag: e.etag, t: e.t, titre: e.titre, contenu: await this.#lireCopie(lecteur, e.copie) };
    });
  }

  /** Lot 5 : après « Revenir à la version marquée vue », la version restaurée redevient la référence du lecteur. */
  async poserReference(lecteur: string, chemin: string, contenu: string): Promise<void> {
    await this.#serie(async () => {
      const etat = await this.#etat(lecteur);
      const p = this.#espace.pages.get(chemin);
      const avant = etat.pages[chemin];
      const id = p?.fm ? texte(p.fm.id) : avant?.id ?? null;
      etat.pages[chemin] = {
        etag: etagDe(contenu), copie: await this.#copier(lecteur, contenu), t: horodatageIso(new Date(), this.#cfg.fuseau),
        titre: p?.titre ?? avant?.titre ?? chemin.replace(/\.md$/, "").split("/").pop()!, ...(id ? { id } : {}),
      };
      await this.#enregistrer(lecteur, etat, avant ? [avant.copie] : []);
    });
  }

  #presenter(chemin: string, p: Page): void {
    const k = `${chemin}\u0000${p.etag}`;
    this.#presentees.delete(k);
    this.#presentees.set(k, p.contenu);
    while (this.#presentees.size > MAX_PRESENTEES) this.#presentees.delete(this.#presentees.keys().next().value!);
  }

  #auteur(chemin: string, etag: string): string | null {
    try { return this.#prov.auteurCarnet(chemin, etag); } catch { return null; }
  }

  /** Calcule les nouveautés (toutes, fichiers techniques compris) et applique les rattrapages silencieux. */
  async #calculer(lecteur: string, etat: EtatLecteur): Promise<Array<Nouveaute & { _p?: Page; _e?: EntreeVue }>> {
    const pages = this.#espace.pagesVisibles();
    const parChemin = new Map(pages.map((p) => [p.chemin, p]));
    const items: Array<Nouveaute & { _p?: Page; _e?: EntreeVue }> = [];
    const nonVues: Page[] = [];
    const avancer: Page[] = [];
    const migrer: Array<[string, Page]> = [];
    const oublier: string[] = [];
    const tech = (c: string) => estTechnique(this.#cfg.techniques, c);
    const decl = (p: Page) => ({
      maj_par_declare: p.fm ? texte(p.fm.maj_par) : null,
      motif_declare: p.fm ? texte(p.fm.maj_motif) : null,
    });
    const moi = lecteur.toLowerCase();
    for (const p of pages) {
      const e = etat.pages[p.chemin];
      if (!e) { nonVues.push(p); continue; }
      if (e.etag === p.etag) continue;
      const auteur = this.#auteur(p.chemin, p.etag);
      if (auteur && auteur.toLowerCase() === moi) { avancer.push(p); continue; }
      items.push({
        chemin: p.chemin, titre: p.titre, icone: p.icone, mtime: p.mtime, etat: "modifiee", vers: null, auteur: auteur ?? "non vérifié", ...decl(p),
        etag: p.etag, technique: tech(p.chemin), vu_le: e.t, _p: p, _e: e,
      });
    }
    const disparues = Object.keys(etat.pages).filter((c) => !parChemin.has(c));
    if (disparues.length) {
      const restantes = new Set(nonVues);
      for (const c of disparues) {
        const e = etat.pages[c];
        const vuLe = Date.parse(e.t) || 0;
        // chaîne des renommages faits par Carnet depuis ce chemin, après la version vue
        let cible: string | null = c;
        let mv: ReturnType<PorteProvenance["mouvement"]> = null;
        const vus = new Set<string>();
        while (cible !== null && !vus.has(cible)) {
          vus.add(cible);
          let suivant: ReturnType<PorteProvenance["mouvement"]> = null;
          try { suivant = this.#prov.mouvement(cible); } catch { suivant = null; }
          if (!suivant || suivant.t < vuLe) break;
          mv = suivant;
          cible = suivant.vers;
        }
        const p = cible ? parChemin.get(cible) : undefined;
        if (mv && p && cible && !etat.pages[cible]) {
          restantes.delete(p);
          if (mv.principal.toLowerCase() === moi && p.etag === e.etag) { migrer.push([c, p]); continue; }
          items.push({
            chemin: c, titre: p.titre, icone: p.icone, mtime: p.mtime, etat: "renommee", vers: cible, auteur: mv.principal, ...decl(p),
            etag: p.etag, technique: tech(cible), vu_le: e.t, modifiee: p.etag !== e.etag, _p: p, _e: e,
          });
          continue;
        }
        if (mv && mv.vers === null && mv.principal.toLowerCase() === moi) { oublier.push(c); continue; }
        // renommage extérieur : même contenu, ou même identifiant `id:`
        const cand = [...restantes].find((x) => x.etag === e.etag) ?? (e.id ? [...restantes].find((x) => x.fm && texte(x.fm.id) === e.id) : undefined);
        if (cand) {
          restantes.delete(cand);
          items.push({
            chemin: c, titre: cand.titre, icone: cand.icone, mtime: cand.mtime, etat: "renommee", vers: cand.chemin,
            auteur: this.#auteur(cand.chemin, cand.etag) ?? "non vérifié", ...decl(cand), etag: cand.etag, technique: tech(cand.chemin),
            vu_le: e.t, modifiee: cand.etag !== e.etag, _p: cand, _e: e,
          });
          continue;
        }
        items.push({
          chemin: c, titre: e.titre, icone: null, mtime: Date.parse(e.t) || 0, etat: "supprimee", vers: null, auteur: mv ? mv.principal : "non vérifié",
          maj_par_declare: null, motif_declare: null, etag: null, technique: tech(c), vu_le: e.t, _e: e,
        });
      }
      nonVues.splice(0, nonVues.length, ...[...restantes]);
    }
    for (const p of nonVues) {
      const auteur = this.#auteur(p.chemin, p.etag);
      if (auteur && auteur.toLowerCase() === moi) { avancer.push(p); continue; }
      items.push({
        chemin: p.chemin, titre: p.titre, icone: p.icone, mtime: p.mtime, etat: "nouvelle", vers: null, auteur: auteur ?? "non vérifié", ...decl(p),
        etag: p.etag, technique: tech(p.chemin), vu_le: null, _p: p,
      });
    }
    // Rattrapages silencieux : écritures de Carnet sous l'identité du lecteur, ses renommages et suppressions.
    if (avancer.length || migrer.length || oublier.length) {
      const t = horodatageIso(new Date(), this.#cfg.fuseau);
      const anciennes: string[] = [];
      for (const p of avancer) {
        if (etat.pages[p.chemin]) anciennes.push(etat.pages[p.chemin].copie);
        etat.pages[p.chemin] = this.#entree(p, await this.#copier(lecteur, p.contenu), t);
      }
      for (const [c, p] of migrer) {
        etat.pages[p.chemin] = { ...etat.pages[c], titre: p.titre };
        delete etat.pages[c];
      }
      for (const c of oublier) { anciennes.push(etat.pages[c].copie); delete etat.pages[c]; }
      await this.#enregistrer(lecteur, etat, anciennes);
    }
    items.sort((a, b) => (a.etat === "supprimee" ? 1 : 0) - (b.etat === "supprimee" ? 1 : 0) || b.mtime - a.mtime || a.chemin.localeCompare(b.chemin, "fr"));
    return items;
  }

  /** GET /api/nouveautes */
  async lister(lecteur: string, o: { techniques: boolean; compte?: boolean }): Promise<{ depart: string; pages: Nouveaute[]; techniques_masquees: number }> {
    return this.#serie(async () => {
      const etat = await this.#etat(lecteur);
      const tous = await this.#calculer(lecteur, etat);
      const items = o.techniques ? tous : tous.filter((x) => !x.technique);
      let n = 0;
      const pages: Nouveaute[] = [];
      for (const it of items) {
        const { _p, _e, ...x } = it;
        if (_p) this.#presenter(x.vers ?? x.chemin, _p);
        if (!o.compte && _p && _e && (x.etat === "modifiee" || x.modifiee) && n < MAX_RESUMES) {
          n++;
          const avant = await this.#lireCopie(lecteur, _e.copie);
          if (avant !== null) Object.assign(x, bilan(differencesLignes(avant, _p.contenu)));
        }
        pages.push(x);
      }
      return { depart: etat.depart, pages, techniques_masquees: tous.length - items.length };
    });
  }

  /** GET /api/nouveaute?chemin= : état d'une page pour le bandeau, avec la version de référence et l'actuelle. */
  async detail(lecteur: string, chemin: string): Promise<Record<string, unknown>> {
    return this.#serie(async () => {
      const etat = await this.#etat(lecteur);
      const tous = await this.#calculer(lecteur, etat);
      const it = tous.find((x) => (x.etat === "renommee" ? x.vers === chemin : x.chemin === chemin));
      const p = this.#espace.pages.get(chemin);
      if (!it) {
        return { chemin, etat: p ? "a-jour" : "inconnue", etag: p?.etag ?? null, vu_le: etat.pages[chemin]?.t ?? null, depart: etat.depart };
      }
      const { _p, _e, ...x } = it;
      if (_p) this.#presenter(chemin, _p);
      const vu = _e ? { etag: _e.etag, t: _e.t, contenu: await this.#lireCopie(lecteur, _e.copie) } : null;
      return { ...x, depart: etat.depart, vu, actuel: _p ? { etag: _p.etag, contenu: _p.contenu } : null };
    });
  }

  /**
   * POST /api/nouveautes/vu : enregistre comme vues les versions PRÉSENTÉES. Pour chaque élément : etag actuel =
   * présenté -> contenu actuel ; sinon version présentée gardée en mémoire par le serveur ; sinon contenu renvoyé par
   * l'interface s'il correspond exactement à l'etag ; sinon rien n'est marqué (la page reste dans la liste).
   */
  async marquer(lecteur: string, corps: Record<string, unknown>): Promise<{ marquees: string[]; restantes: string[] }> {
    const brut = Array.isArray(corps.pages) ? corps.pages : null;
    if (!brut || !brut.length || brut.length > MAX_MARQUES) throw new ErreurHttp(400, `Champ « pages » invalide (1 à ${MAX_MARQUES} éléments).`, "champ_invalide");
    const demandes = brut.map((x) => {
      if (!x || typeof x !== "object") throw new ErreurHttp(400, "Élément invalide.", "champ_invalide");
      const o = x as Record<string, unknown>;
      const chemin = cheminPage(this.#cfg, o.chemin).join("/");
      const vers = o.vers === undefined || o.vers === null ? null : cheminPage(this.#cfg, o.vers).join("/");
      const etag = o.etag === null ? null : typeof o.etag === "string" && o.etag.length <= 100 ? o.etag : undefined;
      if (etag === undefined) throw new ErreurHttp(400, "Champ « etag » invalide (version présentée).", "champ_invalide");
      const contenu = typeof o.contenu === "string" ? o.contenu : null;
      return { chemin, vers, etag, contenu };
    });
    return this.#serie(async () => {
      const etat = await this.#etat(lecteur);
      const marquees: string[] = [];
      const restantes: string[] = [];
      const anciennes: string[] = [];
      const t = horodatageIso(new Date(), this.#cfg.fuseau);
      for (const d of demandes) {
        if (d.etag === null) {
          // suppression vue
          if (!this.#espace.pages.has(d.chemin) && etat.pages[d.chemin]) {
            anciennes.push(etat.pages[d.chemin].copie);
            delete etat.pages[d.chemin];
            marquees.push(d.chemin);
          } else restantes.push(d.chemin);
          continue;
        }
        const cible = d.vers ?? d.chemin;
        const p = this.#espace.pages.get(cible);
        let contenu: string | null = null;
        if (p && p.etag === d.etag) contenu = p.contenu;
        else if (this.#presentees.has(`${cible}\u0000${d.etag}`)) contenu = this.#presentees.get(`${cible}\u0000${d.etag}`)!;
        else if (d.contenu !== null && etagDe(d.contenu) === d.etag) contenu = d.contenu;
        if (contenu === null) { restantes.push(cible); continue; }
        if (d.vers && etat.pages[d.chemin] && d.vers !== d.chemin) {
          anciennes.push(etat.pages[d.chemin].copie);
          delete etat.pages[d.chemin];
        }
        if (etat.pages[cible]) anciennes.push(etat.pages[cible].copie);
        const id = p?.fm ? texte(p.fm.id) : null;
        etat.pages[cible] = { etag: d.etag, copie: await this.#copier(lecteur, contenu), t, titre: p?.titre ?? cible.replace(/\.md$/, "").split("/").pop()!, ...(id ? { id } : {}) };
        marquees.push(cible);
      }
      if (marquees.length) await this.#enregistrer(lecteur, etat, anciennes);
      return { marquees, restantes };
    });
  }

  /**
   * Après une écriture de Carnet : si elle a été faite sous l'identité d'un lecteur qui a un état, cette version
   * devient sa référence (ses propres modifications ne sont pas des nouveautés, et la comparaison suivante part d'elles).
   */
  observer(ch: Changements): void {
    if (!ch.modifs.size) return;
    const modifs = [...ch.modifs];
    // après l'écriture en cours (journal d'attribution à jour), hors du verrou des mutations
    void this.#prov.apresEcritures(async () => {}).then(() => {
      void this.#serie(async () => {
        for (const [chemin, etag] of modifs) {
          const auteur = this.#auteur(chemin, etag);
          const p = this.#espace.pages.get(chemin);
          if (!auteur || !p || p.etag !== etag) continue;
          const lecteur = auteur.toLowerCase();
          let etat = this.#etats.get(lecteur);
          // (clé en minuscules : la même que #etat, lot 5)
          if (!etat) {
            try {
              const v = JSON.parse(await fsp.readFile(path.join(this.#dossier(lecteur), "vu.json"), "utf8")) as EtatLecteur;
              if (v && v.version === 1) { etat = v; this.#etats.set(lecteur, v); }
            } catch { /* pas d'état : rien à suivre */ }
          }
          if (!etat || !etat.pages[chemin] || etat.pages[chemin].etag === etag) continue;
          const ancienne = etat.pages[chemin].copie;
          etat.pages[chemin] = this.#entree(p, await this.#copier(lecteur, p.contenu), horodatageIso(new Date(), this.#cfg.fuseau));
          await this.#enregistrer(lecteur, etat, [ancienne]);
        }
      }).catch((e) => journal({ niveau: "avertissement", quoi: "nouveautes", erreur: String((e as Error).message).slice(0, 200) }));
    });
  }
}
