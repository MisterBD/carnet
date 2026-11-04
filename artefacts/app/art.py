#!/usr/bin/env python3
"""Serveur d'artefacts de Carnet : artefacts HTML isolés. Python 3 stdlib seulement.

Rôle : servir, sur une ORIGINE SÉPARÉE de l'appli de notes, les artefacts HTML écrits par les agents
(dossier `artefacts/` monté en lecture seule), le « kit » de bibliothèques épinglées et les pages de
rendu isolées Mermaid / Vega-Lite. L'accès aux artefacts se fait par jeton HMAC court dans l'URL ;
chaque réponse porte une CSP `sandbox` (origine opaque, aucune sortie réseau).

Routes (contrat : docs/architecture.md, « Interface artefacts ») :
  GET /_art/<chemin>            -> 302 vers ${ART_PUBLIC_BASE}/a/<exp>.<hmac>/<chemin>   (derrière la porte de l'appli)
  GET /a/<exp>.<hmac>/<chemin>  -> fichier de l'artefact (jeton, expiration, pas de .., pas de listing)
  GET /kit/<fichier>            -> bibliothèques épinglées (ACAO *, cache)
  GET /rendu/mermaid|vega-lite  -> pages de rendu isolées (reçoivent {type, spec} par postMessage)
  GET /sante                    -> 200 « ok », rien d'autre

Jeton : exp = horodatage Unix d'expiration ; hmac = base64url(HMAC-SHA256(clé, f"{exp}/{portée}")) où
portée = premier segment du chemin (le dossier de l'artefact, ou le fichier s'il est à plat) : ainsi
`./data.js` et `./img.svg` relatifs à l'artefact restent couverts par le même préfixe de jeton.

Plusieurs origines : la même instance peut servir l'appli locale (http://127.0.0.1:3020, artefacts sur
http://127.0.0.1:3006), un accès par proxy (https://carnet.exemple.ts.net -> https://carnet.exemple.ts.net:8443) ou un
nom de domaine (https://carnet.exemple.org -> https://art.exemple.org). ART_ORIGINES (alias : CARNET_ORIGINES_ARTEFACTS,
la même variable que Carnet) = table « origine appli = base artefacts » : /_art redirige vers la base qui correspond à
l'en-tête Host reçu ; les réponses /a/ et /rendu/ portent la CSP de la base qui les sert ; frame-ancestors liste toutes
les origines appli connues. APP_ORIGINS est facultative quand la table est renseignée.

Capacité : une connexion = un fil, au plus ART_MAX_CONN. Au-delà, la connexion ATTEND une place (ART_ATTENTE_PLACE
secondes, puis 503) au lieu d'être refusée tout de suite, et les connexions inactives (keep-alive, pré-connexions
du navigateur) cèdent leur place dès qu'une connexion attend.

Variables d'environnement : voir lire_config().
"""
import base64
import hashlib
import hmac
import json
import os
import re
import select
import stat
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import quote, unquote

# ----------------------------------------------------------------------------------------------
# Configuration
# ----------------------------------------------------------------------------------------------

ORIGINE_RE = re.compile(r"^https?://[A-Za-z0-9.\-]+(:[0-9]{1,5})?$")
TOKEN_RE = re.compile(r"^([0-9]{1,12})\.([A-Za-z0-9_-]{43})$")

TYPES_MIME = {
    ".html": "text/html; charset=utf-8", ".htm": "text/html; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif",
    ".webp": "image/webp", ".avif": "image/avif", ".ico": "image/x-icon",
    ".csv": "text/csv; charset=utf-8", ".txt": "text/plain; charset=utf-8",
    ".md": "text/markdown; charset=utf-8", ".xml": "application/xml; charset=utf-8",
    ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf", ".otf": "font/otf",
    ".pdf": "application/pdf",
}
# Extensions que /kit/ accepte de servir (le reste -> 404).
KIT_EXTENSIONS = {".js", ".css", ".woff2", ".woff", ".json", ".md", ".txt", ".svg"}


def hotes_equivalents(origine):
    """En-têtes Host qui désignent cette origine : « hote:port », et « hote » seul si le port est celui du schéma."""
    schema, reste = origine.split("://", 1)
    reste = reste.lower()
    hote, _, port = reste.partition(":")
    defaut = "443" if schema == "https" else "80"
    if not port:
        return {hote, f"{hote}:{defaut}"}
    return {reste} | ({hote} if port == defaut else set())


