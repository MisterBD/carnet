#!/usr/bin/env python3
"""Construit le « kit » d'artefacts (deploy/art/kit/) depuis le registre npm. Stdlib seulement.

Principe : kit.lock.json épingle, pour chaque paquet, une version ET l'empreinte `dist.integrity`
(SRI sha512) du tarball. Le script télécharge le tarball sur registry.npmjs.org, vérifie
l'empreinte contre le fichier de verrou ET contre celle que le registre publie pour cette version,
extrait uniquement les fichiers listés dans FICHIERS, interroge l'API d'avis de sécurité npm
(bulk advisories) et refuse de continuer si une version épinglée a un avis connu.

Modes :
  maj-kit.sh              installe les versions du verrou (reproductible)
  maj-kit.sh --verifier   comme ci-dessus mais sans rien écrire dans kit/ (contrôle seul)
  maj-kit.sh --maj        résout les dernières versions publiées dans les bornes de CONTRAINTES,
                          réécrit kit.lock.json, puis installe
  maj-kit.sh --etat       affiche versions épinglées vs dernières publiées, sans rien changer

Aucun CDN à l'exécution : tout ce qui est servi par /kit/ vient de ce dossier.
"""
import argparse
import base64
import hashlib
import io
import json
import os
import re
import sys
import tarfile
import urllib.error
import urllib.request
from datetime import date
from pathlib import Path

ICI = Path(__file__).resolve().parent
KIT = ICI / "kit"
LOCK = ICI / "kit.lock.json"
CACHE = ICI / ".cache-kit"
REGISTRE = "https://registry.npmjs.org"

# Bornes acceptées pour --maj : (version minimale incluse, version majeure maximale exclue ou None).
# Les minimales viennent de la recherche (correctifs de sécurité) ; chart.js reste en 4.5.x.
CONTRAINTES = {
    "chart.js": ((4, 5, 1), (4, 6, 0)),
    "echarts": ((6, 1, 0), None),
    "mermaid": ((12, 1, 0), None),
    "vega": ((6, 4, 0), None),
    "vega-lite": ((6, 4, 0), None),
    "vega-embed": ((7, 0, 0), None),
    "vega-interpreter": ((2, 0, 0), None),
    "lucide": ((1, 52, 0), None),
    "@fontsource/roboto": ((5, 0, 0), None),
    "@fontsource/crimson-pro": ((5, 0, 0), None),
}

# (paquet, chemin dans le tarball, nom servi sous /kit/, transformation)
FICHIERS = [
    ("chart.js", "package/dist/chart.umd.min.js", "chart.js/chart.umd.min.js", None),
    ("echarts", "package/dist/echarts.min.js", "echarts/echarts.min.js", None),
    ("mermaid", "package/dist/mermaid.min.js", "mermaid/mermaid.min.js", None),
    ("vega", "package/build/vega.min.js", "vega/vega.min.js", None),
    ("vega-lite", "package/build/vega-lite.min.js", "vega-lite/vega-lite.min.js", None),
    ("vega-embed", "package/build/vega-embed.min.js", "vega-embed/vega-embed.min.js", None),
    # Le tarball ne publie qu'un module ES : on l'enveloppe en script classique (voir iife_interpreteur).
    ("vega-interpreter", "package/build/vega-interpreter.js", "vega-interpreter/vega-interpreter.js", "iife_interpreteur"),
    ("lucide", "package/dist/umd/lucide.min.js", "lucide/lucide.min.js", None),
    ("@fontsource/roboto", "package/files/roboto-latin-400-normal.woff2", "fonts/roboto-latin-400-normal.woff2", None),
    ("@fontsource/roboto", "package/files/roboto-latin-500-normal.woff2", "fonts/roboto-latin-500-normal.woff2", None),
    ("@fontsource/roboto", "package/files/roboto-latin-700-normal.woff2", "fonts/roboto-latin-700-normal.woff2", None),
    ("@fontsource/crimson-pro", "package/files/crimson-pro-latin-400-normal.woff2", "fonts/crimson-pro-latin-400-normal.woff2", None),
    ("@fontsource/crimson-pro", "package/files/crimson-pro-latin-600-normal.woff2", "fonts/crimson-pro-latin-600-normal.woff2", None),
]
# Licences copiées avec le kit (obligation de redistribution).
LICENCES = {
    "chart.js": ["package/LICENSE.md"],
    "echarts": ["package/LICENSE", "package/NOTICE"],
    "mermaid": ["package/LICENSE"],
    "vega": ["package/LICENSE"],
    "vega-lite": ["package/LICENSE"],
    "vega-embed": ["package/LICENSE"],
    "vega-interpreter": ["package/LICENSE"],
    "lucide": ["package/LICENSE"],
    "@fontsource/roboto": ["package/LICENSE"],
    "@fontsource/crimson-pro": ["package/LICENSE"],
}

