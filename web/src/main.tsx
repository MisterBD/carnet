import { createRoot } from "react-dom/client";
import "./styles/jetons.css";
import "./styles/app.css";
import "./styles/editeur.css";
import { App } from "./App";

createRoot(document.getElementById("racine")!).render(<App />);

// Service worker minimal : installation sur l'écran d'accueil + ressources figées en cache (jamais les pages).
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "127.0.0.1" || location.hostname === "localhost")) {
  window.addEventListener("load", () => {
    try {
      navigator.serviceWorker.register("/sw.js", { scope: "/" }).catch(() => { /* facultatif */ });
    } catch { /* contexte sans service worker (navigation privée, bac à sable) */ }
  });
}

// L'éditeur (Tiptap) est chargé à part : on le précharge dès que l'appli est au repos.
const precharger = () => { void import("./editeur/creer"); };
if ("requestIdleCallback" in window) (window as Window & { requestIdleCallback: (f: () => void) => void }).requestIdleCallback(precharger);
else setTimeout(precharger, 800);