def _sans_doublons(liste):
    vus, out = set(), []
    for x in liste:
        if x not in vus:
            vus.add(x)
            out.append(x)
    return out


def lire_config():
    e = os.environ
    base = e.get("ART_PUBLIC_BASE", "").rstrip("/")
    if not ORIGINE_RE.match(base):
        sys.exit("ART_PUBLIC_BASE invalide (attendu : http(s)://hote[:port], sans chemin) : %r" % base)
    origines = e.get("APP_ORIGINS", "").split()
    for o in origines:
        if not ORIGINE_RE.match(o.rstrip("/")):
            sys.exit("APP_ORIGINS : origine invalide %r" % o)
    origines = [o.rstrip("/") for o in origines]
    # Table « origine appli = base artefacts » (ART_ORIGINES). Absente : toutes les origines appli -> ART_PUBLIC_BASE.
    correspondances = []
    # Une seule variable peut servir les deux services : CARNET_ORIGINES_ARTEFACTS est acceptée si ART_ORIGINES est absente.
    table = e.get("ART_ORIGINES") if e.get("ART_ORIGINES") is not None else e.get("CARNET_ORIGINES_ARTEFACTS", "")
    for paire in table.split():
        appli, egal, art_base = paire.partition("=")
        appli, art_base = appli.rstrip("/"), art_base.rstrip("/")
        if not egal or not ORIGINE_RE.match(appli) or not ORIGINE_RE.match(art_base):
            sys.exit("ART_ORIGINES : paire invalide %r (attendu origine_appli=base_artefacts)" % paire)
        correspondances.append((appli, art_base))
    if not correspondances:
        correspondances = [(o, base) for o in origines]
    origines = _sans_doublons(origines + [a for a, _ in correspondances])
    bases = _sans_doublons([base] + [b for _, b in correspondances])
    hotes_app = {}
    for appli, art_base in correspondances:
        for h in hotes_equivalents(appli):
            hotes_app.setdefault(h, art_base)
    hotes_art = {h: b for b in bases for h in hotes_equivalents(b)}
    for h in hotes_art:
        if h in hotes_app:
            sys.exit("ART_ORIGINES : %r est à la fois une origine appli et une base d'artefacts (même origine interdite)" % h)
    try:
        ttl = int(e.get("ART_TTL", "900"))
    except ValueError:
        sys.exit("ART_TTL doit être un entier")
    if not 30 <= ttl <= 86400:
        sys.exit("ART_TTL hors bornes (30..86400)")
    return {
        "base": base,
        "hote_public": base.split("://", 1)[1].lower(),
        "origines": origines,
        "correspondances": correspondances,
        "bases": bases,
        "hotes_app": hotes_app,     # Host reçu sur /_art -> base d'artefacts vers laquelle rediriger
        "hotes_art": hotes_art,     # Host reçu sur /a/, /rendu/ -> base qui sert la réponse (pour la CSP)
        "ttl": ttl,
        "racine_art": Path(e.get("ART_ROOT", "/data/artefacts")),
        "racine_kit": Path(e.get("KIT_ROOT", "/kit")),
        "dossier_rendu": Path(e.get("RENDU_ROOT", str(Path(__file__).parent / "rendu"))),
        "fichier_cle": Path(e.get("ART_HMAC_KEY_FILE", "/run/secrets/art-hmac.key")),
        "taille_max": int(e.get("ART_MAX_FILE", str(5 * 1024 * 1024))),
        "ecoute": (e.get("ART_LISTEN_HOST", "0.0.0.0"), int(e.get("ART_LISTEN_PORT", "3006"))),
        # Défense en profondeur : /_art (qui SIGNE) est refusé si la requête arrive avec le Host du domaine public d'artefacts.
        "refuser_signature_sur_hote_public": e.get("ART_REFUSE_SIGN_ON_PUBLIC_HOST", "1") != "0",
        "max_connexions": int(e.get("ART_MAX_CONN", "96")),
        "attente_place": float(e.get("ART_ATTENTE_PLACE", "10")),
    }


CFG = None  # rempli par main() (ou par les tests unitaires)


