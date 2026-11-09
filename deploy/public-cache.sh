#!/usr/bin/env bash
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
: "${P2_TEST_BASE_DOMAIN:?Set P2_TEST_BASE_DOMAIN}"
: "${P2_TUNNEL_ID:?Set P2_TUNNEL_ID}"
: "${P2_TUNNEL_CREDENTIALS:?Set P2_TUNNEL_CREDENTIALS to the tunnel JSON file}"
: "${CACHE_TEST_TUNNEL_KEY:?Set the shared gateway key}"
NAMESPACE=${NAMESPACE:-default}
[[ "$P2_TEST_BASE_DOMAIN" =~ ^[a-z0-9.-]+$ && "$NAMESPACE" =~ ^[a-z0-9-]+$ ]]
[[ "$CACHE_TEST_TUNNEL_KEY" =~ ^[a-f0-9]{64}$ ]]
CERT=$(kubectl -n "$NAMESPACE" get secret zc-tls -o jsonpath='{.data.tls\.crt}' | base64 -d)
ORIGIN_SERVER_NAME=$(printf '%s' "$CERT" | openssl x509 -noout -subject -nameopt multiline | sed -n 's/^ *commonName *= *//p')
[[ "$ORIGIN_SERVER_NAME" =~ ^[a-z0-9.-]+$ ]] || { echo 'Cache certificate needs a valid DNS common name' >&2; exit 1; }
umask 077
GATEWAY_CONFIG=$(mktemp)
trap 'rm -f "$GATEWAY_CONFIG"' EXIT
sed -e "s/__NAMESPACE__/$NAMESPACE/g" -e "s/__BASE_DOMAIN__/$P2_TEST_BASE_DOMAIN/g" \
    -e "s/__TUNNEL_KEY__/$CACHE_TEST_TUNNEL_KEY/g" -e "s/__ORIGIN_SERVER_NAME__/$ORIGIN_SERVER_NAME/g" \
    "$ROOT/deploy/public-cache-gateway.conf.template" > "$GATEWAY_CONFIG"
kubectl -n "$NAMESPACE" create secret generic public-cache-tunnel \
    --from-file=tunnel.json="$P2_TUNNEL_CREDENTIALS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NAMESPACE" create secret generic public-cache-gateway \
    --from-file=default.conf="$GATEWAY_CONFIG" --dry-run=client -o yaml | kubectl apply -f -
helm upgrade --install public-cache "$ROOT/helm/public-cache" -n "$NAMESPACE" \
    --set-string tunnelId="$P2_TUNNEL_ID" --set-string baseDomain="$P2_TEST_BASE_DOMAIN" \
    --set-string originServerName="$ORIGIN_SERVER_NAME"
kubectl -n "$NAMESPACE" rollout restart deployment/public-cache
kubectl -n "$NAMESPACE" rollout status deployment/public-cache --timeout=240s
