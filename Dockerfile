# syntax=docker/dockerfile:1
# Image de Carnet : construit l'interface (Vite + React), puis ne garde que le serveur Node 22 et le build statique.
# Versions épinglées par étiquette ET empreinte : une mise à jour est un changement de ce fichier, relu comme du code.

FROM node:22.22.3-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd AS interface
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY shared /src/shared
COPY web/ ./
RUN npx vite build

FROM node:22.22.3-alpine3.24@sha256:e58326d0d441090181ac150dc2078d3e2cf6a0d42e809aebba3ef5880935ffdd
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