def csp_artefact(cfg, base=None):
    """En-tête CSP des artefacts et pages de rendu : EXACTEMENT la forme du contrat docs/architecture.md.
    `base` = l'origine d'artefacts qui sert la réponse (défaut : ART_PUBLIC_BASE)."""
    b = base or cfg["base"]
    ancetres = " ".join(cfg["origines"]) if cfg["origines"] else "'none'"
    return (
        "sandbox allow-scripts allow-downloads allow-modals; default-src 'none'; "
        f"script-src 'self' 'unsafe-inline' {b}/kit/; "
        f"style-src 'self' 'unsafe-inline' {b}/kit/; "
        "img-src 'self' data: blob:; "
        f"font-src {b}/kit/; "
        "connect-src 'none'; "
        f"frame-ancestors {ancetres}; "
        "base-uri 'none'; form-action 'none'"
    )


# ----------------------------------------------------------------------------------------------
# Clé HMAC et jetons
# ----------------------------------------------------------------------------------------------

class Cle:
    """Clé de 32 octets lue dans un fichier (64 caractères hexadécimaux), relue si le fichier change."""
    def __init__(self, chemin):
        self.chemin = Path(chemin)
        self._mtime = None
        self._cle = None
        self._verrou = threading.Lock()
        self.valeur()  # échoue vite au démarrage

    def valeur(self):
        with self._verrou:
            st = os.stat(self.chemin)
            if self._cle is None or st.st_mtime_ns != self._mtime:
                txt = self.chemin.read_text(encoding="ascii").strip()
                if not re.fullmatch(r"[0-9a-fA-F]{64}", txt):
                    raise ValueError("clé HMAC : 64 caractères hexadécimaux attendus (32 octets)")
                self._cle = bytes.fromhex(txt)
                self._mtime = st.st_mtime_ns
            return self._cle


def b64url(octets):
    return base64.urlsafe_b64encode(octets).rstrip(b"=").decode("ascii")


def mac(cle, exp, portee):
    return b64url(hmac.new(cle, f"{exp}/{portee}".encode("utf-8"), hashlib.sha256).digest())


def signer(cle, portee, ttl, maintenant=None):
    exp = int((time.time() if maintenant is None else maintenant)) + ttl
    return f"{exp}.{mac(cle, exp, portee)}"


def verifier_jeton(cle, jeton, portee, maintenant=None):
    """Renvoie 'ok', 'invalide' ou 'expire'. Comparaison en temps constant ; l'expiration n'est
    examinée qu'APRÈS validation de la signature (on ne révèle rien sur un jeton non signé)."""
    m = TOKEN_RE.match(jeton)
    if not m:
        return "invalide"
    exp, recu = m.group(1), m.group(2)
    attendu = mac(cle, exp, portee)
    if not hmac.compare_digest(attendu.encode("ascii"), recu.encode("ascii")):
        return "invalide"
    if int(exp) < int(time.time() if maintenant is None else maintenant):
        return "expire"
    return "ok"


# ----------------------------------------------------------------------------------------------
# Chemins et fichiers
# ----------------------------------------------------------------------------------------------

class Refus(Exception):
    def __init__(self, code, raison):
        self.code, self.raison = code, raison


def segments_surs(brut):
    """Découpe un chemin d'URL (encore encodé) en segments sûrs. Renvoie (segments, finit_par_slash).
    Refuse : NUL/contrôles, antislash, `..`, `.`, segments cachés (commençant par '.'), `//`, chemins trop longs."""
    if len(brut) > 1024:
        raise Refus(403, "chemin_trop_long")
    try:
        txt = unquote(brut, encoding="utf-8", errors="strict")  # un seul décodage
    except UnicodeDecodeError:
        raise Refus(403, "encodage_invalide")
    if any(ord(c) < 0x20 or ord(c) == 0x7F for c in txt) or "\\" in txt:
        raise Refus(403, "caractere_interdit")
    slash_final = txt.endswith("/")
    segs = txt.split("/")
    if slash_final and txt != "/":
        segs = segs[:-1]
    if txt in ("", "/"):
        raise Refus(404, "chemin_vide")
    if len(segs) > 16:
        raise Refus(403, "chemin_trop_profond")
    for s in segs:
        if s == "" or s.startswith(".") or len(s) > 255:
            raise Refus(403, "segment_interdit")
    return segs, slash_final


def _dans(parent, enfant):
    return enfant == parent or enfant.startswith(parent.rstrip(os.sep) + os.sep)


