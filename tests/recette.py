#!/usr/bin/env python3
"""Recette de Carnet (Playwright) sur un service réel (défaut http://127.0.0.1:3020), en Chromium ET WebKit.

    python3 tests/recette.py --navigateur chromium [--base http://127.0.0.1:3020] [--espace ./demo] [--captures captures]
    # WebKit (moteur de Safari) sans sudo : dans le conteneur officiel Playwright, voir tests/recette-webkit.sh

Le Carnet visé tourne sur le dossier --espace avec, dans CARNET_UTILISATEURS_AUTORISES, l'identité --login (posée
par la recette dans l'en-tête --entete-identite). Derrière un proxy authentifiant (--proxy-identite), c'est le proxy
qui pose l'identité.

Parcours fonctionnel (iPhone 390×844 ×3, clair) : arbre, page, « / » -> Sous-page (fichier créé vérifié sur disque),
écriture, case à cocher, image, aperçus Mermaid / Vega-Lite, artefact plein écran, écriture externe (mise à jour en
direct), conflit, recherche, pages ouvertes sans modification = fichiers intacts. Captures : iPhone et bureau
(1440×900), clair et sombre. Contrôles : console sans erreur, aucune requête hors de l'appli et du serveur d'artefacts.
Les pages de test vivent dans « Recette/ » de l'espace et sont retirées à la fin.
"""
import argparse, hashlib, json, os, re, shutil, sys, time, base64
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

ICI = Path(__file__).resolve().parent
ap = argparse.ArgumentParser()
ap.add_argument("--navigateur", default="chromium", choices=["chromium", "webkit", "firefox"])
ap.add_argument("--base", default="http://127.0.0.1:3020", help="origine de l'appli")
ap.add_argument("--art", "--art-base", dest="art", default="http://127.0.0.1:3006", help="origine du serveur d'artefacts")
ap.add_argument("--origines-ok", default="", help="autres origines autorisées pour les requêtes (séparées par des espaces)")
ap.add_argument("--proxy-identite", action="store_true",
                help="l'identité est posée par un proxy authentifiant devant --base (la recette n'envoie aucun en-tête)")
ap.add_argument("--login", default="ami@exemple.test", help="identité envoyée (doit figurer dans CARNET_UTILISATEURS_AUTORISES)")
ap.add_argument("--nom", default="Camille Martin", help="nom affichable envoyé avec l'identité")
ap.add_argument("--entete-identite", default="Tailscale-User-Login", help="en-tête d'identité (CARNET_ENTETE_IDENTITE)")
ap.add_argument("--entete-nom", default="Tailscale-User-Name", help="en-tête du nom (CARNET_ENTETE_NOM)")
ap.add_argument("--espace", default=str(ICI.parent / "demo"), help="dossier de pages servi par le Carnet visé")
ap.add_argument("--page-riche", default="", help="page avec un schéma (## Schéma) et un graphique (## Graphique)")
ap.add_argument("--page-artefact", default="", help="page qui contient une carte d'artefact")
ap.add_argument("--captures", default=str(ICI.parent / "captures"))
ap.add_argument("--resultats", default=None)
ap.add_argument("--sans-captures-themes", action="store_true")
args = ap.parse_args()

BASE = args.base.rstrip("/")
PROXY = args.proxy_identite
ESPACE = Path(args.espace)
CAP = Path(args.captures)
CAP.mkdir(parents=True, exist_ok=True)
NAV = args.navigateur
IDENTITE = {args.entete_identite: args.login, args.entete_nom: args.nom}
ART = args.art.rstrip("/")
HOTES_OK = (BASE, ART, *[o.rstrip("/") for o in args.origines_ok.split()], "data:", "blob:", "about:")


def page_existante(*candidats):
    """Premier chemin de page (sans .md) présent dans l'espace."""
    for c in candidats:
        if c and (ESPACE / (c + ".md")).is_file():
            return c
    return candidats[-1]


def url_page(chemin):
    from urllib.parse import quote
    return "/p/" + quote(chemin)


