#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Pruebas de integración del DNS API contra el emulador de Firebase.
#
# Requisitos:
#   - Emuladores corriendo:  cd firebase && firebase emulators:start
#   - DNS API corriendo:     cd "DNS API" && docker compose up --build
#   - curl, base64 y od (vienen en Linux, macOS y Git Bash)
#
# Uso:
#   ./tests/pruebas_integracion.sh
#
# Variables opcionales (valores por defecto entre paréntesis):
#   API_URL (http://localhost:8080)   DB_URL (http://127.0.0.1:9000)
#   AUTH_URL (http://127.0.0.1:9099)  NS (p1-redes-a87a7-default-rtdb)
#   FIREBASE_EMAIL / FIREBASE_PASSWORD: deben ser los mismos del .env del DNS API
# -----------------------------------------------------------------------------
set -u

API_URL="${API_URL:-http://localhost:8080}"
DB_URL="${DB_URL:-http://127.0.0.1:9000}"
AUTH_URL="${AUTH_URL:-http://127.0.0.1:9099}"
NS="${NS:-p1-redes-a87a7-default-rtdb}"
API_KEY="${API_KEY:-fake-api-key}"
FIREBASE_EMAIL="${FIREBASE_EMAIL:-dns-api@test.com}"
FIREBASE_PASSWORD="${FIREBASE_PASSWORD:-secreto123}"

# Consulta DNS tipo A para google.com con ID 0x1234 (en BASE64)
DNS_QUERY_B64="EjQBAAABAAAAAAAABmdvb2dsZQNjb20AAAEAAQ=="

PASS=0
FAIL=0

ok()   { echo "  [OK]    $1"; PASS=$((PASS + 1)); }
fail() { echo "  [FALLA] $1"; echo "          $2"; FAIL=$((FAIL + 1)); }

# check "<nombre>" <status esperado> "<texto esperado en el body>" <args de curl...>
check() {
    local name="$1" expected_status="$2" expected_text="$3"
    shift 3
    local out status body
    out=$(curl -s -m 10 -w $'\n%{http_code}' "$@")
    status="${out##*$'\n'}"
    body="${out%$'\n'*}"
    if [[ "$status" == "$expected_status" && "$body" == *"$expected_text"* ]]; then
        ok "$name"
    else
        fail "$name" "esperado HTTP $expected_status con '$expected_text'; recibido HTTP $status: $body"
    fi
}

echo "== 0. Preparación del emulador =="

# Registros de prueba (PATCH mezcla con lo que ya exista; "Bearer owner" solo funciona en el emulador)
curl -s -o /dev/null -X PATCH "$DB_URL/dnsRecords.json?ns=$NS" \
  -H "Authorization: Bearer owner" \
  -d '{
    "record-tcp-001": {"hostname": "local-tcp.test", "type": "single", "enabled": true,
      "targets": {"target-001": {"address": "127.0.0.1", "port": 8081,
        "healthCheck": {"protocol": "tcp", "timeoutMs": 2000, "retries": 2, "intervalSeconds": 30}}}},
    "record-test-disabled": {"hostname": "apagado.test", "type": "single", "enabled": false,
      "targets": {"target-001": {"address": "10.0.0.1", "port": 80}}}
  }' && echo "  registros de prueba cargados"

# Registros de cada tipo, Health Checkers, resultados e IP-to-Country simulados (tests/datos_prueba.json)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
curl -s -o /dev/null -X PATCH "$DB_URL/.json?ns=$NS" \
  -H "Authorization: Bearer owner" \
  --data-binary @"$SCRIPT_DIR/datos_prueba.json" && echo "  datos de prueba de los 5 tipos cargados"

# Usuario del DNS API (si ya existe, el emulador responde EMAIL_EXISTS y seguimos)
curl -s -o /dev/null -X POST "$AUTH_URL/identitytoolkit.googleapis.com/v1/accounts:signUp?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$FIREBASE_EMAIL\",\"password\":\"$FIREBASE_PASSWORD\",\"returnSecureToken\":true}"
echo "  usuario $FIREBASE_EMAIL listo"