def ouvrir_fichier(racine, segs, portee_seg0=True, suivre_index=True):
    """Ouvre un fichier régulier sous `racine`. Refuse tout ce qui sort de la portée (dossier de
    l'artefact = 1er segment), y compris par lien symbolique, et revérifie APRÈS ouverture via
    /proc/self/fd (anti course entre le contrôle et l'ouverture).
    Renvoie (fd, stat, segments_finaux). Lève Refus."""
    racine_reelle = os.path.realpath(racine)
    segs = list(segs)
    for _ in range(2):
        chemin = os.path.join(racine_reelle, *segs)
        reel = os.path.realpath(chemin)
        if not _dans(racine_reelle, reel):
            raise Refus(403, "lien_hors_dossier")
        if portee_seg0:
            portee = os.path.realpath(os.path.join(racine_reelle, segs[0]))
            if not _dans(racine_reelle, portee) or not _dans(portee, reel):
                raise Refus(403, "lien_hors_dossier")
        else:
            portee = racine_reelle
        try:
            fd = os.open(chemin, os.O_RDONLY | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOCTTY)
        except FileNotFoundError:
            raise Refus(404, "introuvable")
        except NotADirectoryError:
            raise Refus(404, "introuvable")
        except OSError:
            raise Refus(404, "inaccessible")
        try:
            st = os.fstat(fd)
            try:
                reel_fd = os.readlink(f"/proc/self/fd/{fd}")
            except OSError:
                reel_fd = os.path.realpath(chemin)  # /proc indisponible : retombe sur realpath
            if not _dans(racine_reelle, reel_fd) or not _dans(portee, reel_fd):
                raise Refus(403, "lien_hors_dossier")
            if stat.S_ISDIR(st.st_mode):
                os.close(fd)
                fd = None
                if suivre_index and segs[-1] != "index.html":
                    segs = segs + ["index.html"]
                    continue
                raise Refus(404, "pas_de_listing")
            if not stat.S_ISREG(st.st_mode):
                raise Refus(404, "pas_un_fichier")
            return fd, st, segs
        except BaseException:
            if fd is not None:
                os.close(fd)
            raise
    raise Refus(404, "introuvable")


def type_mime(nom):
    ext = os.path.splitext(nom)[1].lower()
    return TYPES_MIME.get(ext), ext


# ----------------------------------------------------------------------------------------------
# Serveur
# ----------------------------------------------------------------------------------------------

class Serveur(ThreadingHTTPServer):
    """Un fil par connexion, au plus `max_connexions`. Au-delà, la boucle d'acceptation ATTEND une place (au plus
    `attente_place` s ; les suivantes patientent dans la file du noyau) au lieu de répondre 503 tout de suite, et
    pendant cette attente les connexions inactives cèdent leur place (voir Gestionnaire._attendre_requete).
    Avant (07/10) : 503 immédiat dès 48 puis 96 connexions ouvertes, inactives comprises (pages à plusieurs widgets,
    proxys qui gardent des connexions de réserve, pré-connexions des navigateurs)."""
    daemon_threads = True
    request_queue_size = 256
    allow_reuse_address = True

    def __init__(self, *a, max_connexions=96, attente_place=10.0, **k):
        super().__init__(*a, **k)
        self._max = max_connexions
        self._attente_place = attente_place
        self._sem = threading.BoundedSemaphore(max_connexions)
        self._actives = 0
        self._en_attente = 0
        self._verrou = threading.Lock()
        self.refus_503 = 0

    def place_faible(self):
        """Vrai quand plus de 3/4 des places sont prises : on ne garde plus les connexions persistantes."""
        return self._actives > self._max * 3 // 4 or self._en_attente > 0

    def manque_de_places(self):
        """Vrai quand une connexion attend une place : les connexions inactives doivent céder la leur."""
        return self._en_attente > 0

    def process_request(self, request, client_address):
        if not self._sem.acquire(blocking=False):
            with self._verrou:
                self._en_attente += 1
            try:
                obtenu = self._sem.acquire(timeout=self._attente_place)
            finally:
                with self._verrou:
                    self._en_attente -= 1
            if not obtenu:
                self.refus_503 += 1
                sys.stdout.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "route": "saturation",
                                             "statut": 503, "actives": self._actives}) + "\n")
                sys.stdout.flush()
                try:
                    request.sendall(b"HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nConnection: close\r\n"
                                    b"Retry-After: 1\r\n\r\n")
                except OSError:
                    pass
                self.shutdown_request(request)
                return
        with self._verrou:
            self._actives += 1
        try:
            super().process_request(request, client_address)
        except BaseException:
            # le fil n'a pas pu démarrer : rendre la place, sinon elle serait perdue pour toujours
            with self._verrou:
                self._actives -= 1
            self._sem.release()
            raise

    def process_request_thread(self, request, client_address):
        try:
            super().process_request_thread(request, client_address)
        finally:
            with self._verrou:
                self._actives -= 1
            self._sem.release()


