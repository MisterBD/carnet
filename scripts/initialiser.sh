#!/usr/bin/env bash
# Prépare un premier démarrage : .env, clé de signature des artefacts (chmod 600), dossier d'état.
# Ne touche à aucun fichier existant : relançable sans risque.
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f .env ]; then
  # Sans « sed -i » ni « readlink -f » : le script marche aussi sous macOS. Fichier créé directement en 600.
  (umask 077 && sed "s/^CARNET_UID=.*/CARNET_UID=$(id -u)/; s/^CARNET_GID=.*/CARNET_GID=$(id -g)/" .env.example > .env)
  chmod 600 .env
  echo ".env créé (utilisateur $(id -u):$(id -g)). Adapte-le si besoin."
fi

mkdir -p secrets .etat
chmod 700 secrets .etat
if [ ! -f secrets/art-hmac.key ]; then
  umask 077
  # 32 octets aléatoires en hexadécimal (64 caractères).
  od -An -tx1 -N32 /dev/urandom | tr -d ' \n' > secrets/art-hmac.key
  echo >> secrets/art-hmac.key
  echo "clé de signature créée : secrets/art-hmac.key"
fi
chmod 600 secrets/art-hmac.key

# installer.sh enchaîne lui-même le démarrage : pas de consigne à afficher dans ce cas.
[ -n "${CARNET_INSTALLEUR:-}" ] || echo "Prêt. Lance : docker compose up -d --build   puis ouvre http://127.0.0.1:${CARNET_PORT_HOTE:-3020}"
