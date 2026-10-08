#!/usr/bin/env python3
"""Génère les écrans de lancement iOS (apple-touch-startup-image) dans web/public/lancement/ et la liste de <link>
à coller dans index.html.

    python3 web/outils-pwa/ecrans-lancement.py            # écrit les PNG et affiche les <link>

Un écran = fond du thème (#fbfbfa clair, #12161c sombre, comme --fond), le sceau de l'icône (indigo, deux vagues) et
« Carnet » en Literata, centrés. Même fond que la première image de l'appli : aucun flash blanc au lancement, en sombre
non plus. Rendu par Chromium (Playwright) avec la police locale, puis palette réduite (PNG léger). Rien d'externe.
iOS lit ces images quand on ajoute l'appli à l'écran d'accueil : il faut la réinstaller pour les voir.
"""
import base64, io, sys
from pathlib import Path
from PIL import Image
from playwright.sync_api import sync_playwright

ICI = Path(__file__).resolve().parent
PUBLIC = ICI.parent / "public"
SORTIE = PUBLIC / "lancement"
POLICE = base64.b64encode((PUBLIC / "polices" / "literata-opsz.woff2").read_bytes()).decode()

# (largeur CSS, hauteur CSS, ratio) des iPhone en portrait, de l'iPhone SE à l'iPhone 17 Pro Max / Air
APPAREILS = [
    (440, 956, 3), (420, 912, 3), (402, 874, 3), (430, 932, 3), (393, 852, 3), (428, 926, 3), (390, 844, 3),
    (375, 812, 3), (414, 896, 3), (414, 896, 2), (414, 736, 3), (375, 667, 2), (320, 568, 2),
]
THEMES = {
    "clair": dict(fond="#fbfbfa", nom="#1c2129"),
    "sombre": dict(fond="#12161c", nom="#e5e8ec"),
}
SCEAU = "#2d4f86"

MODELE = """<!doctype html><meta charset="utf-8"><style>
@font-face {{ font-family: L; src: url(data:font/woff2;base64,{police}) format("woff2"); font-weight: 200 900; }}
html, body {{ margin: 0; width: {w}px; height: {h}px; background: {fond}; overflow: hidden; }}
.c {{ position: absolute; left: 0; right: 0; top: 46%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; }}
.s {{ width: {s}px; height: {s}px; border-radius: {r}px; background: {sceau}; display: grid; place-items: center; }}
.s svg {{ width: {g}px; height: {g}px; }}
.n {{ margin-top: {m}px; font: 600 {f}px/1 L, Georgia, serif; letter-spacing: -0.015em; color: {nom}; font-variation-settings: "opsz" 48; }}
</style><div class="c"><div class="s"><svg viewBox="0 0 24 24" fill="none">
<path d="M3 9.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/>
<path d="M3 15.5c2.2-3 4.8-3 7 0s4.8 3 7 0 2.8-2.2 4-1.2" stroke="#fff" stroke-opacity=".6" stroke-width="2.2" stroke-linecap="round"/></svg></div>
<div class="n">Carnet</div></div>"""


def main():
    SORTIE.mkdir(parents=True, exist_ok=True)
    liens = []
    with sync_playwright() as p:
        nav = p.chromium.launch()
        for (w, h, ratio) in APPAREILS:
            for theme, c in THEMES.items():
                s = round(min(w, h) * 0.2)
                ctx = nav.new_context(viewport={"width": w, "height": h}, device_scale_factor=ratio)
                page = ctx.new_page()
                page.set_content(MODELE.format(w=w, h=h, police=POLICE, fond=c["fond"], nom=c["nom"], sceau=SCEAU,
                                               s=s, r=round(s * 0.26), g=round(s * 0.56), m=round(s * 0.24), f=round(s * 0.34)))
                page.evaluate("document.fonts.ready")
                page.wait_for_timeout(120)
                png = page.screenshot(type="png")
                ctx.close()
                im = Image.open(io.BytesIO(png)).convert("RGB").quantize(colors=48, method=Image.Quantize.MEDIANCUT, dither=Image.Dither.NONE)
                nom = f"lancement-{w * ratio}x{h * ratio}-{theme}.png"
                im.save(SORTIE / nom, optimize=True)
                media = (f"(device-width: {w}px) and (device-height: {h}px) and (-webkit-device-pixel-ratio: {ratio}) "
                         f"and (orientation: portrait)" + (" and (prefers-color-scheme: dark)" if theme == "sombre" else ""))
                liens.append(f'    <link rel="apple-touch-startup-image" href="/lancement/{nom}" media="{media}" />')
        nav.close()
    total = sum(f.stat().st_size for f in SORTIE.glob("*.png"))
    print(f"{len(liens)} écrans, {total // 1024} Ko", file=sys.stderr)
    (ICI / "liens-lancement.html").write_text("\n".join(liens) + "\n")
    print("\n".join(liens))


if __name__ == "__main__":
    main()
