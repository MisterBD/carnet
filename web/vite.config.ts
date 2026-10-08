import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// Build statique servi par le serveur Carnet (127.0.0.1:3020). Aucune ressource externe.
// `vite build --mode outils` construit à part (dist-outils/) le banc de fidélité Markdown : jamais servi en production.
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    fs: { allow: [resolve(import.meta.dirname, "..")] },
  },
  build: {
    target: "es2022",
    outDir: mode === "outils" ? "dist-outils" : "dist",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    sourcemap: false,
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: mode === "outils"
        ? { fidelite: resolve(import.meta.dirname, "outils/fidelite.html") }
        : { index: resolve(import.meta.dirname, "index.html") },
    },
  },
}));
