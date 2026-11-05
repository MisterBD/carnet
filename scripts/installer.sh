#!/usr/bin/env bash
# Installe et démarre Carnet en local, en une commande, depuis un clone du dépôt :
#
#   git clone https://github.com/MisterBD/carnet.git && cd carnet && ./scripts/installer.sh
#
# Ce que fait ce script (il est court : lis-le avant de le lancer) :
#   1. vérifie Docker et le plugin Compose v2 ;
#   2. lance scripts/initialiser.sh : .env, clé de signature (chmod 600), dossier d'état. Rien d'existant n'est modifié ;
#   3. vérifie que les deux ports sont libres sur 127.0.0.1 ;
#   4. construit les deux images et démarre les conteneurs (docker compose up -d --build --wait) ;
#   5. affiche l'adresse de Carnet.
# Il n'utilise pas sudo, ne télécharge rien d'autre que ce que télécharge la construction (images de base et paquets
# npm épinglés par empreinte) et ne publie les ports que sur 127.0.0.1. Relançable sans risque.
#
# Autres ports, au premier lancement seulement (ils sont ensuite écrits dans .env) :
#   CARNET_PORT_HOTE=3030 ART_PORT_HOTE=3036 ./scripts/installer.sh
set -euo pipefail
cd "$(dirname "$0")/.."

case "${1:-}" in
  -h|--help|--aide) awk 'NR > 1 && /^#/ { sub(/^# ?/, ""); print; next } NR > 1 { exit }' "$0"; exit 0 ;;
  "") ;;
  *) echo "Option inconnue (unknown option) : $1. Voir --help." >&2; exit 2 ;;
esac

die() { echo "ERREUR : $*" >&2; exit 1; }

# --- 1. Prérequis -----------------------------------------------------------------------------------------------------
command -v docker >/dev/null 2>&1 || die "Docker introuvable (Docker not found) : https://docs.docker.com/get-docker/"
docker compose version >/dev/null 2>&1 || die "plugin Docker Compose v2 introuvable (docker compose plugin not found)."
docker info >/dev/null 2>&1 || die "le démon Docker ne répond pas : est-il lancé, et ton utilisateur a-t-il le droit de l'utiliser ? (Docker daemon not reachable)"

# --- 2. .env, clé, dossier d'état -------------------------------------------------------------------------------------
premier=0
[ -f .env ] || premier=1
CARNET_INSTALLEUR=1 ./scripts/initialiser.sh

# Remplace (ou ajoute) la ligne CLE=… de .env, sans sed -i (portable Linux et macOS), en gardant le chmod 600.
poser() {
  local tmp
  tmp="$(mktemp .env.XXXXXX)"
  awk -v cle="$1" -v val="$2" 'index($0, cle "=") == 1 { print cle "=" val; vu = 1; next } { print } END { if (!vu) print cle "=" val }' .env > "$tmp"
  chmod 600 "$tmp"
  mv "$tmp" .env
}
lire() { awk -F= -v cle="$1" '$1 == cle { print substr($0, length(cle) + 2); exit }' .env; }

if [ "$premier" = 1 ] && { [ -n "${CARNET_PORT_HOTE:-}" ] || [ -n "${ART_PORT_HOTE:-}" ]; }; then
  p_app="${CARNET_PORT_HOTE:-3020}"; p_art="${ART_PORT_HOTE:-3006}"
  for p in "$p_app" "$p_art"; do
    case "$p" in ''|*[!0-9]*) die "port invalide : $p" ;; esac
    [ "$p" -ge 1024 ] && [ "$p" -le 65535 ] || die "port hors de 1024-65535 : $p"
  done
  [ "$p_app" != "$p_art" ] || die "les deux ports doivent être différents"
  poser CARNET_PORT_HOTE "$p_app"
  poser ART_PORT_HOTE "$p_art"
  # Les artefacts doivent rester sur une AUTRE origine que l'application : la table suit les ports.
  poser CARNET_ORIGINES_ARTEFACTS "http://127.0.0.1:$p_app=http://127.0.0.1:$p_art http://localhost:$p_app=http://127.0.0.1:$p_art"
  poser CARNET_ART_BASE "http://127.0.0.1:$p_art"
  echo "Ports écrits dans .env : Carnet $p_app, artefacts $p_art."
fi
# À partir d'ici, .env fait foi : une variable de l'environnement passerait devant lui dans docker compose.
unset CARNET_PORT_HOTE ART_PORT_HOTE CARNET_ORIGINES_ARTEFACTS CARNET_ART_BASE
port_app="$(lire CARNET_PORT_HOTE)"; port_app="${port_app:-3020}"
port_art="$(lire ART_PORT_HOTE)"; port_art="${port_art:-3006}"

# --- 3. Ports libres (sauf si ce Carnet tourne déjà : on le met simplement à jour) ------------------------------------
occupe() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
if [ -z "$(docker compose ps -q 2>/dev/null)" ]; then
  for p in "$port_app" "$port_art"; do
    if occupe "$p"; then
      die "le port 127.0.0.1:$p est déjà pris (port already in use). Supprime .env puis relance avec d'autres ports :
  rm .env && CARNET_PORT_HOTE=3030 ART_PORT_HOTE=3036 ./scripts/installer.sh"
    fi
  done
fi

# --- 4. Construction et démarrage -------------------------------------------------------------------------------------
echo "Construction des images et démarrage (quelques minutes la première fois)…"
docker compose up -d --build --wait --wait-timeout 300

# --- 5. Adresse -------------------------------------------------------------------------------------------------------
if command -v curl >/dev/null 2>&1; then
  curl -fsS -o /dev/null "http://127.0.0.1:$port_app/sante" || die "Carnet ne répond pas sur 127.0.0.1:$port_app : docker compose logs carnet"
fi
cat <<FIN

Carnet est prêt · Carnet is ready:  http://127.0.0.1:$port_app

  Espace de démonstration : ./demo. Tes notes : CARNET_ESPACE_HOTE=/chemin/vers/tes/notes dans .env,
  puis docker compose up -d. Arrêter : docker compose down. Journaux : docker compose logs -f carnet.
  Mode d'essai local (CARNET_DEV=1) : sans authentification, sur 127.0.0.1 seulement. Pour tes autres appareils,
  un proxy qui authentifie devant Carnet : voir docs/deploiement.md. Ne l'expose jamais sans authentification.
FIN
