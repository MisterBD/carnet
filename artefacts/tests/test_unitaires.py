"""Tests unitaires de app/art.py (import direct, sans réseau ni Docker)."""
import importlib.util
import os
import sys
import tempfile
import time
import unittest
from pathlib import Path

ICI = Path(__file__).resolve().parent
sys.path.insert(0, str(ICI))
import common  # noqa: E402

os.environ.setdefault("ART_PUBLIC_BASE", common.ART)
os.environ.setdefault("APP_ORIGINS", common.APP_ORIGINS)
spec = importlib.util.spec_from_file_location("art", ICI.parent / "app" / "art.py")
art = importlib.util.module_from_spec(spec)
spec.loader.exec_module(art)
art.CFG = art.lire_config()

CLE = bytes(range(32))


class TestJeton(unittest.TestCase):
    def test_aller_retour(self):
        j = art.signer(CLE, "dossier", 900, maintenant=1000)
        self.assertEqual(art.verifier_jeton(CLE, j, "dossier", maintenant=1500), "ok")

    def test_expire(self):
        j = art.signer(CLE, "dossier", 900, maintenant=1000)
        self.assertEqual(art.verifier_jeton(CLE, j, "dossier", maintenant=1901), "expire")
        self.assertEqual(art.verifier_jeton(CLE, j, "dossier", maintenant=1900), "ok")

    def test_portee_et_falsification(self):
        j = art.signer(CLE, "dossier", 900, maintenant=1000)
        self.assertEqual(art.verifier_jeton(CLE, j, "autre", maintenant=1001), "invalide")
        exp, m = j.split(".")
        self.assertEqual(art.verifier_jeton(CLE, f"{int(exp) + 3600}.{m}", "dossier", maintenant=1001), "invalide")
        self.assertEqual(art.verifier_jeton(CLE, exp + "." + ("A" if m[0] != "A" else "B") + m[1:], "dossier", maintenant=1001), "invalide")
        self.assertEqual(art.verifier_jeton(bytes(32), j, "dossier", maintenant=1001), "invalide")

    def test_formats_invalides(self):
        for j in ["", "x", "123", "123.", ".abc", "abc.def", "1." + "A" * 42, "1." + "A" * 44, "1." + "A" * 42 + "=", "-1." + "A" * 43,
                  "1234567890123." + "A" * 43]:
            self.assertEqual(art.verifier_jeton(CLE, j, "d", maintenant=1), "invalide", j)

    def test_format_du_contrat(self):
        # hmac = base64url(HMAC-SHA256(cle, exp + "/" + portée)), sans bourrage
        j = art.signer(CLE, "2026-10-07-x", 900, maintenant=1_800_000_000)
        exp, m = j.split(".")
        self.assertEqual(exp, "1800000900")
        self.assertEqual(len(m), 43)
        self.assertEqual(m, common.mac(1800000900, "2026-10-07-x", CLE))


class TestSegments(unittest.TestCase):
    def ok(self, brut, attendu, slash=False):
        self.assertEqual(art.segments_surs(brut), (attendu, slash))

    def refuse(self, brut):
        with self.assertRaises(art.Refus, msg=brut):
            art.segments_surs(brut)

    def test_valides(self):
        self.ok("dossier/index.html", ["dossier", "index.html"])
        self.ok("dossier/", ["dossier"], True)
        self.ok("2026-10-07-accents%20%C3%A9/image%20jointe.svg", ["2026-10-07-accents é", "image jointe.svg"])

    def test_traversees_et_caches(self):
        for brut in ["..", "../x", "a/../b", "a/..", "a/./b", "./a", "%2e%2e/x", "a/%2e%2e/b", "a%2f..%2fb", "a/%2E%2E/b",
                     ".git/config", "a/.secret", "a//b", "//a", "a\\b", "a%5cb", "a/%00", "a%00.html", "a/\n", "a/%0d%0a",
                     "%ff", "", "/", "/a", "a/" + "b/" * 17 + "c", "x" * 2000]:
            self.refuse(brut)

    def test_double_encodage_traite_comme_nom_litteral(self):
        # %252e%252e -> "%2e%2e" littéral (un seul décodage) : un nom de fichier, pas une traversée
        self.ok("%252e%252e/x", ["%2e%2e", "x"])