FONTS_CSS = """/* Polices du kit (@fontsource, OFL-1.1), sous-ensemble latin. Servies localement, sans CDN. */
""" + "\n".join(
    "@font-face{font-family:'%s';font-style:normal;font-display:swap;font-weight:%d;src:url(%s-latin-%d-normal.woff2) format('woff2')}"
    % (fam, poids, slug, poids)
    for fam, slug, poids in [
        ("Roboto", "roboto", 400), ("Roboto", "roboto", 500), ("Roboto", "roboto", 700),
        ("Crimson Pro", "crimson-pro", 400), ("Crimson Pro", "crimson-pro", 600),
    ]
) + "\n"


def sortie(msg):
    print(msg, flush=True)


def echec(msg):
    print("ERREUR : " + msg, file=sys.stderr, flush=True)
    sys.exit(1)


def http_get(url, binaire=True, tentatives=3):
    derniere = None
    for _ in range(tentatives):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "carnet-maj-kit/1"})
            with urllib.request.urlopen(req, timeout=60) as r:
                data = r.read()
            return data if binaire else data.decode("utf-8")
        except (urllib.error.URLError, TimeoutError) as e:
            derniere = e
    echec(f"téléchargement impossible : {url} ({derniere})")


def vers_tuple(v):
    m = re.match(r"^(\d+)\.(\d+)\.(\d+)$", v)
    return tuple(int(x) for x in m.groups()) if m else None


def nom_tarball(paquet, version):
    base = paquet.split("/")[-1]
    return f"{REGISTRE}/{paquet}/-/{base}-{version}.tgz"


def sri_sha512(data):
    return "sha512-" + base64.b64encode(hashlib.sha512(data).digest()).decode()


def meta_version(paquet, version):
    url = f"{REGISTRE}/{paquet.replace('/', '%2f')}/{version}"
    return json.loads(http_get(url, binaire=False))


def derniere_version(paquet):
    url = f"{REGISTRE}/{paquet.replace('/', '%2f')}/latest"
    return json.loads(http_get(url, binaire=False))["version"]


def dans_bornes(paquet, version):
    t = vers_tuple(version)
    if t is None:
        return False
    mini, maxi = CONTRAINTES[paquet]
    return t >= mini and (maxi is None or t < maxi)


def avis_securite(versions):
    """API bulk d'avis npm : renvoie {paquet: [avis...]} pour les versions données. Vide = aucun avis connu."""
    corps = json.dumps({p: [v] for p, v in versions.items()}).encode()
    req = urllib.request.Request(
        f"{REGISTRE}/-/npm/v1/security/advisories/bulk", data=corps,
        headers={"Content-Type": "application/json", "User-Agent": "carnet-maj-kit/1"})
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode())


