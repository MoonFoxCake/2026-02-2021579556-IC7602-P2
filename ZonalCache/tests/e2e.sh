#!/usr/bin/env bash
# Prueba de punta a punta de la Persona 3 con curl: servidor demo + mock del API Node.js.
# Uso: make e2e   (requiere node >= 18, curl, openssl)
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; export NO_PROXY="*" no_proxy="*"   # curl directo, sin proxies del sistema
cd "$(dirname "$0")/.."
W=$(mktemp -d /tmp/zc_e2e.XXXX)
HP=18080; SP=18443; MP=19900
TOKEN=token-de-la-cache; SECRET=secreto-compartido-de-pruebas-0123456789
CT="--connect-to ejemplo.com:$HP:127.0.0.1:$HP --connect-to ejemplo.com:$SP:127.0.0.1:$SP"
OK=0; FAIL=0; DEMO=; MOCK=
check() { if (set +o pipefail; eval "$2"); then OK=$((OK+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1"; fi; }
cleanup() { [ -n "$DEMO" ] && kill "$DEMO" 2>/dev/null; [ -n "$MOCK" ] && kill "$MOCK" 2>/dev/null; wait 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
wait_port() { for _ in $(seq 50); do curl -s -o /dev/null "http://127.0.0.1:$1/" && return 0; sleep 0.1; done; return 1; }

MOCK_PORT=$MP MOCK_TOKEN=$TOKEN MOCK_TICKET_SECRET=$SECRET node tests/mock-api.mjs >"$W/mock.log" 2>&1 & MOCK=$!
bash scripts/gen-dev-cert.sh "$W/certs" ejemplo.com >/dev/null
start_demo() { # $1 = local|ui
  ZC_CONFIG_URL=http://127.0.0.1:$MP ZC_CONFIG_TOKEN=$TOKEN ZC_ZONE=cr ZC_CACHE_DIR="$W/cache" \
  ZC_HTTP_PORT=$HP ZC_HTTPS_PORT=$SP ZC_TLS_CERT_FILE="$W/certs/dev.crt" ZC_TLS_KEY_FILE="$W/certs/dev.key" \
  ZC_COOKIE_SECURE=0 ZC_LOGIN_MODE=$1 ZC_LOGIN_UI_URL=http://127.0.0.1:$MP/cache-login ZC_TICKET_SECRET=$SECRET \
  ./tools/zc_p3_demo >>"$W/demo.log" 2>&1 & DEMO=$!
  wait_port $HP || { echo "el demo no arrancó"; cat "$W/demo.log"; exit 1; }
}
stop_demo() { kill -TERM "$DEMO"; wait "$DEMO" 2>/dev/null; DEMO=; }
wait_port $MP || { echo "mock no arrancó"; cat "$W/mock.log"; exit 1; }
B="http://ejemplo.com:$HP"
H() { curl -s -o /dev/null -w '%{http_code}' $CT "$@"; }

echo "== Modo local"
start_demo local
check "dominio no registrado = 404"         '[ "$(curl -s -o /dev/null -w %{http_code} -H "Host: otro.com" http://127.0.0.1:$HP/)" = 404 ]'
check "público 1a vez = MISS"                'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-Cache: MISS"'
check "público 2a vez = HIT"                 'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-Cache: HIT"'
check "html usa LRU (config de Firebase)"    'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-ZC-Policy: LRU"'
check "api sin key = 401"                    '[ "$(H $B/api/users)" = 401 ]'
check "api key mala = 401"                   '[ "$(H -H "x-api-key: nop" $B/api/users)" = 401 ]'
check "api key buena = 200 MRU"              'curl -s -D - -o /dev/null $CT -H "x-api-key: clave-demo" $B/api/users | grep -q "X-ZC-Policy: MRU"'
check "privado sin sesión = 302 a login"     'curl -s -D - -o /dev/null $CT $B/privado/a.txt | grep -q "Location: /__zc/login?return_to=%2Fprivado%2Fa.txt"'
FORM=$(curl -s -c "$W/jar" $CT "$B/__zc/login?return_to=%2Fprivado%2Fa.txt")
CSRF=$(printf '%s' "$FORM" | sed -n 's/.*name="csrf" value="\([0-9a-f]*\)".*/\1/p')
check "formulario trae token CSRF"           '[ ${#CSRF} = 64 ]'
check "login sin CSRF = 403"                 '[ "$(H -b "$W/jar" -d "username=kevin&password=s3creto&return_to=/privado/a.txt" $B/__zc/login)" = 403 ]'
check "login contraseña mala = 401"          '[ "$(H -b "$W/jar" -d "username=kevin&password=x&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login)" = 401 ]'
check "login correcto = 302 + cookie"        'curl -s -D - -o /dev/null $CT -b "$W/jar" -c "$W/jar" -d "username=kevin&password=s3creto&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login | grep -q "zc_session="'
check "con sesión = 200 MISS, private"       'curl -s -D - -o /dev/null $CT -b "$W/jar" $B/privado/a.txt | grep -q "Cache-Control: private"'
check "con sesión 2a vez = HIT"              'curl -s -D - -o /dev/null $CT -b "$W/jar" $B/privado/a.txt | grep -q "X-Cache: HIT"'
check "logout = 302 y borra cookie"          'curl -s -D - -o /dev/null $CT -b "$W/jar" -c "$W/jar" $B/__zc/logout | grep -q "Max-Age=0"'
check "tras logout = 302 a login"            '[ "$(H -b "$W/jar" $B/privado/a.txt)" = 302 ]'
check "HTTPS (SSL termination) = 200"        '[ "$(curl -sk -o /dev/null -w %{http_code} $CT https://ejemplo.com:$SP/index.html)" = 200 ]'
check "HTTPS negocia TLS >= 1.2"             'curl -skv $CT https://ejemplo.com:$SP/index.html 2>&1 | grep -Eq "TLSv1\.[23]"'
check "rate limit login = 429"               'for i in 1 2 3 4 5 6; do c=$(H -b "$W/jar" -d "username=kevin&password=x&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login); done; [ "$c" = 429 ]'
stop_demo
check "índice guardado al apagar"           '[ -s "$W/cache/ejemplo.com/index.zc" ]'

echo "== Reinicio: el índice y los archivos sobreviven"
start_demo ui
check "tras reinicio = HIT"                  'curl -s -D - -o /dev/null $CT $B/index.html | grep -q "X-Cache: HIT"'

echo "== Modo UI (login en el UI + ticket firmado)"
LOC=$(curl -s -D - -o /dev/null $CT $B/privado/b.txt | sed -n 's/^Location: //p' | tr -d '\r')
check "redirige al UI con callback"          'printf "%s" "$LOC" | grep -q "^http://127.0.0.1:$MP/cache-login?domain=ejemplo.com&pattern=%2Fprivado%2F%2A&callback=http%3A%2F%2Fejemplo.com%3A$HP%2F__zc%2Fcallback"'
CB=$(curl -s -D - -o /dev/null "$LOC&user=kevin&pass=s3creto" | sed -n 's/^Location: //p' | tr -d '\r')
check "UI devuelve ticket al callback"       'printf "%s" "$CB" | grep -q "/__zc/callback?ticket="'
check "callback crea sesión"                 'curl -s -D - -o /dev/null $CT -c "$W/jar2" "$CB" | grep -q "zc_session="'
check "ticket reutilizado = 401"             '[ "$(H "$CB")" = 401 ]'
check "con sesión del UI = 200"              '[ "$(H -b "$W/jar2" $B/privado/b.txt)" = 200 ]'
check "UI rechaza callback de otro dominio"  '[ "$(curl -s -o /dev/null -w %{http_code} "http://127.0.0.1:$MP/cache-login?domain=ejemplo.com&pattern=/privado/*&callback=http://evil.com/__zc/callback&user=kevin&pass=s3creto")" = 400 ]'

echo "== Límite por URL (cacheBytes=600) con LFU"
for f in c d e f g h i j; do curl -s -o /dev/null $CT -b "$W/jar2" $B/privado/$f.txt; done
BYTES=$(curl -s -D - -o /dev/null $CT -b "$W/jar2" $B/privado/j.txt | sed -n 's/^X-ZC-Domain-Bytes: //p' | tr -d '\r')
check "dominio no supera maxCacheBytes"      '[ "$BYTES" -le 2000 ]'
NOBJ=$(ls "$W/cache/ejemplo.com" | grep -vc index.zc)
check "archivos expulsados se borran"        '[ "$NOBJ" -le 10 ]'
stop_demo

echo
echo "e2e: $OK ok, $FAIL fallos"
[ $FAIL = 0 ]
