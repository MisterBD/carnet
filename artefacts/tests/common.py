"""Utilitaires communs aux tests du serveur d'artefacts (stdlib seulement)."""
import atexit
import base64
import hashlib
import hmac
import http.client
import os
import tempfile
import time
from pathlib import Path

ICI = Path(__file__).resolve().parent
RACINE_ART = ICI.parent                       # dossier du serveur d'artefacts
FIXTURES = ICI / "fixtures" / "artefacts"
SINK_PORT = 3019


def lire_profil(nom="tests"):
    env = {}
    for ligne in (RACINE_ART / "profils" / f"{nom}.env").read_text().splitlines():
        ligne = ligne.strip()
        if ligne and not ligne.startswith("#") and "=" in ligne:
            k, v = ligne.split("=", 1)
            env[k] = v.strip().strip('"')
    return env


ENV = lire_profil(os.environ.get("ART_PROFIL_TESTS", "tests"))
# Dossier des artefacts de test : calculé ici (jamais un chemin de machine dans le profil), exporté pour les lanceurs.
ENV.setdefault("ART_DIR", str(FIXTURES))
os.environ.setdefault("ART_DIR", ENV["ART_DIR"])
ART = ENV["ART_PUBLIC_BASE"]                  # http://127.0.0.1:3006
ART_HOTE = ART.split("://", 1)[1]
APP_ORIGINS = ENV["APP_ORIGINS"]
TTL = int(ENV["ART_TTL"])


def _cle_jetable():
    """Clé de test : celle désignée par ART_HMAC_KEY_FILE, sinon une clé jetable créée pour cette exécution."""
    if os.environ.get("ART_HMAC_KEY_FILE"):
        return Path(os.environ["ART_HMAC_KEY_FILE"])
    fd, chemin = tempfile.mkstemp(prefix="cle-art-", suffix=".key")
    with os.fdopen(fd, "w") as f:
        f.write(os.urandom(32).hex())
    atexit.register(lambda: Path(chemin).unlink(missing_ok=True))
    return Path(chemin)


FICHIER_CLE = _cle_jetable()


# Table multi-origine du profil : « origine appli = base artefacts »
ART_ORIGINES = [tuple(p.split("=", 1)) for p in ENV.get("ART_ORIGINES", "").split()]


def ancetres_attendus():
    """frame-ancestors : toutes les origines appli connues (APP_ORIGINS puis celles de ART_ORIGINES), sans doublon."""
    out = []
    for o in APP_ORIGINS.split() + [a for a, _ in ART_ORIGINES]:
        if o not in out:
            out.append(o)
    return " ".join(out)


def csp_attendue(base=None):
    """La CSP du contrat (docs/architecture.md), recomposée indépendamment du code du serveur (base = origine qui sert)."""
    b = base or ART
    return (
        "sandbox allow-scripts allow-downloads allow-modals; default-src 'none'; "
        f"script-src 'self' 'unsafe-inline' {b}/kit/; style-src 'self' 'unsafe-inline' {b}/kit/; "
        f"img-src 'self' data: blob:; font-src {b}/kit/; connect-src 'none'; "
        f"frame-ancestors {ancetres_attendus()}; base-uri 'none'; form-action 'none'"
    )


def cle():
    return bytes.fromhex(FICHIER_CLE.read_text().strip())


def b64url(b):
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def mac(exp, portee, k=None):
    return b64url(hmac.new(k or cle(), f"{exp}/{portee}".encode(), hashlib.sha256).digest())


def jeton(portee, exp=None, ttl=TTL, k=None):
    exp = int(time.time()) + ttl if exp is None else exp
    return f"{exp}.{mac(exp, portee, k)}"


def requete(base, chemin, methode="GET", entetes=None, corps=None):
    """Requête HTTP brute (le chemin n'est PAS normalisé). Renvoie (statut, {entête minuscule: valeur}, octets)."""
    hote, port = base.split("://", 1)[1].split(":")
    c = http.client.HTTPConnection(hote, int(port), timeout=20)
    try:
        c.request(methode, chemin, body=corps, headers=entetes or {})
        r = c.getresponse()
        corps_r = r.read()
        return r.status, {k.lower(): v for k, v in r.getheaders()}, corps_r
    finally:
        c.close()


def art(chemin, **kw):
    return requete(ART, chemin, **kw)
