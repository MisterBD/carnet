#!/usr/bin/env bash
# Construit / met à jour deploy/art/kit/ depuis le registre npm (voir maj-kit.py --help).
set -euo pipefail
exec nice -n 10 python3 "$(dirname "$(readlink -f "$0")")/maj-kit.py" "$@"