PAGE_RICHE = page_existante(args.page_riche, "Démo/Page riche", "Visite guidée/Schémas et graphiques")
PAGE_ARTEFACT = page_existante(args.page_artefact, "Démo/Tableau de bord T3", "Visite guidée/Artefacts HTML")
IPHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
              user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 18_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.6 Mobile/15E148 Safari/604.1")
BUREAU = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
if NAV == "firefox":
    IPHONE.pop("is_mobile")

resultats = []
erreurs_console = []
requetes_externes = []


def etape(nom, ok, detail=""):
    resultats.append({"etape": nom, "ok": bool(ok), "detail": str(detail)[:400]})
    print(("OK   " if ok else "ÉCHEC") + f" {nom}" + (f" : {detail}" if detail else ""), flush=True)


def capture(page, nom, plein=False):
    page.screenshot(path=str(CAP / f"{NAV}-{nom}.png"), full_page=plein)


def empreintes():
    res = {}
    for p in ESPACE.rglob("*.md"):
        rel = p.relative_to(ESPACE)
        if rel.parts[0] in ("Recette", ".git", ".corbeille") or rel.name == "Recette.md":
            continue
        try:
            res[str(rel)] = hashlib.sha256(p.read_bytes()).hexdigest()
        except OSError:
            pass
    return res


def ecrire_atomique(chemin: Path, texte: str):
    tmp = chemin.parent / f".{chemin.name}.recette.tmp"
    tmp.write_text(texte, encoding="utf-8")
    os.replace(tmp, chemin)


def attendre_fichier(chemin: Path, condition, delai=8.0):
    t0 = time.time()
    while time.time() - t0 < delai:
        if chemin.exists():
            try:
                t = chemin.read_text(encoding="utf-8")
                if condition(t):
                    return t
            except OSError:
                pass
        time.sleep(0.15)
    return chemin.read_text(encoding="utf-8") if chemin.exists() else None


def preparer():
    nettoyer()
    (ESPACE / "Recette").mkdir(exist_ok=True)
    ecrire_atomique(ESPACE / "Recette.md", "# Recette\n\n")
    ecrire_atomique(ESPACE / "Recette" / "Tâches.md",
                    "---\nstatut: en cours\n---\n# Tâches de recette\n\nUne liste écrite par un agent :\n\n- [ ] Acheter du pain\n- [ ] Appeler Lou\n\nFin de la page, mot témoin zéphyrin.\n")
    ecrire_atomique(ESPACE / "Recette" / "Images.md", "# Images\n\n")
    ecrire_atomique(ESPACE / "Recette" / "Projet témoin.md",
                    "---\ntags: [projet]\nstatut: à faire\necheance: 2026-12-01\nresponsable: Camille\n---\n# Projet témoin\n\nVoir [[Recette/À ranger]].\n")
    ecrire_atomique(ESPACE / "Recette" / "À ranger.md", "# À ranger\n\nPage à déplacer, renommer puis supprimer.\n")


def api_favoris_sans_recette():
    """Retire des favoris les pages de recette (l'état des favoris vit hors de l'espace)."""
    import urllib.request
    entetes = {"Content-Type": "application/json", "X-Carnet": "1"}
    if not PROXY:
        entetes.update(IDENTITE)
    try:
        with urllib.request.urlopen(urllib.request.Request(BASE + "/api/favoris", headers=entetes), timeout=5) as r:
            chemins = json.loads(r.read())["chemins"]
        garder = [c for c in chemins if not c.startswith("Recette")]
        if garder != chemins:
            req = urllib.request.Request(BASE + "/api/favoris", data=json.dumps({"chemins": garder}).encode(), headers=entetes, method="PUT")
            urllib.request.urlopen(req, timeout=5).read()
    except Exception as e:  # noqa
        print("favoris : nettoyage impossible :", e)


def nettoyer():
    api_favoris_sans_recette()
    cible = ESPACE / "Recette"
    if cible.is_dir() and cible.name == "Recette":
        shutil.rmtree(cible)
    f = ESPACE / "Recette.md"
    if f.exists():
        f.unlink()


