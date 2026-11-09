#!/usr/bin/env bash
set -euo pipefail
bin=$(realpath "${1:-./dns}")
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if (cd "$tmp" && env -u DNS_API_URL "$bin" --port 5353 >out 2>err); then
  echo "DNS_API_URL was not required" >&2
  exit 1
fi
grep -q 'DNS_API_URL es obligatorio' "$tmp/err"
