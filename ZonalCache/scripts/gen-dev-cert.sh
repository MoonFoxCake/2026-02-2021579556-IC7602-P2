#!/usr/bin/env bash
# Genera un certificado autofirmado SOLO para desarrollo/pruebas. Uso: scripts/gen-dev-cert.sh [dir] [CN]
set -euo pipefail
DIR="${1:-./certs}"; CN="${2:-localhost}"
mkdir -p "$DIR"
openssl req -x509 -newkey rsa:2048 -nodes -days 30 -subj "/CN=${CN}" \
  -addext "subjectAltName=DNS:${CN}" -keyout "$DIR/dev.key" -out "$DIR/dev.crt" 2>/dev/null
chmod 600 "$DIR/dev.key"
echo "Certificado: $DIR/dev.crt  Llave: $DIR/dev.key"
echo "export ZC_TLS_CERT_FILE=$DIR/dev.crt ZC_TLS_KEY_FILE=$DIR/dev.key"