class Gestionnaire(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "carnet-artefacts"
    sys_version = ""
    timeout = 15          # lecture d'une requête en cours (anti-Slowloris)
    attente_inactive = 5  # attente de la requête SUIVANTE sur une connexion persistante : courte, libère le fil et la place
    grace_premiere = 1.0  # sous pression, une connexion ouverte sans requête (pré-connexion) garde sa place 1 s au plus
    _servi = False
    cle = None
    pages_rendu = {}

    def version_string(self):
        return "carnet-artefacts"

    kit_v = "0"

    def _donnees_en_tampon(self):
        """Une requête suivante déjà lue dans le tampon (pipelining) ? Sans attendre."""
        try:
            self.connection.settimeout(0)
            return bool(self.rfile.peek(1))
        except (BlockingIOError, OSError, ValueError):
            return False
        finally:
            try:
                self.connection.settimeout(self.timeout)
            except OSError:
                pass

    def _attendre_requete(self, delai, grace):
        """Attend le début d'une requête au plus `delai` s. Renvoie False (fermer la connexion) à l'échéance, ou dès
        qu'une autre connexion attend une place et que la grâce est écoulée : une connexion inactive ne bloque personne."""
        if self._donnees_en_tampon():
            return True
        debut = time.monotonic()
        while True:
            ecoule = time.monotonic() - debut
            if ecoule >= delai:
                return False
            try:
                prets, _, _ = select.select([self.connection], [], [], min(0.1, delai - ecoule))
            except (OSError, ValueError):
                return False
            if prets:
                return True
            if self.server.manque_de_places() and time.monotonic() - debut >= grace:
                return False

    def handle_one_request(self):
        """Comme http.server, avec une attente courte entre deux requêtes d'une même connexion, fermeture des
        connexions persistantes quand la place vient à manquer (un navigateur ouvre jusqu'à 6 connexions par hôte),
        et cession immédiate de la place par une connexion inactive dès qu'une autre attend."""
        try:
            premiere = not self._servi
            if not self._attendre_requete(self.timeout if premiere else self.attente_inactive,
                                          self.grace_premiere if premiere else 0.0):
                self.close_connection = True
                return
            self.connection.settimeout(self.timeout)
            self.raw_requestline = self.rfile.readline(65537)
            if len(self.raw_requestline) > 65536:
                self.requestline = ""
                self.request_version = ""
                self.command = ""
                self.send_error(414)
                return
            if not self.raw_requestline:
                self.close_connection = True
                return
            if not self.parse_request():
                return
            methode = getattr(self, "do_" + self.command, None)
            if methode is None:
                self.send_error(501)
                return
            if self.server.place_faible():
                self.close_connection = True
            methode()
            self.wfile.flush()
            self._servi = True
        except (TimeoutError, OSError):
            self.close_connection = True

    # --- journal -------------------------------------------------------------------------------
    def log_message(self, *a):
        pass  # le journal JSONL est écrit par journaliser()

    def journaliser(self, statut, octets=0, raison=None, chemin=None, jeton=None):
        if self._route == "sante":
            return
        entetes = getattr(self, "headers", None)
        ip = ((entetes.get("X-Forwarded-For") if entetes else "") or "").split(",")[0].strip() or self.client_address[0]
        rec = {
            "t": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
            "m": self.command, "route": self._route, "statut": statut, "octets": octets,
            "ms": int((time.monotonic() - self._t0) * 1000), "ip": ip[:64],
        }
        if chemin:
            rec["chemin"] = chemin[:300]
        if jeton:
            m = TOKEN_RE.match(jeton)
            # jamais le jeton complet : expiration + 4 premiers caractères de la signature
            rec["jeton"] = (m.group(1) + "." + m.group(2)[:4] + "…") if m else "format_invalide"
        if raison:
            rec["raison"] = raison
        sys.stdout.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":")) + "\n")
        sys.stdout.flush()

    # --- réponses ------------------------------------------------------------------------------
    def _hote(self):
        entetes = getattr(self, "headers", None)
        return ((entetes.get("Host") if entetes else "") or "").strip().lower()

    def base_reponse(self):
        """Origine d'artefacts qui sert cette réponse (d'après Host), pour la CSP ; défaut ART_PUBLIC_BASE."""
        return CFG.get("hotes_art", {}).get(self._hote(), CFG["base"])

    def en_tetes_securite(self, artefact):
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "no-referrer")
        if artefact:
            self.send_header("Content-Security-Policy", csp_artefact(CFG, self.base_reponse()))
            self.send_header("Cache-Control", "private, no-store")

    def repondre(self, code, corps=b"", ctype="text/plain; charset=utf-8", artefact=False, extra=None, raison=None,
                 chemin=None, jeton=None, tete=None):
        if isinstance(corps, str):
            corps = corps.encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(corps)))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.en_tetes_securite(artefact)
        if not artefact:
            self.send_header("Cache-Control", "no-store")
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        if not (tete if tete is not None else self.command == "HEAD") and code not in (204, 304):
            self.wfile.write(corps)
        self.journaliser(code, len(corps), raison, chemin, jeton)

    def refus(self, r, artefact=True, chemin=None, jeton=None):
        textes = {
            403: "Accès refusé.\n", 404: "Introuvable.\n", 410: "Lien expiré : rouvre l'artefact depuis tes notes.\n",
            413: "Fichier trop volumineux.\n", 405: "Méthode non autorisée.\n",
        }
        self.repondre(r.code, textes.get(r.code, "Erreur.\n"), artefact=artefact, raison=r.raison, chemin=chemin, jeton=jeton)

    def send_error(self, code, message=None, explain=None):  # erreurs de protocole (requête mal formée…)
        self._route = getattr(self, "_route", "protocole")
        self._t0 = getattr(self, "_t0", time.monotonic())
        self.command = getattr(self, "command", None) or "-"
        self.close_connection = True
        self.request_version = "HTTP/1.1"  # sinon http.server répond sans ligne de statut (mode HTTP/0.9)
        try:
            self.repondre(code, "Requête invalide.\n", raison="protocole", extra={"Connection": "close"}, tete=False)
        except OSError:
            pass

    # --- routage -------------------------------------------------------------------------------
    def _dispatcher(self):
        self._t0 = time.monotonic()
        self._route = "autre"
        self._hote_inconnu = None
        brut = self.path.split("?", 1)[0].split("#", 1)[0]
        query = self.path.split("?", 1)[1] if "?" in self.path else ""
        try:
            if brut == "/sante":
                self._route = "sante"
                return self.repondre(200, "ok\n")
            if brut.startswith("/_art/"):
                self._route = "_art"
                return self.route_signer(brut[len("/_art/"):])
            if brut.startswith("/a/"):
                self._route = "a"
                return self.route_artefact(brut[len("/a/"):])
            if brut.startswith("/kit/"):
                self._route = "kit"
                return self.route_kit(brut[len("/kit/"):], query)
            if brut in ("/rendu/mermaid", "/rendu/vega-lite"):
                self._route = "rendu"
                return self.route_rendu(brut[len("/rendu/"):])
            self.repondre(404, "Introuvable.\n", raison="route_inconnue", chemin=brut)
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            self.close_connection = True
        except Exception as e:  # jamais de trace vers le client
            sys.stdout.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "erreur": type(e).__name__, "route": self._route}) + "\n")
            sys.stdout.flush()
            try:
                self.close_connection = True
                self.repondre(500, "Erreur interne.\n", extra={"Connection": "close"})
            except OSError:
                pass

    do_GET = _dispatcher
    do_HEAD = _dispatcher

    def do_OPTIONS(self):
        self._t0 = time.monotonic()
        self._route = "kit" if self.path.startswith("/kit/") else "autre"
        if self._route == "kit":
            return self.repondre(204, b"", extra={
                "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
                "Access-Control-Max-Age": "86400"})
        self.repondre(405, "Méthode non autorisée.\n", extra={"Allow": "GET, HEAD"}, raison="methode")

    def _methode_refusee(self):
        self._t0 = time.monotonic()
        self._route = "autre"
        self.close_connection = True  # on n'a pas lu le corps éventuel
        self.repondre(405, "Méthode non autorisée.\n", extra={"Allow": "GET, HEAD", "Connection": "close"}, raison="methode")

    do_POST = do_PUT = do_DELETE = do_PATCH = _methode_refusee

    # --- /_art/<chemin> : signature -----------------------------------------------------------
    def route_signer(self, brut):
        hote = self._hote()
        if CFG["refuser_signature_sur_hote_public"]:
            # /_art signe : jamais sur un domaine d'artefacts (public, sans porte), quel qu'il soit
            if hote == CFG["hote_public"] or hote in CFG.get("hotes_art", {}):
                return self.refus(Refus(404, "signature_sur_hote_public"), artefact=False)
        base = CFG.get("hotes_app", {}).get(hote)
        if base is None:
            base = CFG["base"]
            self._hote_inconnu = hote
        try:
            segs, _ = segments_surs(brut)
            fd, st, finaux = ouvrir_fichier(CFG["racine_art"], segs)
        except Refus as r:
            return self.refus(r, artefact=False, chemin=brut)
        os.close(fd)
        if st.st_size > CFG["taille_max"]:
            return self.refus(Refus(413, "trop_gros"), artefact=False, chemin="/".join(finaux))
        chemin = "/".join(finaux)
        jeton = signer(self.cle.valeur(), finaux[0], CFG["ttl"])
        cible = f"{base}/a/{jeton}/{quote(chemin, safe='/')}"
        self.repondre(302, "", artefact=False, extra={"Location": cible}, chemin=chemin, jeton=jeton,
                      raison=(f"hote_inconnu:{self._hote_inconnu[:100]}" if self._hote_inconnu is not None else None))

    # --- /a/<exp>.<hmac>/<chemin> : artefact --------------------------------------------------
    def route_artefact(self, reste):
        jeton, _, brut = reste.partition("/")
        if not TOKEN_RE.match(jeton):
            return self.refus(Refus(403, "jeton_invalide"), jeton=jeton)
        try:
            segs, slash_final = segments_surs(brut)
        except Refus as r:
            # 404 « chemin vide » : on ne distingue pas avant d'avoir vérifié le jeton
            return self.refus(Refus(403, r.raison), jeton=jeton)
        etat = verifier_jeton(self.cle.valeur(), jeton, segs[0])
        if etat == "invalide":
            return self.refus(Refus(403, "jeton_invalide"), jeton=jeton, chemin="/".join(segs))
        if etat == "expire":
            return self.refus(Refus(410, "jeton_expire"), jeton=jeton, chemin="/".join(segs))
        try:
            fd, st, finaux = ouvrir_fichier(CFG["racine_art"], segs)
        except Refus as r:
            return self.refus(r, jeton=jeton, chemin="/".join(segs))
        try:
            if finaux != segs and not slash_final and len(finaux) == len(segs) + 1:
                # dossier demandé sans « / » final : redirection, pour que les chemins relatifs fonctionnent
                os.close(fd)
                fd = None
                return self.repondre(302, "", artefact=True, extra={"Location": f"/a/{jeton}/{quote('/'.join(segs), safe='/')}/"},
                                     raison="slash_final", chemin="/".join(segs), jeton=jeton)
            if st.st_size > CFG["taille_max"]:
                os.close(fd)
                fd = None
                return self.refus(Refus(413, "trop_gros"), jeton=jeton, chemin="/".join(finaux))
            mime, ext = type_mime(finaux[-1])
            extra = {}
            if mime is None:
                mime = "application/octet-stream"
                extra["Content-Disposition"] = "attachment"
            fd = self.envoyer_fd(fd, st, mime, artefact=True, extra=extra, chemin="/".join(finaux), jeton=jeton)
        finally:
            if fd is not None:
                os.close(fd)

    def envoyer_fd(self, fd, st, mime, artefact, extra=None, chemin=None, jeton=None, code=200):
        """Envoie le fichier ouvert (fd est fermé ici, renvoie None)."""
        self.send_response(code)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(st.st_size))
        if self.close_connection:
            self.send_header("Connection", "close")
        self.en_tetes_securite(artefact)
        for k, v in (extra or {}).items():
            self.send_header(k, v)
        self.end_headers()
        envoyes = 0
        try:
            if self.command != "HEAD":
                restant = st.st_size
                with os.fdopen(fd, "rb", closefd=True) as f:
                    fd = None
                    while restant > 0:
                        bloc = f.read(min(65536, restant))
                        if not bloc:
                            break
                        self.wfile.write(bloc)
                        envoyes += len(bloc)
                        restant -= len(bloc)
                    if restant > 0:  # fichier tronqué pendant l'envoi : connexion incohérente, on la coupe
                        self.close_connection = True
            else:
                os.close(fd)
                fd = None
        finally:
            if fd is not None:
                os.close(fd)
        self.journaliser(code, envoyes, None, chemin, jeton)
        return None

    # --- /kit/<fichier> ------------------------------------------------------------------------
    def route_kit(self, brut, query):
        try:
            segs, slash_final = segments_surs(brut)
            if slash_final:
                raise Refus(404, "pas_de_listing")
            mime, ext = type_mime(segs[-1])
            if segs[0] == "licences":  # LICENSE / NOTICE des paquets (souvent sans extension)
                mime = mime if ext in KIT_EXTENSIONS else "text/plain; charset=utf-8"
            elif ext not in KIT_EXTENSIONS or mime is None:
                raise Refus(404, "extension")
            fd, st, finaux = ouvrir_fichier(CFG["racine_kit"], segs, portee_seg0=False, suivre_index=False)
        except Refus as r:
            return self.refus(r, artefact=False, chemin=brut)
        etag = 'W/"%x-%x"' % (st.st_size, st.st_mtime_ns)
        versionne = re.search(r"(^|&)v=[A-Za-z0-9._-]+", query) is not None
        extra = {
            "Access-Control-Allow-Origin": "*",
            "Cross-Origin-Resource-Policy": "cross-origin",
            "ETag": etag,
            # URL versionnée (?v=…, ajoutée par les pages de rendu) : cache d'un an ; sinon 1 jour + revalidation
            "Cache-Control": "public, max-age=31536000, immutable" if versionne else "public, max-age=86400, must-revalidate",
        }
        if self.headers.get("If-None-Match") == etag:
            os.close(fd)
            self.send_response(304)
            self.en_tetes_securite(False)
            for k, v in extra.items():
                self.send_header(k, v)
            self.end_headers()
            return self.journaliser(304, 0, None, "/".join(finaux))
        self.envoyer_fd(fd, st, mime, artefact=False, extra=extra, chemin="/".join(finaux))

    # --- /rendu/<type> -------------------------------------------------------------------------
    def route_rendu(self, nom):
        page = self.pages_rendu.get(nom)
        if page is None:
            return self.repondre(404, "Introuvable.\n", raison="rendu_absent")
        self.repondre(200, page, ctype="text/html; charset=utf-8", artefact=True, chemin=nom)