def nouveau_contexte(nav, gabarit, sombre=False):
    if PROXY:
        # Derrière le proxy authentifiant : c'est lui qui pose l'identité, comme sur le téléphone de la personne.
        return nav.new_context(**gabarit, color_scheme="dark" if sombre else "light", locale="fr-FR")
    # En local : on pose nous-mêmes l'en-tête d'identité. Les service workers sont bloqués (leurs requêtes ne
    # porteraient pas l'en-tête). Effet de bord connu : l'en-tête part aussi vers le serveur d'artefacts, dont les
    # polices du kit (requêtes CORS depuis un cadre sandbox) refusent alors le pré-vol : erreur filtrée ci-dessous.
    return nav.new_context(**gabarit, color_scheme="dark" if sombre else "light", locale="fr-FR",
                           extra_http_headers=IDENTITE, service_workers="block")


journal_app = []


def surveiller(page, etiquette):
    page.add_init_script("try { localStorage.setItem('carnet:debug', '1'); } catch (e) {}")
    def console(m):
        if m.text.startswith("[carnet]"):
            journal_app.append(f"{time.strftime('%H:%M:%S')} [{etiquette}] {m.text}")
        if m.type == "error":
            erreurs_console.append(f"[{etiquette}] {m.text}")
    page.on("console", console)
    page.on("pageerror", lambda e: erreurs_console.append(f"[{etiquette}] pageerror {e}"))

    def requete(r):
        if not r.url.startswith(HOTES_OK):
            requetes_externes.append(f"[{etiquette}] {r.method} {r.url}")
    page.on("request", requete)


def ouvrir(page, chemin="/", attendre_editeur=False):
    page.goto(BASE + chemin)
    if attendre_editeur:
        page.wait_for_selector(".editeur .ProseMirror", timeout=15000)
        page.wait_for_timeout(500)
    else:
        page.wait_for_timeout(700)


def editeur_fin(page):
    """Place le curseur à la fin du dernier bloc de texte de l'éditeur."""
    page.evaluate("""() => {
      const pm = document.querySelector('.editeur .ProseMirror');
      pm.focus();
      const blocs = pm.querySelectorAll(':scope > p, :scope > h1, :scope > h2, :scope > h3');
      const dernier = blocs[blocs.length - 1] || pm;
      const r = document.createRange();
      r.selectNodeContents(dernier); r.collapse(false);
      const s = getSelection(); s.removeAllRanges(); s.addRange(r);
    }""")
    page.wait_for_timeout(150)


