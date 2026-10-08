// Carnet · écran de repli hors ligne (servi par le service worker). Script externe : la CSP interdit les scripts en ligne.
// Rôle : détecter le retour du réseau et rouvrir la page demandée. Aucun contenu de note ici, jamais.
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
