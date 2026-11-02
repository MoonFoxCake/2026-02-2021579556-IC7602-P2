#!/usr/bin/env bash
# Prueba del SISTEMA completo en una sola máquina (sin Kubernetes):
#
#   dig ──UDP──> DNS Interceptor (Interceptor/dns.c, sin cambios)
#                   └─ GET /api/records/<dominio>?sourceIp=  ──> API Node.js (routers reales, almacén en memoria)
#                                                                 └─ responde la IP de la caché de la zona del cliente
#   curl ──HTTP──> Zonal Cache "cr" (127.0.0.2) o "us" (127.0.0.3)  ── config ──> API Node.js
#                   └─ MISS ──> origen real (tests/origin.mjs, hace de Apache / REST API)
#
# El país del cliente sale de IP_COUNTRY_RANGES: 127.0.0.1 = CR y 127.0.0.5 = US (dig -b elige la IP de origen).
# Uso: make e2e-sistema   (requiere dig [dnsutils], node, curl y "npm install" en api-nodejs)
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; export NO_PROXY="*" no_proxy="*"
cd "$(dirname "$0")/.."
BIN=${ZC_BIN:-./zonal-cache}
API_DIR=../api-nodejs
[ -d "$API_DIR/node_modules/express" ] || { echo "Falta: cd api-nodejs && npm install"; exit 2; }
command -v dig >/dev/null || { echo "Falta dig: sudo apt-get install -y dnsutils"; exit 2; }
W=$(mktemp -d /tmp/zc_e2e_sis.XXXX)
ZP=18280; AP=19931; OW=19832; OJ=19833; DP=15353; KEY=clave-de-servicio-sistema
OK=0; FAIL=0; PIDS=()
check() { if (set +o pipefail; eval "$2"); then OK=$((OK+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1"; fi; }
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
wait_url() { for _ in $(seq 80); do curl -s -o /dev/null "$1" && return 0; sleep 0.1; done; echo "no arrancó: $1"; return 1; }

gcc -O2 ../Interceptor/dns.c -o "$W/dns" -lcurl -lpthread || { echo "no compila dns.c"; exit 1; }
ORIGIN_PORT=$OW ORIGIN_NAME=web  node tests/origin.mjs >"$W/ow.log" 2>&1 & PIDS+=($!)
ORIGIN_PORT=$OJ ORIGIN_NAME=java node tests/origin.mjs >"$W/oj.log" 2>&1 & PIDS+=($!)
ZONE_CACHES="cr=127.0.0.2,us=127.0.0.3" COUNTRY_ZONES="CR=cr,PA=cr,*=us" \
IP_COUNTRY_RANGES="127.0.0.1/32=CR,127.0.0.5/32=US" DNS_RECORD_TTL=30 \
ORIGIN_WEB=http://127.0.0.1:$OW ORIGIN_JAVA=http://127.0.0.1:$OJ SERVICE_KEY=$KEY PORT=$AP \
  node "$API_DIR/test/serve-memory.js" >"$W/api.log" 2>&1 & PIDS+=($!)
wait_url http://127.0.0.1:$AP/ || exit 1
for z in cr us; do
  ip=127.0.0.2; [ $z = us ] && ip=127.0.0.3
  ZC_BIND_ADDR=$ip ZC_HTTP_PORT=$ZP ZC_ZONE=$z ZC_CONFIG_URL=http://127.0.0.1:$AP ZC_CONFIG_TOKEN=$KEY \
  ZC_CACHE_DIR="$W/cache-$z" ZC_COOKIE_SECURE=0 ZC_LOGIN_MODE=local "$BIN" >"$W/zc-$z.log" 2>&1 & PIDS+=($!)
  wait_url http://$ip:$ZP/__zc/healthz || { cat "$W/zc-$z.log"; exit 1; }
done
(cd "$W" && DNS_API_URL=http://127.0.0.1:$AP stdbuf -oL ./dns --port $DP >"$W/dns.log" 2>&1) & PIDS+=($!)
sleep 0.5

DIG() { dig +short +tries=1 +time=3 -p $DP @127.0.0.1 "$@" | tail -1; }
echo "== 1. DNS Interceptor elige la caché zonal por país (IP to Country)"
IP_CR=$(DIG ejemplo.com)
IP_US=$(DIG -b 127.0.0.5 ejemplo.com)
check "cliente de CR (127.0.0.1) -> caché cr 127.0.0.2"   '[ "$IP_CR" = 127.0.0.2 ]'
check "cliente de US (127.0.0.5) -> caché us 127.0.0.3"   '[ "$IP_US" = 127.0.0.3 ]'
check "dominio sin verificar TXT: el API da 404 (fallback)" 'DIG pendiente.com >/dev/null; sleep 0.3; grep -q "pendiente.com 404" "$W/dns.log"'
check "el API recibió la IP real del cliente (sourceIp)"   'curl -s "http://127.0.0.1:$AP/api/records/ejemplo.com?sourceIp=127.0.0.5" | grep -q "\"countryCode\":\"US\""'

echo "== 2. El cliente usa la IP que dio el DNS (Host: ejemplo.com)"
R() { curl -s -D - -o /dev/null --resolve "ejemplo.com:$ZP:$1" "http://ejemplo.com:$ZP$2" "${@:3}" | tr -d '\r'; }
check "CR: atiende la caché de la zona cr"            'R $IP_CR /index.html | grep -q "^X-ZC-Zone: cr"'
check "CR: 2a vez = HIT"                              'R $IP_CR /index.html | grep -q "^X-Cache: HIT"'
check "US: atiende la caché us (su propio disco) = MISS" 'R $IP_US /index.html | grep -q "^X-ZC-Zone: us" && R $IP_US /favicon.png | grep -q "^X-Cache: MISS"'
check "contenido real del origen (Apache)"            'curl -s --resolve "ejemplo.com:$ZP:$IP_CR" http://ejemplo.com:$ZP/hola.html | grep -q "origen=web"'
check "REST API: sin key 401, con key va al origen java" '[ "$(curl -s -o /dev/null -w %{http_code} --resolve "ejemplo.com:$ZP:$IP_CR" http://ejemplo.com:$ZP/api/users.json)" = 401 ] && curl -s -H "x-api-key: clave-demo" --resolve "ejemplo.com:$ZP:$IP_CR" http://ejemplo.com:$ZP/api/users.json | grep -q "\"origin\":\"java\""'
check "REST API: POST pasa al origen (BYPASS)"        'R $IP_CR /api/users.json -H "x-api-key: clave-demo" -X POST -d "n=1" | grep -q "^X-Cache: BYPASS"'
check "privado: 302 al login de la caché"             'R $IP_US /privado/a.txt | grep -q "^Location: /__zc/login"'

echo; echo "e2e-sistema: $OK ok, $FAIL fallos"
[ $FAIL = 0 ]