# ------------------------------------------------------------------------------------------------
def parcours_fonctionnel(nav):
    ctx = nouveau_contexte(nav, IPHONE)
    page = ctx.new_page()
    surveiller(page, "iphone")

    # 1. Arbre (tiroir) puis ouverture d'une page
    ouvrir(page, "/")
    page.click(".entete__menu")
    page.wait_for_timeout(400)
    tiroir = page.locator(".barre[data-ouverte=true]")
    etape("arbre : le tiroir s'ouvre", tiroir.count() == 1)
    capture(page, "iphone-clair-parcours-arbre")
    lien = page.locator(".barre .rangee__lien", has_text="Recette").first
    lien.click()
    page.wait_for_selector(".editeur .ProseMirror", timeout=15000)
    page.wait_for_timeout(400)
    etape("arbre : la page s'ouvre et le tiroir se ferme", "/p/Recette" in page.url and page.locator(".barre[data-ouverte=true]").count() == 0, page.url)

    # 2. « / » -> Sous-page
    editeur_fin(page)
    page.keyboard.press("Enter")
    page.keyboard.type("/")
    page.wait_for_timeout(500)
    menu = page.locator(".carnet-menu-slash")
    visible = menu.count() > 0 and menu.first.is_visible()
    libelles = [t.strip() for t in page.locator(".carnet-menu-slash .carnet-menu__libelle").all_inner_texts() if t.strip()] if visible else []
    etape("menu « / » en français avec Sous-page en tête", visible and libelles[:1] == ["Sous-page"] and "Tâche" in libelles and "Schéma" in libelles, ", ".join(libelles[:14]))
    capture(page, "iphone-clair-menu-slash")
    page.keyboard.type("sous")
    page.wait_for_timeout(250)
    page.keyboard.press("Enter")
    page.wait_for_selector(".dialogue input.champ", timeout=5000)
    capture(page, "iphone-clair-dialogue-sous-page")
    page.keyboard.type("Ma sous-page de recette")
    page.keyboard.press("Enter")
    page.wait_for_url(re.compile(r".*/p/Recette/Ma%20sous-page%20de%20recette$"), timeout=8000)
    page.wait_for_selector(".editeur .ProseMirror", timeout=15000)
    page.wait_for_timeout(500)
    enfant = ESPACE / "Recette" / "Ma sous-page de recette.md"
    etape("Sous-page : fichier créé sur disque", enfant.exists(), enfant)
    parent = attendre_fichier(ESPACE / "Recette.md", lambda t: "[[Recette/Ma sous-page de recette]]" in t)
    etape("Sous-page : lien [[…]] écrit dans la page parente", parent and "[[Recette/Ma sous-page de recette]]" in parent, repr(parent))
    etape("Sous-page : visible dans l'arbre", page.locator(".barre .rangee__titre", has_text="Ma sous-page de recette").count() >= 1)

    # 3. Écrire dans la sous-page (enregistrement automatique)
    editeur_fin(page)
    page.keyboard.type("Première ligne écrite depuis l'iPhone.")
    contenu = attendre_fichier(enfant, lambda t: "Première ligne écrite depuis l'iPhone." in t)
    etape("écriture : enregistrée automatiquement", contenu and contenu.startswith("# Ma sous-page de recette\n") and "Première ligne écrite depuis l'iPhone." in contenu, repr(contenu))
    capture(page, "iphone-clair-sous-page-ecrite")

    # 4. Case à cocher
    ouvrir(page, "/p/Recette/T%C3%A2ches", attendre_editeur=True)
    avant = (ESPACE / "Recette" / "Tâches.md").read_text(encoding="utf-8")
    case = page.locator(".editeur .carnet-tache__bouton").first
    case.click()
    apres = attendre_fichier(ESPACE / "Recette" / "Tâches.md", lambda t: "- [x] Acheter du pain" in t)
    attendu = avant.replace("- [ ] Acheter du pain", "- [x] Acheter du pain")
    etape("case à cocher : seule la ligne change", apres == attendu, repr(apres))

    # 5. Mise à jour en direct (écriture externe, page sans modification locale)
    f = ESPACE / "Recette" / "Tâches.md"
    ecrire_atomique(f, f.read_text(encoding="utf-8") + "\nLigne ajoutée par un agent pendant que la page est ouverte.\n")
    try:
        page.wait_for_selector("text=Ligne ajoutée par un agent", timeout=8000)
        etape("mise à jour en direct après écriture externe", True)
    except Exception as e:  # noqa
        etape("mise à jour en direct après écriture externe", False, f"bandeau={page.locator('.bandeau').count()} état={page.locator('.vague-etat').get_attribute('data-etat') if page.locator('.vague-etat').count() else '-'} journal={journal_app[-12:]}")
    capture(page, "iphone-clair-mise-a-jour-directe")

    # 6. Conflit : la personne écrit, un agent écrit en même temps
    editeur_fin(page)
    page.keyboard.type(" Phrase de Camille")
    ecrire_atomique(f, f.read_text(encoding="utf-8") + "\nAutre ajout simultané de l'agent.\n")
    try:
        page.wait_for_selector(".bandeau", timeout=6000)
        etape("conflit : bandeau « modifiée ailleurs » affiché", True)
        capture(page, "iphone-clair-conflit")
        page.click(".bandeau button:has-text('Garder la mienne')")
        t = attendre_fichier(f, lambda t: "Phrase de Camille" in t)
        etape("conflit : « Garder la mienne » enregistre la version de la personne", t and "Phrase de Camille" in t, repr(t)[-200:])
    except Exception as e:  # noqa
        t = f.read_text(encoding="utf-8")
        etape("conflit : bandeau « modifiée ailleurs » affiché", False, f"{e} ; fichier : {t[-200:]!r}")

    # 7. Image
    ouvrir(page, "/p/Recette/Images", attendre_editeur=True)
    editeur_fin(page)
    page.keyboard.type("/image")
    page.wait_for_timeout(300)
    png = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAEAAAAAgCAYAAACinX6EAAAAQklEQVR42u3OMQEAAAgDoK1/aI3h4QEJKC3pYmFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWFhYWHhxQPU5gHBXyM4FQAAAABJRU5ErkJggg==")
    fichier_png = Path("/tmp") / f"recette-{NAV}.png"
    fichier_png.write_bytes(png)
    try:
        with page.expect_file_chooser(timeout=5000) as fc:
            page.keyboard.press("Enter")
        fc.value.set_files(str(fichier_png))
        md = attendre_fichier(ESPACE / "Recette" / "Images.md", lambda t: "_assets/" in t)
        assets = list((ESPACE / "Recette" / "_assets").glob("*.png")) if (ESPACE / "Recette" / "_assets").exists() else []
        charge = False
        for _ in range(25):
            charge = page.evaluate("() => [...document.querySelectorAll('.editeur .carnet-image img')].some(i => i.complete && i.naturalWidth > 0)")
            if charge:
                break
            page.wait_for_timeout(200)
        etape("image : envoyée, rangée dans _assets/ et affichée", md and "](_assets/" in md and len(assets) == 1 and charge, f"{md!r} {assets} affichée={charge}")
    except Exception as e:  # noqa
        etape("image : envoyée, rangée dans _assets/ et affichée", False, e)
    capture(page, "iphone-clair-image")

    # 8. Aperçus Mermaid et Vega-Lite (rendus par le serveur d'artefacts dans des cadres isolés)
    ouvrir(page, url_page(PAGE_RICHE), attendre_editeur=True)
    for type_, titre in (("mermaid", "Schéma"), ("vega-lite", "Graphique")):
        h = page.locator(".editeur h2", has_text=titre).first
        h.scroll_into_view_if_needed()
        page.wait_for_timeout(300)
        cadre = page.locator(f".carnet-apercu[data-type='{type_}'] iframe").first
        try:
            cadre.wait_for(timeout=8000)
            t0 = time.time()
            hauteur = 0
            while time.time() - t0 < 10:
                hauteur = page.evaluate(f"() => {{ const f = document.querySelector(\".carnet-apercu[data-type='{type_}'] iframe\"); return f ? f.getBoundingClientRect().height : 0; }}")
                if hauteur > 90:
                    break
                page.wait_for_timeout(200)
            erreur = page.locator(f".carnet-apercu[data-type='{type_}'] .carnet-apercu__erreur:visible").count()
            etape(f"aperçu {type_} rendu (cadre isolé, hauteur {round(hauteur)} px)", hauteur > 90 and erreur == 0)
        except Exception as e:  # noqa
            etape(f"aperçu {type_} rendu", False, e)
        capture(page, f"iphone-clair-apercu-{type_}")

    # 9. Artefact : carte puis plein écran
    ouvrir(page, url_page(PAGE_ARTEFACT), attendre_editeur=True)
    carte = page.locator(".carnet-artefact").first
    try:
        carte.scroll_into_view_if_needed()
        page.wait_for_selector(".carnet-artefact iframe", timeout=8000)
        page.wait_for_timeout(2500)
        etape("artefact : carte avec aperçu", True)
        capture(page, "iphone-clair-artefact-carte")
        page.click(".carnet-artefact__bouton:has-text('Plein écran')")
        page.wait_for_selector(".plein-ecran iframe", timeout=5000)
        page.wait_for_timeout(2500)
        urls = [fr.url for fr in page.frames]
        signe = any(re.match(re.escape(ART) + r"/a/\d+\.[A-Za-z0-9_-]{43}/", u) for u in urls)
        etape("artefact : plein écran via lien signé du serveur d'artefacts", signe, " ".join(u for u in urls if u.startswith(ART))[:300])
        capture(page, "iphone-clair-artefact-plein-ecran")
        page.click(".plein-ecran button[aria-label='Fermer le plein écran']")
    except Exception as e:  # noqa
        etape("artefact : carte et plein écran", False, e)

    # 10. Recherche
    ouvrir(page, "/")
    page.click(".accueil__actions .bouton:not(.bouton--primaire)")
    page.wait_for_selector(".recherche__champ input")
    page.keyboard.type("zephyrin")
    try:
        page.wait_for_selector(".resultat:has-text('Tâches de recette')", timeout=4000)
        capture(page, "iphone-clair-recherche")
        page.keyboard.press("Enter")
        page.wait_for_url(re.compile(r".*/p/Recette/T%C3%A2ches$"), timeout=5000)
        etape("recherche sans accents (« zephyrin » trouve « zéphyrin ») puis ouverture", True)
    except Exception as e:  # noqa
        etape("recherche sans accents puis ouverture", False, e)

    # 11. Accueil : tâches ouvertes et « À relire »
    ouvrir(page, "/")
    page.wait_for_timeout(800)
    etape("accueil : tâche d'une autre page listée", page.locator(".tache__libelle", has_text="Appeler Lou").count() >= 1)
    capture(page, "iphone-clair-accueil")
    ctx.close()