echo
echo "== 1. Firebase directo (sin Java) =="
TOKEN=$(curl -s -X POST "$AUTH_URL/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=$API_KEY" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$FIREBASE_EMAIL\",\"password\":\"$FIREBASE_PASSWORD\",\"returnSecureToken\":true}" \
  | sed -n 's/.*"idToken": *"\([^"]*\)".*/\1/p')
if [[ -n "$TOKEN" ]]; then ok "login en Firebase Auth"; else fail "login en Firebase Auth" "no se obtuvo idToken"; fi

check "consulta por hostname en Realtime Database" 200 '"local-tcp.test"' -G "$DB_URL/dnsRecords.json" \
  --data-urlencode 'orderBy="hostname"' --data-urlencode 'equalTo="local-tcp.test"' \
  --data-urlencode "ns=$NS" --data-urlencode "auth=$TOKEN"

echo
echo "== 2. DNS API: /health y /api/exists =="
check "GET /health" 200 '"UP"' "$API_URL/health"

post_exists() { curl_args=(-X POST "$API_URL/api/exists" -H "Content-Type: application/json" -d "$1"); }

post_exists '{"domain":"local-tcp.test"}'
check "dominio existente -> exists:true" 200 '"exists":true' "${curl_args[@]}"
post_exists '{"domain":"LOCAL-TCP.test."}'
check "mayúsculas y punto final -> exists:true" 200 '"exists":true' "${curl_args[@]}"
post_exists '{"domain":"no-existe.test"}'
check "dominio inexistente -> exists:false" 200 '"exists":false' "${curl_args[@]}"
post_exists '{"domain":"apagado.test"}'
check "registro con enabled:false -> exists:false" 200 '"exists":false' "${curl_args[@]}"
post_exists '{}'
check "sin campo domain -> 400" 400 'domain' "${curl_args[@]}"
post_exists 'esto no es json'
check "JSON inválido -> 400" 400 'error' "${curl_args[@]}"

echo
echo "== 3. DNS API: /api/records/{hostname} (Interceptor, diseño B) =="
check "registro inexistente -> 404 found:false" 404 '"found":false' "$API_URL/api/records/no-existe.test"
check "registro deshabilitado -> 404" 404 '"found":false' "$API_URL/api/records/apagado.test"
check "single: tipo y TTL" 200 '"type":"single","ttl":30' "$API_URL/api/records/single.test"
check "single: hostname normalizado" 200 '"recordId":"prueba-single"' "$API_URL/api/records/SINGLE.test."
check "multi: 3 targets, 2 healthy" 200 '"healthyTargetCount":2' "$API_URL/api/records/multi.test"
check "multi: t3 marcado unhealthy" 200 '"id":"t3","address":"10.0.1.3","port":80,"healthy":false,"healthStatus":"unhealthy"' "$API_URL/api/records/multi.test"
check "weight: incluye pesos" 200 '"address":"10.0.2.1","port":80,"healthy":true,"healthStatus":"unknown","weight":3' "$API_URL/api/records/weight.test"
check "geo: cliente 127.0.0.1 -> CR" 200 '"countryCode":"CR"' "$API_URL/api/records/geo.test?sourceIp=127.0.0.1"
check "geo: cliente 8.8.8.8 -> US" 200 '"countryCode":"US"' "$API_URL/api/records/geo.test?sourceIp=8.8.8.8"
check "geo: IP fuera de rangos -> found:false" 200 '"client":{"ip":"200.1.1.1","found":false}' "$API_URL/api/records/geo.test?sourceIp=200.1.1.1"
check "round-trip desde CR: t1 15 ms (Cartago)" 200 '"latencyMs":15.0,"latencySource":"nearest-checker","latencyCheckerId":"prueba-checker-cartago"' "$API_URL/api/records/rtt.test?sourceIp=127.0.0.1"
check "round-trip desde US: t2 10 ms (Miami)" 200 '"latencyMs":10.0,"latencySource":"nearest-checker","latencyCheckerId":"prueba-checker-miami"' "$API_URL/api/records/rtt.test?sourceIp=8.8.8.8"
check "target caído en todos los checkers -> 0 healthy" 200 '"healthyTargetCount":0' "$API_URL/api/records/down.test"

