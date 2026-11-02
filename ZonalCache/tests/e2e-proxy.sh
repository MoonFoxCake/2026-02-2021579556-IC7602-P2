#!/usr/bin/env bash
# Pruebas de punta a punta del SERVIDOR REAL de la Zonal Cache (proxy + caché en disco) contra orígenes reales:
#   - origen "web"  (HTTP)   hace de Apache / sitio externo HTTP
#   - origen "java" (HTTP)   hace de REST API (GET/POST/PUT/DELETE)
#   - origen "ext"  (HTTPS)  hace de sitio externo HTTPS (certificado propio validado con ZC_ORIGIN_CA_FILE)
# Uso: make e2e-proxy   (requiere node >= 18, curl, openssl)
set -uo pipefail
unset http_proxy https_proxy HTTP_PROXY HTTPS_PROXY ALL_PROXY all_proxy; export NO_PROXY="*" no_proxy="*"
cd "$(dirname "$0")/.."
BIN=${ZC_BIN:-./zonal-cache}
W=$(mktemp -d /tmp/zc_e2e_proxy.XXXX)
HP=18180; SP=18543; O1=19811; O2=19812; O3=19813; DEAD=19819
OK=0; FAIL=0; PIDS=()
check() { if (set +o pipefail; eval "$2"); then OK=$((OK+1)); echo "  ok   $1"; else FAIL=$((FAIL+1)); echo "  FALLO $1"; fi; }
cleanup() { for p in "${PIDS[@]}"; do kill "$p" 2>/dev/null; done; wait 2>/dev/null; rm -rf "$W"; }
trap cleanup EXIT
wait_port() { for _ in $(seq 60); do curl -sk -o /dev/null "$1" && return 0; sleep 0.1; done; return 1; }

bash scripts/gen-dev-cert.sh "$W/ocert" localhost >/dev/null       # certificado del origen HTTPS
bash scripts/gen-dev-cert.sh "$W/certs" ejemplo.com >/dev/null     # certificado de la caché (SSL termination)
ORIGIN_PORT=$O1 ORIGIN_NAME=web  node tests/origin.mjs >"$W/o1.log" 2>&1 & PIDS+=($!)
ORIGIN_PORT=$O2 ORIGIN_NAME=java node tests/origin.mjs >"$W/o2.log" 2>&1 & PIDS+=($!)
ORIGIN_PORT=$O3 ORIGIN_NAME=ext ORIGIN_TLS_CERT="$W/ocert/dev.crt" ORIGIN_TLS_KEY="$W/ocert/dev.key" \
  node tests/origin.mjs >"$W/o3.log" 2>&1 & PIDS+=($!)
wait_port http://127.0.0.1:$O1/stats && wait_port http://127.0.0.1:$O2/stats && wait_port https://127.0.0.1:$O3/stats \
  || { echo "los orígenes no arrancaron"; cat "$W"/o*.log; exit 1; }

KEYHASH=$(printf '%s' 'clave-demo' | sha256sum | cut -d' ' -f1)
pol() { # dominio de 250 bytes con una sola política, para ver a quién expulsa
  printf '{"domain":"%s","origin":"http://127.0.0.1:%s","maxCacheBytes":250,"urls":[{"pattern":"/*","auth":{"mode":"none"},"fileTypes":[{"ext":"*","ttl":600,"policy":"%s"}]}]}' "$1" "$O1" "$2"; }
cat >"$W/config.json" <<EOF
{ "domains": [
  { "domain": "ejemplo.com", "origin": "http://127.0.0.1:$O1", "maxCacheBytes": 1048576,
    "urls": [
      { "pattern": "/*", "auth": { "mode": "none" },
        "fileTypes": [ { "ext": "html", "ttl": 60, "policy": "LRU" }, { "ext": "png", "ttl": 600, "policy": "LFU" },
                       { "ext": "txt", "ttl": 60, "policy": "FIFO" } ] },
      { "pattern": "/api/*", "origin": "http://127.0.0.1:$O2", "auth": { "mode": "apikey", "apiKeyHashes": ["$KEYHASH"] },
        "fileTypes": [ { "ext": "json", "ttl": 20, "policy": "MRU" } ] },
      { "pattern": "/corto/*", "auth": { "mode": "none" }, "fileTypes": [ { "ext": "*", "ttl": 1, "policy": "LRU" } ] }
    ] },
  { "domain": "externo-https.com", "origin": "https://localhost:$O3", "maxCacheBytes": 1048576,
    "urls": [ { "pattern": "/*", "auth": { "mode": "none" }, "fileTypes": [ { "ext": "*", "ttl": 60, "policy": "RANDOM" } ] } ] },
  { "domain": "caido.com", "origin": "http://127.0.0.1:$DEAD", "maxCacheBytes": 1048576,
    "urls": [ { "pattern": "/*", "auth": { "mode": "none" }, "fileTypes": [ { "ext": "*", "ttl": 60, "policy": "LRU" } ] } ] },
  $(pol lru.test LRU), $(pol lfu.test LFU), $(pol fifo.test FIFO), $(pol mru.test MRU), $(pol random.test RANDOM)
] }
EOF