def parcours_bureau(nav):
    """Bureau 1440×900 : arbre (glisser-déposer, menu « … » : renommer, supprimer), favoris, icône, vue Projets."""
    ctx = nouveau_contexte(nav, BUREAU)
    page = ctx.new_page()
    surveiller(page, "bureau")
    R = ESPACE / "Recette"

    # Icône emoji : seule une ligne « icon: » s'ajoute au frontmatter
    ouvrir(page, "/p/Recette/Projet%20t%C3%A9moin", attendre_editeur=True)
    avant = (R / "Projet témoin.md").read_text(encoding="utf-8")
    page.click(".tete-page__ajout-icone")
    page.click(".grille-emoji button[aria-label='Choisir 🌊']")
    apres = attendre_fichier(R / "Projet témoin.md", lambda t: "icon:" in t)
    etape("icône : une seule ligne ajoutée au frontmatter", apres == avant.replace("responsable: Camille\n", "responsable: Camille\nicon: 🌊\n"), repr(apres))

    # Favori
    page.click("button[aria-label='Ajouter aux favoris']")
    page.wait_for_timeout(500)
    etape("favori : la page apparaît dans « Favoris »", page.locator(".section-barre", has_text="Favoris").locator(".rangee__titre", has_text="Projet témoin").count() == 1)

    # Glisser-déposer dans l'arbre : « À ranger » sous « Projet témoin »
    ouvrir(page, "/p/Recette", attendre_editeur=True)
    page.wait_for_timeout(400)  # l'arbre se défile sur la page ouverte (chantier navigation) : on attend qu'il soit posé
    src = page.locator(".barre .rangee", has_text="À ranger").first
    dst = page.locator(".barre .rangee", has_text="Projet témoin").last
    try:
        src.drag_to(dst)
        # Laisser le navigateur traiter le dépôt (Chromium piloté : sans cette attente, la requête partait parfois
        # trop tard pour la vérification sur disque).
        page.wait_for_timeout(300)
        deplace = R / "Projet témoin" / "À ranger.md"
        t0 = time.time()
        while time.time() - t0 < 5 and not deplace.exists():
            time.sleep(0.15)
        lien = (R / "Projet témoin.md").read_text(encoding="utf-8")
        etape("glisser-déposer : page déplacée sous une autre (fichier + lien [[…]] mis à jour)", deplace.exists() and "[[Recette/Projet témoin/À ranger]]" in lien, lien[-80:])
    except Exception as e:  # noqa
        etape("glisser-déposer dans l'arbre", False, e)

    # Menu « … » : renommer
    ouvrir(page, "/p/Recette/Projet%20t%C3%A9moin/%C3%80%20ranger", attendre_editeur=True)
    try:
        # Menu « … » ancré (ordinateur) ou feuille (iPhone) ; une seule entrée « Renommer » : le titre, et le fichier
        # suit quand son nom suivait le titre (chantier navigation).
        page.click(".entete button[aria-label='Actions de la page']")
        page.click(".menu-ancre button:has-text('Renommer'), .menu-actions button:has-text('Renommer')")
        champ = page.locator(".dialogue input.champ")
        champ.fill("Rangée")
        champ.press("Enter")
        cible = R / "Projet témoin" / "Rangée.md"
        t0 = time.time()
        while time.time() - t0 < 5 and not cible.exists():
            time.sleep(0.15)
        page.wait_for_timeout(600)
        lien = (R / "Projet témoin.md").read_text(encoding="utf-8")
        etape("renommer : fichier renommé, lien mis à jour, page rouverte", cible.exists() and "[[Recette/Projet témoin/Rangée]]" in lien and page.url.endswith("/Rang%C3%A9e"), page.url)
        # Supprimer -> corbeille
        # Corbeille sans confirmation (toast « Annuler » pendant 8 s)
        page.click(".entete button[aria-label='Actions de la page']")
        page.click(".menu-ancre button:has-text('Mettre à la corbeille'), .menu-actions button:has-text('Mettre à la corbeille')")
        t0 = time.time()
        while time.time() - t0 < 5 and cible.exists():
            time.sleep(0.15)
        corbeille = list((ESPACE / ".corbeille").rglob("Rangée.md")) if (ESPACE / ".corbeille").exists() else []
        etape("supprimer : page placée dans .corbeille/", not cible.exists() and len(corbeille) >= 1, corbeille[-1:] if corbeille else "")
        for c in corbeille:
            racine = c
            while racine.parent != ESPACE / ".corbeille":
                racine = racine.parent
            if racine.parent == ESPACE / ".corbeille" and racine.exists():
                shutil.rmtree(racine)
    except Exception as e:  # noqa
        etape("menu « … » : renommer et supprimer", False, e)

    # Vue Projets : tableau, changement de statut = une seule ligne réécrite
    ouvrir(page, "/projets")
    page.click(".onglets button:has-text('Tableau')")
    page.wait_for_timeout(500)
    avant = (R / "Projet témoin.md").read_text(encoding="utf-8")
    choix = page.locator("select[aria-label='Statut de Projet témoin']")
    try:
        choix.select_option("en cours")
        apres = attendre_fichier(R / "Projet témoin.md", lambda t: "statut: en cours" in t)
        etape("projets : statut changé, une seule ligne du fichier modifiée", apres == avant.replace("statut: à faire", "statut: en cours"), repr(apres))
        capture(page, "bureau-clair-projets-tableau")
    except Exception as e:  # noqa
        etape("projets : changement de statut", False, e)
    ctx.close()


