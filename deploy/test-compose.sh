#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
PROJECT="p2-check-$$"
for KIND in 'container' 'network' 'volume'; do
  if [[ "$KIND" == container ]]; then
    EXISTING=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
  else
    EXISTING=$(docker "$KIND" ls -q --filter "label=com.docker.compose.project=$PROJECT")
  fi
  [[ -z "$EXISTING" ]] || { echo "Refusing to reuse existing project $PROJECT" >&2; exit 1; }
done
# No production .env, host ports or shared data volumes in this emulator-only test.
COMPOSE=(docker compose --env-file /dev/null --project-name "$PROJECT"
  -f "$ROOT/compose.yaml" -f "$ROOT/deploy/local/compose.test.yaml")
cleanup() { "${COMPOSE[@]}" down --volumes; }
trap cleanup EXIT
"${COMPOSE[@]}" config --quiet
"${COMPOSE[@]}" up --build -d --wait --wait-timeout 240
"${COMPOSE[@]}" run --rm local-smoke
echo "PASS: isolated Compose build, health checks and smoke tests ($PROJECT)."