ZC_CONFIG_FILE="$W/config.json" ZC_ZONE=cr ZC_CACHE_DIR="$W/cache" ZC_HTTP_PORT=$HP ZC_HTTPS_PORT=$SP \
ZC_TLS_CERT_FILE="$W/certs/dev.crt" ZC_TLS_KEY_FILE="$W/certs/dev.key" ZC_COOKIE_SECURE=0 \
ZC_ORIGIN_CA_FILE="$W/ocert/dev.crt" ZC_ORIGIN_TIMEOUT_SECS=5 "$BIN" >"$W/zc.log" 2>&1 & ZC=$!; PIDS+=($ZC)
wait_port http://127.0.0.1:$HP/__zc/healthz || { echo "la caché no arrancó"; cat "$W/zc.log"; exit 1; }

U=http://127.0.0.1:$HP
G() { curl -s -H "Host: $1" "${@:3}" "$U$2"; }                               # cuerpo
D() { curl -s -D - -o /dev/null -H "Host: $1" "${@:3}" "$U$2" | tr -d '\r'; }  # encabezados
C() { curl -s -o /dev/null -w '%{http_code}' -H "Host: $1" "${@:3}" "$U$2"; }  # código
XC() { D "$@" | sed -n 's/^X-Cache: //p'; }
HITS() { curl -s "http://127.0.0.1:$O1/stats" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]||0))' "$1"; }

echo "== Salud y configuración"
check "/__zc/healthz responde zona y dominios"  'G x /__zc/healthz | grep -q "\"zone\":\"cr\",\"domains\":8"'

echo "== HIT / MISS con contenido REAL del origen (Apache / sitio HTTP)"
check "1a vez = MISS"                           '[ "$(XC ejemplo.com /index.html)" = MISS ]'
check "2a vez = HIT"                            '[ "$(XC ejemplo.com /index.html)" = HIT ]'
check "el HIT no vuelve a ir al origen"         '[ "$(HITS /index.html)" = 1 ]'
check "el cuerpo viene del origen real"         'G ejemplo.com /index.html | grep -q "origen=web ruta=/index.html visita=1"'
check "Content-Type se conserva en el HIT"      'D ejemplo.com /index.html | grep -qi "^Content-Type: text/html; charset=utf-8"'
G ejemplo.com /img/logo.png -o "$W/a.png"; G ejemplo.com /img/logo.png -o "$W/b.png"
check "binario (png) intacto desde disco"       'cmp -s "$W/a.png" "$W/b.png" && [ "$(XC ejemplo.com /img/logo.png)" = HIT ] && head -c 4 "$W/b.png" | grep -q PNG'
check "política por tipo: png = LFU"            'D ejemplo.com /img/logo.png | grep -q "^X-ZC-Policy: LFU"'
check "objeto guardado en disco"                '[ $(ls "$W/cache/ejemplo.com" | grep -vc index.zc) -ge 2 ]'
check "query distinta = otra entrada"           '[ "$(XC ejemplo.com "/index.html?v=2")" = MISS ]'
check "tipo no configurado (.css) = BYPASS"     '[ "$(XC ejemplo.com /estilo.css)" = BYPASS ] && [ "$(XC ejemplo.com /estilo.css)" = BYPASS ]'
check "404 del origen se pasa y no se guarda"   '[ "$(C ejemplo.com /status/404.txt)" = 404 ] && [ "$(XC ejemplo.com /status/404.txt)" = BYPASS ]'
check "HEAD de un objeto en caché = HIT"        'curl -s -I -H "Host: ejemplo.com" $U/index.html | tr -d "\r" | grep -q "^X-Cache: HIT"'
check "gzip del origen se guarda descomprimido" '[ "$(G ejemplo.com /gzip.txt | wc -l)" = 20 ] && [ "$(G ejemplo.com /gzip.txt | wc -l)" = 20 ] && [ "$(XC ejemplo.com /gzip.txt)" = HIT ]'
check "Location absoluta del origen -> relativa" 'D ejemplo.com /redirect | grep -q "^Location: /index.html"'

