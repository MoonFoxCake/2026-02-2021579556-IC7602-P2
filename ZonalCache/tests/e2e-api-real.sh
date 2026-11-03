#!/usr/bin/env bash
# Prueba de integración: Zonal Cache (C) <-> API Node.js REAL (api-nodejs/src/cache-routes.js, almacén en memoria).
# La caché es el servidor REAL (./zonal-cache) y hace proxy a dos orígenes reales: "web" (Apache) y "java" (REST API).
# Uso: make e2e-api   (requiere haber hecho "npm install" en api-nodejs). ZC_BIN=./tools/zc_p3_demo para el demo.
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; export NO_PROXY="*" no_proxy="*"
cd "$(dirname "$0")/.."
API_DIR=../api-nodejs
[ -d "$API_DIR/node_modules/express" ] || { echo "Falta: cd api-nodejs && npm install"; exit 2; }
BIN=${ZC_BIN:-./zonal-cache}
W=$(mktemp -d /tmp/zc_e2e_api.XXXX); HP=18081; AP=19901; OW=19821; OJ=19822; KEY=clave-de-servicio-e2e
OK=0; FAIL=0; DEMO=; API=; OR1=; OR2=
check() { if (set +o pipefail; eval "$2"); then OK=$((OK+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1"; fi; }
cleanup() { for p in $DEMO $API $OR1 $OR2; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
CT="--connect-to ejemplo.com:$HP:127.0.0.1:$HP"; B="http://ejemplo.com:$HP"
H() { curl -s -o /dev/null -w '%{http_code}' $CT "$@"; }

ORIGIN_PORT=$OW ORIGIN_NAME=web  node tests/origin.mjs >"$W/ow.log" 2>&1 & OR1=$!
ORIGIN_PORT=$OJ ORIGIN_NAME=java node tests/origin.mjs >"$W/oj.log" 2>&1 & OR2=$!
ORIGIN_WEB=http://127.0.0.1:$OW ORIGIN_JAVA=http://127.0.0.1:$OJ SERVICE_KEY=$KEY PORT=$AP node "$API_DIR/test/serve-memory.js" >"$W/api.log" 2>&1 & API=$!
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$AP/" && break; sleep 0.1; done
check "API: /api/cache/config sin credencial = 401" '[ "$(curl -s -o /dev/null -w %{http_code} http://127.0.0.1:$AP/api/cache/config)" = 401 ]'

ZC_CONFIG_URL=http://127.0.0.1:$AP ZC_CONFIG_TOKEN=$KEY ZC_ZONE=cr ZC_CACHE_DIR="$W/cache" ZC_HTTP_PORT=$HP \
ZC_COOKIE_SECURE=0 ZC_LOGIN_MODE=local "$BIN" >"$W/demo.log" 2>&1 & DEMO=$!
for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$HP/" && break; sleep 0.1; done
check "la caché cargó la config del API real"       'curl -s -H "Host: ejemplo.com" "http://127.0.0.1:$HP/__zc/login?return_to=%2Fprivado%2Fa.txt" | grep -q csrf'
check "dominio sin verificar (pendiente.com) = 404" '[ "$(curl -s -o /dev/null -w %{http_code} -H "Host: pendiente.com" http://127.0.0.1:$HP/)" = 404 ]'
check "público 1a vez = MISS"                       'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-Cache: MISS"'
check "público 2a vez = HIT"                        'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-Cache: HIT"'
check "política del tipo html = LRU (Firestore)"    'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-ZC-Policy: LRU"'
check "api sin key = 401"                           '[ "$(H $B/api/users.json)" = 401 ]'
check "api key de Firestore (hash MAYÚSCULAS) = 200" '[ "$(H -H "x-api-key: clave-demo" $B/api/users.json)" = 200 ]'
check "api usa política MRU"                        'curl -s -D - -o /dev/null $CT -H "x-api-key: clave-demo" $B/api/users.json | grep -q "X-ZC-Policy: MRU"'
check "api usa SU origin (rest-api-java), no el del dominio" 'curl -s $CT -H "x-api-key: clave-demo" $B/api/users.json | grep -Eq "rest-api-java:8080|\"origin\":\"java\""'
check "URL con authType desconocido queda cerrada"  '[ "$(H $B/raro/x.html)" = 401 ]'
check "privado sin sesión = 302"                    '[ "$(H $B/privado/a.txt)" = 302 ]'
FORM=$(curl -s -c "$W/jar" $CT "$B/__zc/login?return_to=%2Fprivado%2Fa.txt")
CSRF=$(printf '%s' "$FORM" | sed -n 's/.*name="csrf" value="\([0-9a-f]*\)".*/\1/p')
check "login con contraseña mala (bcrypt) = 401"    '[ "$(H -b "$W/jar" -d "username=kevin&password=mala&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login)" = 401 ]'
check "login con usuario inexistente = 401"         '[ "$(H -b "$W/jar" -d "username=nadie&password=s3creto&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login)" = 401 ]'
check "login correcto verificado por el API = 302"  'curl -s -D - -o /dev/null $CT -b "$W/jar" -c "$W/jar" -d "username=kevin&password=s3creto&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login | grep -q "zc_session="'
check "con sesión = 200"                            '[ "$(H -b "$W/jar" $B/privado/a.txt)" = 200 ]'
echo; echo "e2e-api ($BIN): $OK ok, $FAIL fallos"; [ $FAIL = 0 ]
