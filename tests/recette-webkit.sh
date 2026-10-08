#!/usr/bin/env bash
# Recette WebKit (moteur de Safari) sans sudo : conteneur officiel Playwright (version épinglée), réseau de l'hôte.
# L'image est retirée à la fin, sauf si un autre conteneur Playwright tourne encore (ou avec --garder-image).
# Usage : ESPACE=<dossier de pages> tests/recette-webkit.sh [--garder-image] [--base URL] [options de recette.py]
set -euo pipefail
IMAGE=mcr.microsoft.com/playwright/python:v1.59.0-noble
ICI="$(dirname "$(readlink -f "$0")")"
RACINE="$(dirname "$ICI")"
ESPACE="$(readlink -f "${ESPACE:-$RACINE/demo}")"
SORTIE="${SORTIE:-$RACINE/captures}"
garder=0; base="http://127.0.0.1:3020"; extra=()
while [ $# -gt 0 ]; do
  case "$1" in
    --garder-image) garder=1 ;;
    --base) base="$2"; shift ;;
    *) extra+=("$1") ;;
  esac
  shift
done
[ -d "$ESPACE" ] || { echo "espace absent : $ESPACE (variable ESPACE)" >&2; exit 2; }
mkdir -p "$SORTIE"
df -h / | tail -1
docker image inspect "$IMAGE" >/dev/null 2>&1 || nice -n 10 docker pull -q "$IMAGE"
set +e
# L'image fournit WebKit et ses dépendances système ; le paquet Python playwright (même version 1.59.0) est
# celui de l'hôte, monté en lecture seule.
SITE="$(python3 -c 'import playwright, os; print(os.path.dirname(os.path.dirname(playwright.__file__)))')"
# Limites du conteneur navigateur (VPS partagé : un WebKit sans borne a déjà fait monter la charge à 104 et rempli le swap).
# Surchargeables : PW_LIMITES="--cpus=1 --memory=2g --memory-swap=2g" tests/….sh ; PW_LIMITES="" pour aucune limite.
read -ra LIMITES <<< "${PW_LIMITES---cpus=2 --memory=2500m --memory-swap=2500m}"
docker run --rm "${LIMITES[@]}" --network host --ipc=host --user "$(id -u):$(id -g)" -e HOME=/tmp -e PYTHONPATH=/hote-site \
  -v "$SITE:/hote-site:ro" \
  -v "$ICI:/recette/tests:ro" -v "$SORTIE:/recette/sortie" -v "$ESPACE:$ESPACE" \
  "$IMAGE" python3 /recette/tests/recette.py --navigateur webkit --base "$base" --espace "$ESPACE" \
  --captures /recette/sortie --resultats /recette/sortie/resultats-webkit.json "${extra[@]}"
code=$?
set -e
if [ "$garder" != 1 ]; then
  if [ -z "$(docker ps -q --filter ancestor="$IMAGE")" ]; then docker rmi "$IMAGE" >/dev/null && echo "image $IMAGE supprimée"
  else echo "image gardée : un autre conteneur Playwright tourne"; fi
fi
df -h / | tail -1
exit $code