def iife_interpreteur(source):
    """vega-interpreter n'est publié qu'en module ES (import depuis 'vega-util'). Les mêmes fonctions
    sont exposées par vega.min.js : on retire l'import/export et on enveloppe dans une IIFE qui lit
    globalThis.vega et expose vega.expressionInterpreter. Transformation textuelle stricte : si le
    format amont change, le script s'arrête au lieu de produire un fichier faux."""
    ligne_import = "import { ascending, isString, DisallowedObjectProperties } from 'vega-util';"
    ligne_export = "export { expression as expressionInterpreter };"
    if source.count(ligne_import) != 1 or source.count(ligne_export) != 1:
        echec("format de vega-interpreter inattendu (import/export modifiés) : adapter iife_interpreteur()")
    if re.search(r"^\s*(import|export)\s", source.replace(ligne_import, "").replace(ligne_export, ""), re.M):
        echec("vega-interpreter contient d'autres import/export : adapter iife_interpreteur()")
    corps = source.replace(ligne_import, "").replace(ligne_export, "").replace("//# sourceMappingURL=vega-interpreter.js.map", "")
    return (
        "/* vega-interpreter : enveloppe IIFE générée par maj-kit.py (voir kit/VERSIONS.md). Requiert vega.min.js chargé avant. */\n"
        "(function (g) {\n'use strict';\nconst { ascending, isString, DisallowedObjectProperties } = g.vega;\n"
        + corps +
        "\ng.vega.expressionInterpreter = expression;\n})(globalThis);\n"
    )


TRANSFORMS = {"iife_interpreteur": lambda b: iife_interpreteur(b.decode("utf-8")).encode("utf-8")}


def lire_lock():
    if not LOCK.exists():
        echec(f"{LOCK.name} absent : lancer avec --maj pour le créer")
    return json.loads(LOCK.read_text(encoding="utf-8"))


def recuperer_tarball(paquet, version, integrite_attendue):
    """Télécharge (ou lit le cache), vérifie l'empreinte SRI. Le cache n'est jamais cru sans vérification."""
    CACHE.mkdir(exist_ok=True)
    cache = CACHE / (paquet.replace("/", "__") + "-" + version + ".tgz")
    data = cache.read_bytes() if cache.exists() else None
    if data is None or sri_sha512(data) != integrite_attendue:
        data = http_get(nom_tarball(paquet, version))
        if sri_sha512(data) != integrite_attendue:
            echec(f"empreinte du tarball {paquet}@{version} différente de celle attendue "
                  f"({sri_sha512(data)[:24]}… au lieu de {integrite_attendue[:24]}…) : arrêt")
        cache.write_bytes(data)
    return data