class TestFichiers(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        self.racine = Path(self._tmp.name) / "artefacts"
        (self.racine / "a1").mkdir(parents=True)
        (self.racine / "a2").mkdir()
        (self.racine / "a1" / "index.html").write_text("a1")
        (self.racine / "a2" / "secret.txt").write_text("a2")
        (self.racine / "a1" / "sous").mkdir()
        (self.racine / "a1" / "sous" / "f.txt").write_text("f")
        (Path(self._tmp.name) / "dehors.txt").write_text("dehors")

    def tearDown(self):
        self._tmp.cleanup()

    def lire(self, segs, **kw):
        fd, st, finaux = art.ouvrir_fichier(self.racine, segs, **kw)
        try:
            return os.read(fd, 100).decode(), finaux
        finally:
            os.close(fd)

    def test_lecture_et_index(self):
        self.assertEqual(self.lire(["a1", "index.html"]), ("a1", ["a1", "index.html"]))
        self.assertEqual(self.lire(["a1"]), ("a1", ["a1", "index.html"]))

    def test_pas_de_listing(self):
        with self.assertRaises(art.Refus) as c:
            self.lire(["a1", "sous"])
        self.assertEqual(c.exception.code, 404)   # dossier sans index.html : 404, jamais de listing

    def test_liens_symboliques(self):
        os.symlink("../../dehors.txt", self.racine / "a1" / "sortie.txt")
        os.symlink(str(Path(self._tmp.name)), self.racine / "a1" / "dir-sortie")
        os.symlink("../a2/secret.txt", self.racine / "a1" / "autre-artefact.txt")
        os.symlink("sous/f.txt", self.racine / "a1" / "interne.txt")
        os.symlink("a2", self.racine / "alias")           # alias de dossier dans la racine : sa portée est sa cible
        os.symlink("boucle", self.racine / "a1" / "boucle")
        for segs in (["a1", "sortie.txt"], ["a1", "dir-sortie", "dehors.txt"], ["a1", "autre-artefact.txt"]):
            with self.assertRaises(art.Refus, msg=segs) as c:
                self.lire(segs)
            self.assertEqual(c.exception.raison, "lien_hors_dossier")
        self.assertEqual(self.lire(["a1", "interne.txt"])[0], "f")
        self.assertEqual(self.lire(["alias", "secret.txt"])[0], "a2")
        with self.assertRaises(art.Refus):
            self.lire(["a1", "boucle"])

    def test_non_regulier(self):
        os.mkfifo(self.racine / "a1" / "fifo")
        with self.assertRaises(art.Refus):
            self.lire(["a1", "fifo"])


class TestSaturation(unittest.TestCase):
    """Serveur réel (fils + sémaphore) avec 4 places. Depuis le 08/10 : au-delà, la connexion ATTEND une place (au lieu
    d'un 503 immédiat), les connexions inactives cèdent la leur, et le 503 ne tombe qu'après l'attente maximale."""

    def demarrer(self, tmp, attente_place=10.0):
        import threading
        (tmp / "cle").write_text("00" * 32)
        (tmp / "art").mkdir()
        (tmp / "kit").mkdir()
        self.ancien = {k: art.CFG[k] for k in ("racine_art", "racine_kit")}
        art.CFG["racine_art"], art.CFG["racine_kit"] = tmp / "art", tmp / "kit"
        art.Gestionnaire.cle = art.Cle(tmp / "cle")
        srv = art.Serveur(("127.0.0.1", 0), art.Gestionnaire, max_connexions=4, attente_place=attente_place)
        threading.Thread(target=srv.serve_forever, daemon=True).start()
        self.addCleanup(lambda: (srv.shutdown(), srv.server_close(), art.CFG.update(self.ancien)))
        return srv, srv.server_address[1]

    def sante(self, port, timeout=15):
        import http.client
        t0 = time.monotonic()
        cx = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        try:
            cx.request("GET", "/sante")
            return cx.getresponse().status, time.monotonic() - t0
        finally:
            cx.close()

    def test_preconnexions_inactives_cedent_leur_place(self):
        import socket
        with tempfile.TemporaryDirectory() as tmp:
            srv, port = self.demarrer(Path(tmp))
            socks = [socket.create_connection(("127.0.0.1", port), timeout=5) for _ in range(4)]   # toutes les places
            self.addCleanup(lambda: [s.close() for s in socks])
            time.sleep(0.3)
            statut, duree = self.sante(port)
            self.assertEqual(statut, 200)                   # avant : 503 immédiat
            self.assertLess(duree, 3.0)                      # grâce d'1 s pour une pré-connexion, puis place cédée
            self.assertEqual(srv.refus_503, 0)

    def test_keep_alive_inactif_cede_sa_place_tout_de_suite(self):
        import http.client
        with tempfile.TemporaryDirectory() as tmp:
            srv, port = self.demarrer(Path(tmp))
            cxs = []
            for _ in range(4):                               # 4 connexions qui ont servi puis restent ouvertes
                cx = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
                cx.request("GET", "/sante")
                cx.getresponse().read()
                cxs.append(cx)
            self.addCleanup(lambda: [cx.close() for cx in cxs])
            statut, duree = self.sante(port)
            self.assertEqual(statut, 200)
            self.assertLess(duree, 1.5)

    def test_refus_net_seulement_apres_l_attente_puis_reprise(self):
        import socket
        with tempfile.TemporaryDirectory() as tmp:
            srv, port = self.demarrer(Path(tmp), attente_place=0.6)
            socks = []
            for _ in range(4):                               # 4 requêtes EN COURS (ligne commencée) : places occupées
                s = socket.create_connection(("127.0.0.1", port), timeout=5)
                s.sendall(b"GET /sante HT")
                socks.append(s)
            time.sleep(0.3)
            statut, duree = self.sante(port)
            self.assertEqual(statut, 503)
            self.assertGreaterEqual(duree, 0.5)              # a attendu une place avant de refuser
            self.assertEqual(srv.refus_503, 1)
            for s in socks:
                s.close()
            time.sleep(0.3)
            self.assertEqual(self.sante(port)[0], 200)       # reprise

    def test_rafale_de_200_connexions_sans_503(self):
        import socket
        import threading
        with tempfile.TemporaryDirectory() as tmp:
            srv, port = self.demarrer(Path(tmp))
            res, verrou, gardees = {}, threading.Lock(), []

            def client():
                try:
                    s = socket.create_connection(("127.0.0.1", port), timeout=20)
                    s.sendall(b"GET /sante HTTP/1.1\r\nHost: x\r\n\r\n")
                    d = s.recv(64)
                    st = d.split(b" ")[1].decode() if d else "vide"
                    with verrou:
                        res[st] = res.get(st, 0) + 1
                        gardees.append(s)                    # la connexion reste ouverte (keep-alive)
                except OSError as e:
                    with verrou:
                        res[type(e).__name__] = res.get(type(e).__name__, 0) + 1

            fils = [threading.Thread(target=client) for _ in range(200)]
            [f.start() for f in fils]
            [f.join(30) for f in fils]
            for s in gardees:
                s.close()
            self.assertEqual(res, {"200": 200})


class TestOrigines(unittest.TestCase):
    """Table « origine appli = base artefacts » (ART_ORIGINES) : local, Tailscale, prod sur la même instance."""

    def config(self, **env):
        sauve = {k: os.environ.get(k) for k in ("ART_PUBLIC_BASE", "APP_ORIGINS", "ART_ORIGINES")}
        try:
            os.environ.update(env)
            for k in ("ART_ORIGINES",):
                if k not in env:
                    os.environ.pop(k, None)
            return art.lire_config()
        finally:
            for k, v in sauve.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v

    def test_hotes_equivalents(self):
        self.assertEqual(art.hotes_equivalents("https://carnet.exemple.org"), {"carnet.exemple.org", "carnet.exemple.org:443"})
        self.assertEqual(art.hotes_equivalents("https://carnet.exemple.ts.net"), {"carnet.exemple.ts.net", "carnet.exemple.ts.net:443"})
        self.assertEqual(art.hotes_equivalents("http://127.0.0.1:3020"), {"127.0.0.1:3020"})
        self.assertEqual(art.hotes_equivalents("http://X.test:80"), {"x.test:80", "x.test"})

    def test_table_complete(self):
        cfg = self.config(ART_PUBLIC_BASE="http://127.0.0.1:3006",
                          APP_ORIGINS="http://127.0.0.1:3020",
                          ART_ORIGINES="http://127.0.0.1:3020=http://127.0.0.1:3006 "
                                       "https://carnet.exemple.ts.net=https://carnet.exemple.ts.net:8443 "
                                       "https://carnet.exemple.org=https://art.exemple.org")
        self.assertEqual(cfg["origines"], ["http://127.0.0.1:3020", "https://carnet.exemple.ts.net", "https://carnet.exemple.org"])
        self.assertEqual(cfg["hotes_app"]["carnet.exemple.ts.net"], "https://carnet.exemple.ts.net:8443")
        self.assertEqual(cfg["hotes_app"]["carnet.exemple.org"], "https://art.exemple.org")
        self.assertEqual(cfg["hotes_app"]["127.0.0.1:3020"], "http://127.0.0.1:3006")
        self.assertEqual(cfg["hotes_art"]["art.exemple.org"], "https://art.exemple.org")
        self.assertIn("frame-ancestors http://127.0.0.1:3020 https://carnet.exemple.ts.net https://carnet.exemple.org;",
                      art.csp_artefact(cfg, "https://art.exemple.org"))
        self.assertIn("script-src 'self' 'unsafe-inline' https://art.exemple.org/kit/;", art.csp_artefact(cfg, "https://art.exemple.org"))

    def test_sans_table_comportement_d_avant(self):
        cfg = self.config(ART_PUBLIC_BASE="http://127.0.0.1:3006", APP_ORIGINS="http://127.0.0.1:3020 http://127.0.0.1:3021")
        self.assertEqual(cfg["hotes_app"], {"127.0.0.1:3020": "http://127.0.0.1:3006", "127.0.0.1:3021": "http://127.0.0.1:3006"})
        self.assertEqual(art.csp_artefact(cfg), art.csp_artefact(cfg, "http://127.0.0.1:3006"))

    def test_table_refuse_les_injections_et_les_confusions(self):
        for table in ["http://a.test", "http://a.test=", "http://a.test=http://b.test/x", "http://a.test;x=http://b.test",
                      "javascript:x=http://b.test", "http://a.test=http://a.test"]:
            with self.assertRaises(SystemExit, msg=table):
                self.config(ART_PUBLIC_BASE="http://127.0.0.1:3006", APP_ORIGINS="http://127.0.0.1:3020", ART_ORIGINES=table)
        with self.assertRaises(SystemExit):        # l'origine appli ne peut pas être aussi une base d'artefacts
            self.config(ART_PUBLIC_BASE="http://127.0.0.1:3020", APP_ORIGINS="http://127.0.0.1:3020")


class TestCSP(unittest.TestCase):
    def test_csp_identique_au_contrat(self):
        self.assertEqual(art.csp_artefact(art.CFG), common.csp_attendue())

    def test_config_refuse_les_injections(self):
        for base in ["http://x.test/chemin", "http://x.test;evil", "javascript:alert(1)", "http://x y", "http://x.test'"]:
            os.environ["ART_PUBLIC_BASE"] = base
            with self.assertRaises(SystemExit, msg=base):
                art.lire_config()
        os.environ["ART_PUBLIC_BASE"] = common.ART
        os.environ["APP_ORIGINS"] = "http://ok.test; script-src *"
        with self.assertRaises(SystemExit):
            art.lire_config()
        os.environ["APP_ORIGINS"] = common.APP_ORIGINS


if __name__ == "__main__":
    unittest.main()
