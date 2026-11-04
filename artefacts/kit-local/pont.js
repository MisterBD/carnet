/* pont.js : pont postMessage hôte <-> artefact (contrat docs/architecture.md, « Interface artefacts »).
 * Kit maison (pas un paquet npm), sans dépendance, à inclure avec <script src="/kit/pont.js"></script>.
 *
 *   artefact -> hôte : { type: 'artefact:hauteur', h: <px entiers> }   au chargement puis à chaque changement de taille
 *   hôte -> artefact : { type: 'hote:theme', theme: 'clair' | 'sombre' }
 *                      -> <html data-theme="clair|sombre">, style.colorScheme, évènement 'hote:theme' sur window
 *
 * Sécurité : l'hôte n'est reconnu QUE par e.source === window.parent. Jamais par e.origin :
 * un document sandboxé sans allow-same-origin a l'origine opaque "null".
 * API : window.NotesPont = { hauteur(), theme(), surTheme(fn), envoyer(msg), definirTheme(t) }
 */
(function (w, d) {
  'use strict';
  if (w.NotesPont) return;
  var hote = w.parent;
  var themeCourant = 'clair';
  try { if (w.matchMedia && w.matchMedia('(prefers-color-scheme: dark)').matches) themeCourant = 'sombre'; } catch (e) {}
  var ecouteurs = [];
  var derniere = -1;
  var planifie = false;

  function envoyer(msg) {
    if (hote && hote !== w) { try { hote.postMessage(msg, '*'); } catch (e) {} }
  }

  function mesurer() {
    var e = d.documentElement;
    return e ? Math.ceil(e.getBoundingClientRect().height) : 0;
  }

  function hauteur(force) {
    var h = mesurer();
    if (force || Math.abs(h - derniere) >= 1) { derniere = h; envoyer({ type: 'artefact:hauteur', h: h }); }
    return h;
  }

  function planifier() {
    if (planifie) return;
    planifie = true;
    (w.requestAnimationFrame || w.setTimeout)(function () { planifie = false; hauteur(false); });
  }

  function appliquerTheme(t) {
    themeCourant = t === 'sombre' ? 'sombre' : 'clair';
    var e = d.documentElement;
    e.setAttribute('data-theme', themeCourant);
    e.style.colorScheme = themeCourant === 'sombre' ? 'dark' : 'light';
    for (var i = 0; i < ecouteurs.length; i++) { try { ecouteurs[i](themeCourant); } catch (err) {} }
    try { w.dispatchEvent(new CustomEvent('hote:theme', { detail: { theme: themeCourant } })); } catch (err) {}
    planifier();
  }

  w.addEventListener('message', function (e) {
    if (e.source !== hote) return;               // jamais par origin
    var m = e.data;
    if (m && typeof m === 'object' && m.type === 'hote:theme') appliquerTheme(m.theme);
  });

  function demarrer() {
    if (!d.documentElement.hasAttribute('data-theme')) {
      d.documentElement.setAttribute('data-theme', themeCourant);
      d.documentElement.style.colorScheme = themeCourant === 'sombre' ? 'dark' : 'light';
    }
    if (w.ResizeObserver) {
      var ro = new w.ResizeObserver(planifier);
      ro.observe(d.documentElement);
      if (d.body) ro.observe(d.body);
    }
    w.addEventListener('resize', planifier);
    w.addEventListener('load', function () { hauteur(true); });
    if (d.fonts && d.fonts.ready) d.fonts.ready.then(planifier);
    hauteur(true);
  }

  w.NotesPont = {
    hauteur: function () { return hauteur(true); },
    theme: function () { return themeCourant; },
    surTheme: function (fn) { if (typeof fn === 'function') ecouteurs.push(fn); },
    envoyer: envoyer,
    definirTheme: appliquerTheme   // usage interne (pages /rendu/*) : applique un thème reçu avec la spec
  };

  if (d.readyState === 'loading') d.addEventListener('DOMContentLoaded', demarrer); else demarrer();
})(window, document);