def parcours_captures(nav, gabarit, nom, sombre):
    """Captures de la démo telle que la personne la verra : AVANT toute donnée de recette. La capture longue
    (full_page) remet à zéro l'émulation mobile de Chromium (pointer: coarse disparaît) : elle est prise en dernier."""
    ctx = nouveau_contexte(nav, gabarit, sombre)
    page = ctx.new_page()
    surveiller(page, f"{nom}-{'sombre' if sombre else 'clair'}")
    th = "sombre" if sombre else "clair"
    ouvrir(page, "/")
    page.wait_for_timeout(600)
    capture(page, f"{nom}-{th}-accueil")
    if nom == "iphone":
        page.click(".entete__menu")
        page.wait_for_timeout(1500)
        capture(page, f"{nom}-{th}-arbre")
        page.click(".voile-barre", position={"x": 370, "y": 400})
        page.wait_for_timeout(300)
    ouvrir(page, "/projets")
    page.wait_for_timeout(900)
    capture(page, f"{nom}-{th}-projets")
    ouvrir(page, url_page(PAGE_RICHE), attendre_editeur=True)
    page.wait_for_timeout(1200)
    capture(page, f"{nom}-{th}-page-riche")
    # descendre jusqu'au schéma pour déclencher les aperçus, puis capture longue
    for y in range(0, 6000, 700):
        page.evaluate(f"window.scrollTo(0, {y})")
        page.wait_for_timeout(250)
    page.wait_for_timeout(2500)
    page.evaluate("window.scrollTo(0, 0)")
    page.wait_for_timeout(300)
    capture(page, f"{nom}-{th}-page-riche-longue", plein=True)
    ctx.close()