echo "== TTL"
check "TTL 1 s: MISS, HIT"                      '[ "$(XC ejemplo.com /corto/a.txt)" = MISS ] && [ "$(XC ejemplo.com /corto/a.txt)" = HIT ]'
sleep 2.2
check "TTL vencido = MISS otra vez"             '[ "$(XC ejemplo.com /corto/a.txt)" = MISS ]'

echo "== REST API (x-api-key, verbos, origen propio de la URL)"
check "sin x-api-key = 401"                     '[ "$(C ejemplo.com /api/items.json)" = 401 ]'
check "con key va al origen java"               'G ejemplo.com /api/items.json -H "x-api-key: clave-demo" | grep -q "\"origin\":\"java\""'
check "GET json con key: HIT y MRU"             'D ejemplo.com /api/items.json -H "x-api-key: clave-demo" | grep -q "^X-Cache: HIT" && D ejemplo.com /api/items.json -H "x-api-key: clave-demo" | grep -q "^X-ZC-Policy: MRU"'
check "respuesta autenticada = private"         'D ejemplo.com /api/items.json -H "x-api-key: clave-demo" | grep -q "^Cache-Control: private"'
check "POST llega con su cuerpo y no se cachea" 'G ejemplo.com /api/items.json -H "x-api-key: clave-demo" -X POST -d "nombre=bici&precio=10" | grep -q "\"method\":\"POST\",\"path\":\"/api/items.json\",\"body\":\"nombre=bici&precio=10\"" && [ "$(XC ejemplo.com /api/items.json -H "x-api-key: clave-demo" -X POST -d x)" = BYPASS ]'
check "POST devuelve 201 del origen"            '[ "$(C ejemplo.com /api/items.json -H "x-api-key: clave-demo" -X POST -d x)" = 201 ]'
check "PUT llega al origen"                     'G ejemplo.com /api/items/1.json -H "x-api-key: clave-demo" -X PUT -d "nuevo" | grep -q "\"method\":\"PUT\".*\"body\":\"nuevo\""'
check "DELETE llega al origen"                  'G ejemplo.com /api/items/1.json -H "x-api-key: clave-demo" -X DELETE | grep -q "\"method\":\"DELETE\""'
BIG=$(head -c 3000 /dev/zero | tr '\0' 'a')
check "POST con Expect: 100-continue (3 KB)"    'G ejemplo.com /api/big.json -H "x-api-key: clave-demo" -H "Expect: 100-continue" -X POST --data-binary "$BIG" | grep -q "\"body\":\"aaaa"'
check "x-api-key NO se reenvía al origen"       '! G ejemplo.com /api/echo/headers -H "x-api-key: clave-demo" | grep -qi "x-api-key"'
H=$(G ejemplo.com /echo/headers -H "Cookie: tema=oscuro; zc_session=secreto; zc_csrf=abc")
check "zc_session/zc_csrf NO llegan al origen"  '! printf "%s" "$H" | grep -q "secreto\|zc_csrf"'
check "otras cookies SÍ llegan al origen"       'printf "%s" "$H" | grep -q "tema=oscuro"'
check "X-Forwarded-For/Proto/Host al origen"    'printf "%s" "$H" | grep -q "\"x-forwarded-for\":\"127.0.0.1\"" && printf "%s" "$H" | grep -q "\"x-forwarded-host\":\"ejemplo.com\""'
check "Host hacia el origen = el del origen"    'printf "%s" "$H" | grep -q "\"host\":\"127.0.0.1:$O1\""'