def ecrire_atomique(chemin, data):
    chemin.parent.mkdir(parents=True, exist_ok=True)
    tmp = chemin.with_name(chemin.name + ".tmp")
    tmp.write_bytes(data)
    os.replace(tmp, chemin)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    g = ap.add_mutually_exclusive_group()
    g.add_argument("--maj", action="store_true", help="résout les dernières versions dans les bornes et réécrit le verrou")
    g.add_argument("--verifier", action="store_true", help="vérifie tarballs et avis sans écrire le kit")
    g.add_argument("--etat", action="store_true", help="compare versions épinglées et dernières publiées")
    ap.add_argument("--sans-avis", action="store_true",
                    help="si l'API d'avis npm est INJOIGNABLE, avertir et continuer (défaut : bloquer). Un avis connu "
                         "bloque toujours. Équivaut à KIT_SANS_AVIS=1.")
    args = ap.parse_args()
    sans_avis = args.sans_avis or os.environ.get("KIT_SANS_AVIS") == "1"

    paquets = sorted({f[0] for f in FICHIERS})
    if set(paquets) != set(CONTRAINTES) or set(paquets) != set(LICENCES):
        echec("FICHIERS, CONTRAINTES et LICENCES ne listent pas les mêmes paquets")

    if args.etat:
        lock = lire_lock()["paquets"]
        for p in paquets:
            last = derniere_version(p)
            epingle = lock.get(p, {}).get("version", "-")
            marque = "" if last == epingle else "   <- plus récent publié" + ("" if dans_bornes(p, last) else " (hors bornes)")
            sortie(f"{p:26s} épinglé {epingle:10s} dernier {last:10s}{marque}")
        return

    if args.maj:
        nouveau = {}
        for p in paquets:
            v = derniere_version(p)
            if not dans_bornes(p, v):
                echec(f"{p}@{v} hors des bornes de CONTRAINTES : revoir les bornes (changement majeur ?)")
            meta = meta_version(p, v)
            nouveau[p] = {"version": v, "integrity": meta["dist"]["integrity"], "licence": meta.get("license", "?")}
        lock = {"genere": date.today().isoformat(), "paquets": nouveau}
        LOCK.write_text(json.dumps(lock, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
        sortie(f"{LOCK.name} réécrit.")
    lock = lire_lock()
    epingles = lock["paquets"]
    if set(epingles) != set(paquets):
        echec("le verrou ne couvre pas exactement les paquets du kit : lancer --maj")

    # 1. Avis de sécurité sur les versions épinglées.
    try:
        avis = avis_securite({p: epingles[p]["version"] for p in paquets})
    except (OSError, ValueError) as e:
        if not sans_avis:
            echec(f"API d'avis npm injoignable ({e}) : réessayer, ou --sans-avis pour continuer sans ce contrôle")
        sortie(f"ATTENTION : API d'avis npm injoignable ({e}) : contrôle des avis SAUTÉ (--sans-avis).")
        avis = None
    if avis:
        for p, liste in avis.items():
            for a in liste:
                sortie(f"AVIS {p}@{epingles[p]['version']} : {a.get('title')} ({a.get('severity')}) {a.get('url')}")
        echec("avis de sécurité connu(s) sur une version épinglée : mettre à jour (--maj) ou lever la contrainte")
    if avis is not None:
        sortie("Avis npm : aucun pour les versions épinglées.")

    # 2. Tarballs vérifiés (verrou + registre).
    tarballs = {}
    for p in paquets:
        v, integ = epingles[p]["version"], epingles[p]["integrity"]
        if not dans_bornes(p, v):
            echec(f"{p}@{v} hors bornes de CONTRAINTES")
        publiee = meta_version(p, v)["dist"]["integrity"]
        if publiee != integ:
            echec(f"{p}@{v} : le registre publie une empreinte différente de kit.lock.json ({publiee[:24]}…) : arrêt")
        tarballs[p] = tarfile.open(fileobj=io.BytesIO(recuperer_tarball(p, v, integ)), mode="r:gz")
        sortie(f"OK {p}@{v} intégrité vérifiée ({integ[:22]}…)")

    # 3. Extraction ciblée.
    sorties = {}  # nom servi -> (octets, paquet)
    for p, src, dest, transf in FICHIERS:
        f = tarballs[p].extractfile(src)
        if f is None:
            echec(f"{src} absent du tarball {p}")
        data = f.read()
        if transf:
            data = TRANSFORMS[transf](data)
        sorties[dest] = (data, p)
    sorties["fonts/fonts.css"] = (FONTS_CSS.encode(), "@fontsource/*")
    # Fichiers maison (non npm) : kit-local/ est copié tel quel à la racine de /kit/.
    for f in sorted((ICI / "kit-local").glob("*")):
        if f.is_file():
            sorties[f.name] = (f.read_bytes(), "maison")
    licences = {}
    for p, chemins in LICENCES.items():
        for c in chemins:
            f = tarballs[p].extractfile(c)
            if f is None:
                echec(f"licence {c} absente du tarball {p}")
            licences[f"licences/{p.replace('/', '__')}-{Path(c).name}"] = f.read()

    if args.verifier:
        sortie(f"Vérification seule : {len(sorties)} fichiers prêts, rien écrit.")
        return

    # 4. Écriture : on remplace le contenu du kit (fichiers générés), sans toucher VERSIONS.md.
    KIT.mkdir(exist_ok=True)
    voulus = set(sorties) | set(licences) | {"kit.json", "VERSIONS.md"}
    for racine, _, noms in os.walk(KIT):
        for n in noms:
            rel = str((Path(racine) / n).relative_to(KIT))
            if rel not in voulus and not rel.endswith(".tmp"):
                (Path(racine) / n).unlink()
    manifeste = {"genere": date.today().isoformat(), "fichiers": {}}
    for dest, (data, p) in sorted(sorties.items()):
        ecrire_atomique(KIT / dest, data)
        manifeste["fichiers"][dest] = {"paquet": p, "octets": len(data), "sha256": hashlib.sha256(data).hexdigest()}
    for dest, data in sorted(licences.items()):
        ecrire_atomique(KIT / dest, data)
    manifeste["paquets"] = {p: epingles[p]["version"] for p in paquets}
    ecrire_atomique(KIT / "kit.json", (json.dumps(manifeste, indent=1, ensure_ascii=False) + "\n").encode())

    # 5. VERSIONS.md (commité : trace lisible de ce que le kit contient).
    lignes = [
        "# Kit d'artefacts : versions épinglées",
        "",
        f"Généré par `deploy/art/maj-kit.sh` (verrou `kit.lock.json` du {lock['genere']}, kit écrit le {date.today().isoformat()}).",
        "Source : tarballs `https://registry.npmjs.org/<paquet>/-/<paquet>-<version>.tgz`, empreinte `dist.integrity` vérifiée",
        "contre le verrou et contre le registre. Avis de sécurité npm (API bulk) : **aucun** sur ces versions à la date de génération.",
        "Aucune dépendance à un CDN à l'exécution : tout est servi par le serveur d'artefacts sous `/kit/`.",
        "",
        "| Paquet | Version | Licence | Intégrité du tarball (sha512, début) | Bornes pour `--maj` |",
        "|---|---|---|---|---|",
    ]
    for p in paquets:
        mini, maxi = CONTRAINTES[p]
        bornes = ">= " + ".".join(map(str, mini)) + (" et < " + ".".join(map(str, maxi)) if maxi else "")
        lignes.append(f"| `{p}` | {epingles[p]['version']} | {epingles[p].get('licence', '?')} | `{epingles[p]['integrity'][:30]}…` | {bornes} |")
    lignes += ["", "## Fichiers servis", "", "| URL | Paquet | Octets | sha256 (début) |", "|---|---|---:|---|"]
    for dest, m in sorted(manifeste["fichiers"].items()):
        lignes.append(f"| `/kit/{dest}` | `{m['paquet']}` | {m['octets']:,} | `{m['sha256'][:16]}…` |".replace(",", " "))
    lignes += [
        "",
        "## Notes",
        "",
        "- `vega-interpreter.js` : le paquet npm ne publie qu'un module ES. `maj-kit.py` retire l'`import`/`export` et enveloppe le code dans une IIFE qui lit `globalThis.vega` (fonctions de `vega-util` déjà exposées par `vega.min.js`) et expose `vega.expressionInterpreter`. Charger `vega.min.js` AVANT. Sert à exécuter les expressions Vega sans `unsafe-eval` (`{ast: true, expr: vega.expressionInterpreter}` avec vega-embed).",
        "- `mermaid.min.js` : bundle autonome (IIFE, expose `globalThis.mermaid`).",
        "- `fonts/fonts.css` : généré (Roboto 400/500/700, Crimson Pro 400/600, sous-ensemble latin, `@fontsource`, OFL-1.1).",
        "- `pont.js` : pont `postMessage` maison (source `kit-local/pont.js`) : `artefact:hauteur` automatique et `hote:theme` -> `<html data-theme>`.",
        "- `licences/` : fichiers LICENSE/NOTICE de chaque paquet.",
        "- Mettre à jour : `./maj-kit.sh --etat` (comparer), `./maj-kit.sh --maj` (adopter les dernières versions dans les bornes + avis de sécurité), puis relancer les tests (`tests/lancer.sh`) avant tout déploiement.",
        "",
    ]
    ecrire_atomique(KIT / "VERSIONS.md", "\n".join(lignes).encode())
    sortie(f"Kit écrit : {len(sorties)} fichiers, {sum(len(d) for d, _ in sorties.values()) // 1024} Kio, dans {KIT}")


if __name__ == "__main__":
    main()