def capture_menu_slash(nav, gabarit, nom, sombre):
    """Menu « / » ouvert, dans une page du dossier de recette (jamais dans les pages de démo)."""
    ctx = nouveau_contexte(nav, gabarit, sombre)
    page = ctx.new_page()
    surveiller(page, f"{nom}-{'sombre' if sombre else 'clair'}")
    th = "sombre" if sombre else "clair"
    ouvrir(page, "/p/Recette", attendre_editeur=True)
    editeur_fin(page)
    page.keyboard.press("Enter")
    page.keyboard.type("/")
    page.wait_for_timeout(500)
    capture(page, f"{nom}-{th}-menu-slash")
    page.keyboard.press("Escape")
    ctx.close()


def main():
    avant = empreintes()
    corbeille = ESPACE / ".corbeille"
    corbeille_existait = corbeille.exists()
    version = "?"
    combos = [("iphone", IPHONE, False), ("bureau", BUREAU, False)]
    if not args.sans_captures_themes:
        combos += [("iphone", IPHONE, True), ("bureau", BUREAU, True)]
    try:
        with sync_playwright() as pw:
            nav = getattr(pw, NAV).launch()
            version = nav.version
            print(f"{NAV} {version}", flush=True)
            # 1. La démo propre, avant toute donnée de recette
            nettoyer()
            for nom, gab, sombre in combos:
                try:
                    parcours_captures(nav, gab, nom, sombre)
                except Exception as e:  # noqa
                    etape(f"captures {nom} {'sombre' if sombre else 'clair'} (exception)", False, str(e)[:600])
            # 2. Parcours fonctionnels dans le dossier dédié « Recette/ », retiré à la fin quoi qu'il arrive
            preparer()
            try:
                parcours_fonctionnel(nav)
            except Exception as e:  # noqa
                etape("parcours fonctionnel (exception)", False, str(e)[:600])
            try:
                parcours_bureau(nav)
            except Exception as e:  # noqa
                etape("parcours bureau (exception)", False, str(e)[:600])
            for nom, gab, sombre in combos:
                try:
                    capture_menu_slash(nav, gab, nom, sombre)
                except Exception as e:  # noqa
                    etape(f"capture menu / {nom} (exception)", False, str(e)[:600])
            nav.close()
    finally:
        time.sleep(1.0)
        nettoyer()
        # La corbeille créée par la recette (suppression testée) ne reste pas derrière elle.
        if not corbeille_existait and corbeille.is_dir() and not any(corbeille.iterdir()):
            corbeille.rmdir()
    apres = empreintes()
    modifiees = sorted(k for k in set(avant) | set(apres) if avant.get(k) != apres.get(k))
    etape("pages ouvertes sans modification : fichiers intacts (hors Recette/)", not modifiees, ", ".join(modifiees))
    # Artefact de Playwright : avec service_workers="block" (obligatoire pour router les requêtes), son script injecté lit
    # navigator.serviceWorker dans les cadres sandbox (artefacts) et lève cette erreur ; sans blocage elle n'existe pas.
    filtres = [e for e in erreurs_console if "service worker is disabled because the context is sandboxed" not in e.lower()
               and "tailscale-user-" not in e.lower()
               # WebKit signale ainsi une requête de même origine annulée par une navigation du test (page.goto)
               and not ("due to access control checks" in e and (BASE.split("://", 1)[-1] + "/") in e)
               and not ("Failed to load resource: net::ERR_FAILED" in e and not PROXY)]
    etape("console sans erreur", not filtres, " | ".join(filtres[:6]))
    etape(f"aucune requête externe (seulement {BASE} et {ART})", not requetes_externes, " | ".join(requetes_externes[:6]))
    reste = [str(x) for x in (ESPACE / "Recette", ESPACE / "Recette.md") if x.exists()]
    etape("démo rendue propre : dossier de recette, corbeille et favoris de test retirés", not reste and (corbeille_existait or not corbeille.exists()), " ".join(reste))
    total, ok = len(resultats), sum(r["ok"] for r in resultats)
    print(f"\n{NAV} {version} : {ok}/{total} étapes OK", flush=True)
    sortie = Path(args.resultats) if args.resultats else ICI / f"resultats-{NAV}.json"
    sortie.write_text(json.dumps({"navigateur": NAV, "version": version, "ok": ok, "total": total, "etapes": resultats,
                                  "console": erreurs_console, "externes": requetes_externes}, ensure_ascii=False, indent=1))
    sys.exit(0 if ok == total else 1)


if __name__ == "__main__":
    main()