def charger_pages_rendu(cfg, kit_v):
    """Les pages de rendu chargent leurs bibliothèques depuis /kit/ (script-src l'autorise) avec ?v=<empreinte du kit>."""
    pages = {}
    for nom in ("mermaid", "vega-lite"):
        src = (cfg["dossier_rendu"] / f"{nom}.html").read_text(encoding="utf-8")
        pages[nom] = src.replace("{{KIT_V}}", kit_v).encode("utf-8")
    return pages


def empreinte_kit(racine_kit):
    manifeste = Path(racine_kit) / "kit.json"
    try:
        return hashlib.sha256(manifeste.read_bytes()).hexdigest()[:12]
    except OSError:
        return "0"


def main():
    global CFG
    CFG = lire_config()
    Gestionnaire.cle = Cle(CFG["fichier_cle"])
    Gestionnaire.kit_v = empreinte_kit(CFG["racine_kit"])
    Gestionnaire.pages_rendu = charger_pages_rendu(CFG, Gestionnaire.kit_v)
    srv = Serveur(CFG["ecoute"], Gestionnaire, max_connexions=CFG["max_connexions"], attente_place=CFG["attente_place"])
    sys.stdout.write(json.dumps({"t": time.strftime("%Y-%m-%dT%H:%M:%S%z"), "demarrage": "carnet-artefacts", "base": CFG["base"],
                                 "origines": CFG["origines"], "correspondances": [f"{a}={b}" for a, b in CFG["correspondances"]],
                                 "ttl": CFG["ttl"], "kit_v": Gestionnaire.kit_v,
                                 "max_connexions": CFG["max_connexions"]}) + "\n")
    sys.stdout.flush()
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
