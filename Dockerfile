# syntax=docker/dockerfile:1
# Image de Carnet : construit l'interface (Vite + React), puis ne garde que le serveur Node 22 et le build statique.
# Versions épinglées par étiquette ET empreinte : une mise à jour est un changement de ce fichier, relu comme du code.

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402 AS interface
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /src/shared
COPY web/ ./
RUN npx vite build

FROM node:22.23.3-alpine3.24@sha256:0a7108bf6c7bf5de370ffb1a3ed6be93d405b43ff159f681a8d18c0e2bc2e402
ENV NODE_ENV=production
WORKDIR /app/server
# git sert seulement à LIRE l'historique des pages (git log, git cat-file), jamais à écrire.
RUN apk add --no-cache git=2.54.0-r0
COPY server/package.json server/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/src ./src
COPY shared /app/shared
COPY --from=interface /src/web/dist /app/web/dist
# L'utilisateur est choisi par compose.yml (CARNET_UID / CARNET_GID) pour pouvoir écrire dans le dossier de pages.
CMD ["node", "--max-old-space-size=128", "src/main.ts"]
