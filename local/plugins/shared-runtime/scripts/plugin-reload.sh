#!/usr/bin/env bash
set -Eeuo pipefail

ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
# shellcheck disable=SC1091
source "$ROOT/scripts/lib/bb-cli.sh"

bb_cli=$(resolve_bb_cli)
BB_CLI=$bb_cli "$bb_cli" plugin reload shared-runtime
