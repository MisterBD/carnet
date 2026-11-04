#!/usr/bin/env python3
"""Banc de fidélité Markdown de Carnet : aller-retour avec le VRAI éditeur (Tiptap), dans Chromium.

Usage :
  (cd web && nice -n 10 npx vite build --mode outils)
  python3 tests/fidelite.py [--reference <dist-outils d'un autre build>] [--json sortie.json] [--sans-extraits notes] \
      [--exclure prive,archives] demo=<dossier> notes=<copie en lecture seule de tes .md>

Pour chaque page : corps original (sans frontmatter ni titre, comme dans Carnet), N0 = sérialisation sans modification,
puis trois modifications (paragraphe ajouté en fin, mot ajouté au 1er paragraphe, case cochée) et la fusion bloc par bloc.
Mesures (définitions de web/src/outils/mesures.ts) : identique à l'octet, même rendu (arbres CommonMark + GFM égaux),
constructions perdues, lignes touchées hors du bloc modifié. Plus les cas élémentaires (=, ≈, ✗).
`--reference` mesure aussi un autre build du banc (ex. Carnet-Crepe) sur le même corpus, avec les mêmes mesures.
"""
import argparse, functools, http.server, json, os, socketserver, sys, threading
from pathlib import Path
from playwright.sync_api import sync_playwright

ICI = Path(__file__).resolve().parent
DIST = ICI.parent / "web" / "dist-outils"
EXCLUS = {".git", ".corbeille", "node_modules"}

ap = argparse.ArgumentParser()
ap.add_argument("corpus", nargs="*", help="nom=dossier")
ap.add_argument("--reference", default=None)
ap.add_argument("--json", default=None)
ap.add_argument("--sans-extraits", default="", help="corpus (séparés par des virgules) dont aucun extrait n'est gardé")
ap.add_argument("--exclure", default="", help="dossiers à ignorer en plus de .git, .corbeille et node_modules (virgules)")
ap.add_argument("--detail", action="store_true")
args = ap.parse_args()
SANS_EXTRAITS = set(filter(None, args.sans_extraits.split(",")))
EXCLUS |= set(filter(None, args.exclure.split(",")))


def servir(dossier):
    gest = functools.partial(http.server.SimpleHTTPRequestHandler, directory=str(dossier))
    gest.log_message = lambda *a: None
    srv = socketserver.ThreadingTCPServer(("127.0.0.1", 0), gest)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def fichiers(racine: Path):
    res = []
    for dp, dns, fns in os.walk(racine):
        dns[:] = sorted(d for d in dns if not d.startswith(".") and d not in EXCLUS)
        for f in sorted(fns):
            p = Path(dp) / f
            if f.endswith(".md") and not f.startswith(".") and not p.is_symlink():
                res.append(p)
    return res


def ouvrir(nav, dist):
    srv = servir(dist)
    page = nav.new_page()
    erreurs = []
    page.on("console", lambda m: erreurs.append(m.text[:300]) if m.type == "error" else None)
    page.on("pageerror", lambda e: erreurs.append(str(e)[:300]))
    page.goto(f"http://127.0.0.1:{srv.server_address[1]}/outils/fidelite.html")
    page.wait_for_function("document.title === 'pret'", timeout=30000)
    return srv, page, erreurs


def mesurer(page_mesures, nom_corpus, rel, contenu, r):
    """Mesures calculées dans la page du banc Tiptap (fonctions exposées par window.carnetMesures)."""
    M = lambda f, *a: page_mesures.evaluate(f"([a]) => window.carnetMesures.{f}(...a)", [list(a)])
    corps, n0 = r["corps"], r["n0"]
    e = {"corpus": nom_corpus, "fichier": rel, "octets": len(contenu.encode())}
    e["identique"] = M("memeTexte", n0, corps)
    e["memeRendu"] = M("memeRendu", n0, corps)
    e["pertes"] = M("pertes", corps, n0)
    e["lignes"] = M("lignesChangees", corps.rstrip("\n"), n0.rstrip("\n"))
    e["msOuvrir"] = r.get("msOuvrir")
    L = 0 if corps.rstrip("\n") == "" else len(corps.rstrip("\n").split("\n"))
    hors = M("horsBloc", corps, r["fusion"], L, L)
    e["fin"] = len(hors) == 0
    extraits = nom_corpus not in SANS_EXTRAITS
    if extraits and hors:
        e["fin_hors"] = hors[:4]
    cibles = M("blocsCibles", corps)
    if cibles["paragraphe"] and r.get("paragraphe"):
        a, b = cibles["paragraphe"]
        cible = M("texteDeMd", "\n".join(corps.split("\n")[a:b])).strip()[:12]
        if f"Modifié {cible}" in M("texteDeMd", r["paragraphe"]["fusion"]):
            h = M("horsBloc", corps, r["paragraphe"]["fusion"], a, b)
            e["paragraphe"] = len(h) == 0
            if extraits and h:
                e["paragraphe_hors"] = h[:4]
    if cibles["tache"] and r.get("tache"):
        a, b = cibles["tache"]
        h = M("horsBloc", corps, r["tache"]["fusion"], a, b)
        e["tache"] = len(h) == 0
        if extraits and h:
            e["tache_hors"] = h[:4]
    if extraits and not e["identique"]:
        e["diff_n0"] = M("horsBloc", corps, n0, -1, -1)[:8]
    return e


