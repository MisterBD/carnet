// Carnet · écran de repli hors ligne (servi par le service worker). Script externe : la CSP interdit les scripts en ligne.
// Rôle : détecter le retour du réseau et rouvrir la page demandée. Aucun contenu de note ici, jamais (seulement, lot 5,
// les titres des saisies NON ENREGISTRÉES de ce navigateur, avec « Copier » : le travail de la personne, pas une copie).
(function () {
  "use strict";
  var bouton = document.getElementById("reessayer");
  var etat = document.getElementById("etat");
  var enCours = false;
  var minuterie = null;

  // Réseau privé à allumer (CARNET_RESEAU, ex. « Tailscale »), retenu par l'appli au dernier démarrage réussi.
  try {
    var aide = JSON.parse(localStorage.getItem("carnet:aide-connexion") || "null");
    var reseau = aide && typeof aide.reseau === "string" && /^[A-Za-z0-9À-ÿ][A-Za-z0-9À-ÿ '’.-]{0,39}$/.test(aide.reseau) ? aide.reseau : "";
    if (reseau) {
      document.getElementById("question").textContent = reseau + " est-il allumé ?";
      document.getElementById("aide").textContent = "Carnet ne s'ouvre que depuis ton réseau " + reseau + ". Allume-le, puis reviens ici : la page se rouvre toute seule.";
    }
  } catch (e) { /* stockage indisponible : texte générique */ }

  function dire(texte, ton) {
    etat.textContent = texte || "";
    if (ton) etat.setAttribute("data-ton", ton); else etat.removeAttribute("data-ton");
  }

  // « Joignable » = le serveur répond, quel que soit le statut. /sante ne demande pas d'identité.
  function sonder(manuel) {
    if (enCours) return;
    enCours = true;
    if (manuel) { bouton.disabled = true; bouton.textContent = "Nouvel essai…"; dire(""); }
    var ctl = typeof AbortController === "function" ? new AbortController() : null;
    var abandon = ctl ? setTimeout(function () { ctl.abort(); }, 6000) : null;
    fetch("/sante", { cache: "no-store", signal: ctl ? ctl.signal : undefined })
      .then(function (r) {
        if (r.ok) { location.reload(); return; }
        dire("Le serveur répond mal (erreur " + r.status + "). Réessaie dans un instant.", "ambre");
        fin();
      })
      .catch(function () {
        if (manuel) dire("Toujours pas de connexion.", "ambre");
        fin();
      })
      .then(function () { if (abandon) clearTimeout(abandon); });
  }

  function fin() {
    enCours = false;
    bouton.disabled = false;
    bouton.textContent = "Réessayer";
  }

  // Lot 5 « Fiabilité » : les saisies que Carnet n'a pas encore enregistrées (brouillons de l'appli, gardés dans CE
  // navigateur : IndexedDB « carnet-brouillons », repli localStorage « carnet:brouillon:… ») sont signalées ici, titres
  // seulement, avec « Copier » ; elles repartent toutes seules dès que la page se rouvre. Rien ne vient du réseau.
  function copier(texte) {
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(texte); return true; }
    } catch (e) { /* repli */ }
    var t = document.createElement("textarea");
    t.value = texte;
    t.setAttribute("readonly", "");
    t.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
    document.body.appendChild(t);
    t.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
    document.body.removeChild(t);
    return ok;
  }

  function afficherBrouillons(liste) {
    var parCle = {};
    for (var i = 0; i < liste.length; i++) {
      var b = liste[i];
      if (!b || typeof b.cle !== "string" || typeof b.texte !== "string" || typeof b.t !== "number") continue;
      if (!parCle[b.cle] || parCle[b.cle].t < b.t) parCle[b.cle] = b;
    }
    var tous = Object.keys(parCle).map(function (k) { return parCle[k]; }).sort(function (a, b) { return b.t - a.t; });
    if (!tous.length) return;
    var ul = document.getElementById("brouillons-liste");
    tous.slice(0, 20).forEach(function (b) {
      var li = document.createElement("li");
      var nom = document.createElement("span");
      nom.className = "nom";
      nom.textContent = typeof b.titre === "string" && b.titre ? b.titre : String(b.chemin || "").replace(/\.md$/, "");
      var btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Copier";
      btn.setAttribute("aria-label", "Copier le texte de « " + nom.textContent + " »");
      btn.addEventListener("click", function () { btn.textContent = copier(b.texte) ? "Copié" : "Copie refusée"; });
      li.appendChild(nom);
      li.appendChild(btn);
      ul.appendChild(li);
    });
    document.getElementById("brouillons").hidden = false;
  }

  (function lireBrouillons() {
    var liste = [];
    try {
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf("carnet:brouillon:") === 0) liste.push(JSON.parse(localStorage.getItem(k)));
      }
    } catch (e) { /* stockage indisponible */ }
    var fini = false;
    function finir(autres) { if (fini) return; fini = true; afficherBrouillons(liste.concat(autres || [])); }
    try {
      var r = indexedDB.open("carnet-brouillons", 1);
      r.onupgradeneeded = function () { if (!r.result.objectStoreNames.contains("brouillons")) r.result.createObjectStore("brouillons", { keyPath: "cle" }); };
      r.onerror = function () { finir([]); };
      r.onsuccess = function () {
        var db = r.result;
        try {
          var q = db.transaction("brouillons", "readonly").objectStore("brouillons").getAll();
          q.onsuccess = function () { db.close(); finir(q.result || []); };
          q.onerror = function () { db.close(); finir([]); };
        } catch (e) { db.close(); finir([]); }
      };
      setTimeout(function () { finir([]); }, 3000);
    } catch (e) { finir([]); }
  })();

  bouton.addEventListener("click", function () { sonder(true); });
  window.addEventListener("online", function () { sonder(false); });
  // Retour au premier plan (la personne vient de rallumer son VPN) : on tente tout de suite, puis toutes les 6 s.
  document.addEventListener("visibilitychange", function () { if (document.visibilityState === "visible") sonder(false); });
  function boucle() {
    if (document.visibilityState === "visible") sonder(false);
    minuterie = setTimeout(boucle, 6000);
  }
  minuterie = setTimeout(boucle, 6000);
})();