echo
echo "== 3b. IP-to-Country =="
check "lookup 8.8.8.8 -> US" 200 '"countryCode":"US"' "$API_URL/api/ip-to-country/lookup?ip=8.8.8.8"
check "lookup con IP inválida -> 400" 400 'error' "$API_URL/api/ip-to-country/lookup?ip=no-es-ip"

echo
echo "== 3c. Endpoints para la DNS UI =="
check "GET /api/ui/summary" 200 '"recordsByType"' "$API_URL/api/ui/summary"
check "GET /api/ui/records incluye los de prueba" 200 '"id":"prueba-multi"' "$API_URL/api/ui/records"
check "GET /api/ui/records/{id} estado degraded" 200 '"status":"degraded"' "$API_URL/api/ui/records/prueba-multi"
check "GET /api/ui/records/{id} inexistente -> 404" 404 'error' "$API_URL/api/ui/records/no-existe"
check "GET /api/ui/health-checkers" 200 '"id":"prueba-checker-cartago"' "$API_URL/api/ui/health-checkers"
check "GET /api/ui/ip-to-country" 200 '"items"' "$API_URL/api/ui/ip-to-country?limit=10"
check "GET /api/ui/record-types" 200 '"round-trip"' "$API_URL/api/ui/record-types"
if curl -s -m 10 -D - -o /dev/null "$API_URL/api/ui/summary" | grep -qi '^access-control-allow-origin:'; then
    ok "CORS habilitado para la UI"
else
    fail "CORS habilitado para la UI" "no se recibió el header Access-Control-Allow-Origin"
fi

echo
echo "== 4. DNS API: /api/dns_resolver =="
RESP=$(curl -s -m 10 -X POST "$API_URL/api/dns_resolver" -H "Content-Type: application/json" \
  -d "{\"data\":\"$DNS_QUERY_B64\"}")
DATA=$(echo "$RESP" | sed -n 's/.*"data":"\([^"]*\)".*/\1/p')
HEADER=$(echo "$DATA" | base64 -d 2>/dev/null | od -An -tx1 -N4 | tr -d ' \n')
# 1234 = mismo ID de la consulta; 81 = QR=1 (es respuesta) + RD; último dígito 0 -> RCODE=0 (sin error)
if [[ "${HEADER:0:6}" == "123481" && "${HEADER:7:1}" == "0" ]]; then
    ok "respuesta DNS válida (header $HEADER)"
else
    fail "respuesta DNS válida" "header recibido '$HEADER', respuesta: $RESP"
fi

post_resolver() { curl_args=(-X POST "$API_URL/api/dns_resolver" -H "Content-Type: application/json" -d "$1"); }
post_resolver '{"data":"%%%no-es-base64%%%"}'
check "BASE64 inválido -> 400" 400 'BASE64' "${curl_args[@]}"
post_resolver '{}'
check "sin campo data -> 400" 400 'data' "${curl_args[@]}"

echo
echo "== 5. Concurrencia: 50 peticiones simultáneas a /api/dns_resolver =="
CODES=$(seq 50 | xargs -P 50 -I{} curl -s -m 15 -o /dev/null -w "%{http_code}\n" -X POST \
  "$API_URL/api/dns_resolver" -H "Content-Type: application/json" \
  -d "{\"data\":\"$DNS_QUERY_B64\"}" | sort | uniq -c | tr -s ' ')
if [[ "$CODES" == " 50 200" ]]; then ok "50/50 respondieron 200"; else fail "50 peticiones concurrentes" "códigos: $CODES"; fi

echo
echo "== Resultado: $PASS correctas, $FAIL fallidas =="
[[ $FAIL -eq 0 ]]