echo "== Sitio externo HTTPS como origen + SSL termination en la caché"
check "origen HTTPS: MISS y luego HIT"          '[ "$(XC externo-https.com /pagina.html)" = MISS ] && [ "$(XC externo-https.com /pagina.html)" = HIT ]'
check "contenido del origen HTTPS"              'G externo-https.com /pagina.html | grep -q "origen=ext"'
check "cliente por HTTPS (SSL termination)"     'curl -sk --connect-to ejemplo.com:$SP:127.0.0.1:$SP https://ejemplo.com:$SP/index.html | grep -q "origen=web"'
check "HTTPS negocia TLS >= 1.2"                'curl -skv --connect-to ejemplo.com:$SP:127.0.0.1:$SP https://ejemplo.com:$SP/index.html 2>&1 | grep -Eq "TLSv1\.[23]"'
check "X-Forwarded-Proto=https al origen"       'curl -sk --connect-to ejemplo.com:$SP:127.0.0.1:$SP https://ejemplo.com:$SP/echo/headers | grep -q "\"x-forwarded-proto\":\"https\""'

echo "== Errores y modos de uso"
check "origen caído = 502"                      '[ "$(C caido.com /x.html)" = 502 ]'
check "dominio no registrado = 404"             '[ "$(C noexiste.com /)" = 404 ]'
check "Transfer-Encoding chunked = 411"         '[ "$(C ejemplo.com /api/x.json -H "x-api-key: clave-demo" -H "Transfer-Encoding: chunked" -X POST --data-binary @/dev/null)" = 411 ]'
check "modo proxy explícito (curl -x)"          'curl -s --noproxy "" -x http://127.0.0.1:$HP http://ejemplo.com/index.html | grep -q "origen=web"'

echo "== Políticas de reemplazo con disco real (dominio de 250 B, objetos de 100 B)"
F() { G "$1" "/fixed/$2?size=100" -o /dev/null; }
# a, b entran; se usa 'a' (o 'b' en MRU); al entrar 'c' debe salir la víctima de cada política
F lru.test a; F lru.test b; F lru.test a; F lru.test c
check "LRU expulsa el menos reciente (b)"       '[ "$(XC lru.test "/fixed/a?size=100")" = HIT ] && [ "$(XC lru.test "/fixed/b?size=100")" = MISS ]'
F lfu.test a; F lfu.test b; F lfu.test a; F lfu.test a; F lfu.test c
check "LFU expulsa el menos usado (b)"          '[ "$(XC lfu.test "/fixed/a?size=100")" = HIT ] && [ "$(XC lfu.test "/fixed/b?size=100")" = MISS ]'
F fifo.test a; F fifo.test b; F fifo.test a; F fifo.test c
check "FIFO expulsa el primero que entró (a)"   '[ "$(XC fifo.test "/fixed/b?size=100")" = HIT ] && [ "$(XC fifo.test "/fixed/a?size=100")" = MISS ]'
F mru.test a; F mru.test b; F mru.test b; F mru.test c
check "MRU expulsa el más reciente (b)"         '[ "$(XC mru.test "/fixed/a?size=100")" = HIT ] && [ "$(XC mru.test "/fixed/b?size=100")" = MISS ]'
for i in 1 2 3 4 5 6 7 8; do F random.test r$i; done
check "RANDOM: el dominio no pasa de 250 B"     '[ "$(D random.test "/fixed/r8?size=100" | sed -n "s/^X-ZC-Domain-Bytes: //p")" -le 250 ]'
check "RANDOM: en disco quedan <= 2 objetos"    '[ $(ls "$W/cache/random.test" | grep -vc index.zc) -le 2 ]'
check "objeto mayor que el dominio no se guarda" '[ "$(XC lru.test "/fixed/z?size=400")" = MISS-NOSTORE ]'

echo "== Concurrencia (20 peticiones simultáneas)"
CP=(); for i in $(seq 20); do curl -s -o "$W/par$i" -H "Host: ejemplo.com" "$U/par.html" & CP+=($!); done; wait "${CP[@]}"
check "20 respuestas completas en paralelo"     '[ $(cat "$W"/par* | grep -c "ruta=/par.html") = 20 ]'

echo "== Apagado ordenado"
kill -TERM $ZC; wait $ZC 2>/dev/null
check "índices guardados al apagar (SIGTERM)"   '[ -s "$W/cache/ejemplo.com/index.zc" ] && [ -s "$W/cache/lru.test/index.zc" ]'

echo; echo "e2e-proxy: $OK ok, $FAIL fallos"
[ $FAIL = 0 ]