def synthese(res):
    s = {}
    for c in sorted({x["corpus"] for x in res}):
        r = [x for x in res if x["corpus"] == c and "erreur" not in x]
        compte = lambda f: sum(1 for x in r if f(x))
        def mod(cle):
            xs = [x for x in r if cle in x]
            return f"{sum(1 for x in xs if x[cle])}/{len(xs)}"
        ms = sorted(x["msOuvrir"] for x in r if x.get("msOuvrir") is not None)
        s[c] = {
            "pages": len([x for x in res if x["corpus"] == c]),
            "erreurs": len([x for x in res if x["corpus"] == c and "erreur" in x]),
            "identiques": compte(lambda x: x["identique"]),
            "memeRendu": compte(lambda x: x["memeRendu"]),
            "texteAltere": compte(lambda x: x["pertes"].get("texte") != "intact"),
            "pertes": sorted({f"{k}={v}" for x in r for k, v in x["pertes"].items() if v != "intact"}),
            "lignesReecrites": sum(x["lignes"] for x in r),
            "fusionFin": mod("fin"), "fusionParagraphe": mod("paragraphe"), "fusionTache": mod("tache"),
            "msOuvrirMedian": ms[len(ms) // 2] if ms else None,
        }
    return s


def banc(nav, dist, page_mesures, corpus, etiquette):
    srv, page, erreurs = ouvrir(nav, dist)
    res = []
    for nom, dossier in corpus:
        for f in fichiers(Path(dossier)):
            rel = str(f.relative_to(dossier))
            contenu = f.read_text(encoding="utf-8")
            erreurs.clear()
            try:
                r = page.evaluate("([c, t]) => window.carnetFidelite(c, t)", [rel, contenu])
                e = mesurer(page_mesures or page, nom, rel, contenu, r)
            except Exception as ex:  # noqa
                e = {"corpus": nom, "fichier": rel, "erreur": str(ex)[:300]}
                srv.shutdown(); page.close()
                srv, page, erreurs = ouvrir(nav, dist)
            if erreurs:
                e["console"] = erreurs[:3]
            res.append(e)
            print(".", end="", file=sys.stderr, flush=True)
    # cas élémentaires
    cas = []
    liste = (page_mesures or page).evaluate("() => window.carnetMesures.CAS")
    for i, (nom, md) in enumerate(liste):
        try:
            r = page.evaluate("([c, t]) => window.carnetFidelite(c, t)", ["cas.md", md])
            sortie = r["frontmatter"] + r["blocTitre"] + r["n0"]
        except Exception as ex:  # noqa
            sortie = f"ERREUR {ex}"
        note = (page_mesures or page).evaluate("([i, s]) => window.carnetMesures.noterCas(i, s)", [i, sortie])
        cas.append({"cas": nom, "note": note, "md": md, "sortie": sortie.rstrip("\n")})
    page.close(); srv.shutdown()
    print(f" {etiquette} fini", file=sys.stderr)
    return res, cas


def main():
    corpus = [tuple(a.split("=", 1)) for a in args.corpus]
    with sync_playwright() as pw:
        nav = pw.chromium.launch()
        res, cas = banc(nav, DIST, None, corpus, "carnet-tiptap")
        sortie = {"carnet-tiptap": {"synthese": synthese(res), "cas": cas, "pages": res}}
        if args.reference:
            srv_m, page_m, _ = ouvrir(nav, DIST)
            res_r, cas_r = banc(nav, Path(args.reference), page_m, corpus, "référence")
            sortie["reference"] = {"synthese": synthese(res_r), "cas": cas_r, "pages": res_r}
            page_m.close(); srv_m.shutdown()
        nav.close()
    if args.json:
        Path(args.json).write_text(json.dumps(sortie, ensure_ascii=False, indent=1))
    for nom, v in sortie.items():
        print(f"\n== {nom}")
        for c, s in v["synthese"].items():
            print(f"  {c} : {s['pages']} pages ; identiques {s['identiques']} ; même rendu {s['memeRendu']} ; texte altéré {s['texteAltere']} ; "
                  f"lignes réécrites {s['lignesReecrites']} ; fusion fin {s['fusionFin']}, paragraphe {s['fusionParagraphe']}, tâche {s['fusionTache']} ; "
                  f"erreurs {s['erreurs']} ; ouverture médiane {s['msOuvrirMedian']} ms")
            if s["pertes"]:
                print("    pertes : " + ", ".join(s["pertes"]))
        n = {k: sum(1 for x in v["cas"] if x["note"] == k) for k in "=≈✗"}
        print(f"  cas élémentaires : {n['=']} = / {n['≈']} ≈ / {n['✗']} ✗ sur {len(v['cas'])}")
        if args.detail:
            for x in v["cas"]:
                if x["note"] != "=":
                    print(f"    {x['note']} {x['cas']} : {x['sortie'][:120]!r}")
            for p in v["pages"]:
                if not p.get("identique") or p.get("erreur") or p.get("console"):
                    print(f"    {p['corpus']}/{p['fichier']} : {'= ' if p.get('identique') else ''}{'rendu identique' if p.get('memeRendu') else 'RENDU CHANGÉ'} {p.get('erreur', '')} {p.get('console', '')}")
                    for l in p.get("diff_n0", [])[:4]:
                        print("        " + l[:140])


if __name__ == "__main__":
    main()
