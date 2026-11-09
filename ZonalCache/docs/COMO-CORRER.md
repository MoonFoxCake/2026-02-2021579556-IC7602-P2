# Zonal Cache — cómo correr y probar

La Zonal Cache es un **proxy HTTP/HTTPS con caché en disco**, escrito en GNU C. Recibe la petición del cliente
(que llegó a su IP gracias al DNS Interceptor), valida la seguridad configurada en Firebase, sirve el recurso desde
disco si lo tiene vigente y, si no, lo pide al origen real (REST API, Apache o un sitio externo HTTP/HTTPS), lo
guarda y lo entrega.

Diagrama editable: [`docs/arquitectura.drawio`](../../docs/arquitectura.drawio) (raíz del repo).

| Pieza | Archivo | Qué hace |
|---|---|---|
| Servidor real | `src/zonal_cache.c` | Sockets TCP (80/443 en el clúster; 8080/8443 dentro del pod), un hilo por conexión, HTTP/1.1, SSL termination, proxy con libcurl, objetos en disco |
| Biblioteca | `p3/*.c` (`libzc_p3.a`) | Políticas LRU/LFU/FIFO/MRU/Random, TTL, límites, `x-api-key`, usuario/contraseña con sesión, TLS/SNI, config desde el API |
| Demo de la Persona 3 | `tools/zc_p3_demo.c` | Servidor de prueba con origen simulado (ya no se usa en la imagen; se conserva para `make e2e-demo`) |
| Imagen | `Dockerfile` | Compila, corre las pruebas unitarias y empaqueta `zonal-cache` (usuario no root) |
| Helm | `helm/zonal-cache` | Una release por zona (`zc-cr`, `zc-us`): Deployment + PVC + Service + ConfigMap |
| Despliegue | `scripts/deploy-k8s.sh` | Imagen + Secrets + `helm upgrade --install` de todas las zonas, en un solo comando |

---

## 1. Requisitos

Ubuntu 22.04/24.04 o WSL2:

```bash
sudo apt-get install -y build-essential libcurl4-openssl-dev libssl-dev openssl curl dnsutils
# Node.js 18 o superior (para el API y los orígenes de prueba)
```

Para Kubernetes: Docker, `kubectl`, `helm` 3 y `minikube` (o cualquier clúster).

## 2. Compilar y correr todas las pruebas automáticas

```bash
cd api-nodejs && npm install && npm test && cd ..     # 9 pruebas del API (caché + DNS)
cd ZonalCache
make            # zonal-cache (servidor real) + libzc_p3.a + demo
make check      # unitarias + 4 suites de punta a punta (≈ 1 minuto)
```

| Comando | Pruebas | Qué demuestra |
|---|---|---|
| `make test` | 342 comprobaciones en 7 suites C | Políticas, config, auth, TLS, refresco, registro de dominios, gate |
| `make e2e` | 29 | Servidor real + mock del API: HIT/MISS, `x-api-key`, login con CSRF, sesión, logout, rate limit, HTTPS, login por UI con ticket, límite por URL, reinicio conservando la caché |
| `make e2e-proxy` | 49 | Proxy contra **orígenes reales** HTTP y HTTPS: contenido y Content-Type desde disco, binarios, gzip, GET/POST/PUT/DELETE, `Expect: 100-continue`, filtrado de `x-api-key` y cookies de sesión, `X-Forwarded-*`, TTL, las 5 políticas expulsando en disco, 502/404/411, modo proxy explícito, 20 peticiones concurrentes, apagado ordenado |
| `make e2e-api` | 16 | Servidor real ⇄ router real de `api-nodejs` (dominios sin verificar, hash de keys, bcrypt, origen por URL) |
| `make e2e-sistema` | 11 | **Sistema completo:** `dig` → DNS Interceptor (`dns.c`) → `/api/records` → IP de la caché de la zona (cr/us según IP del cliente) → caché → origen |
| `make e2e-demo` | 29 | Las pruebas de `make e2e` contra el demo de la Persona 3 |

Cada suite imprime una línea por prueba (`ok` / `FALLO`) y el total al final.

---

## 3. Correr a mano y probar cada requisito del enunciado

Sin Firebase ni Kubernetes: la caché lee `docs/config-local.json` y los orígenes son servidores Node de prueba.
Abra **cuatro terminales** en `ZonalCache/`.

```bash
# Terminal 1 — orígenes: "web" hace de Apache (9800) y "java" hace de REST API (9801)
ORIGIN_PORT=9800 ORIGIN_NAME=web node tests/origin.mjs & ORIGIN_PORT=9801 ORIGIN_NAME=java node tests/origin.mjs

# Terminal 2 — verificador de usuario/contraseña (imita /api/cache/verify-credentials; usuario kevin / s3creto)
MOCK_PORT=9900 MOCK_TOKEN=token-local node tests/mock-api.mjs

# Terminal 3 — la caché (HTTP 8080, HTTPS 8443)
bash scripts/gen-dev-cert.sh ./certs ejemplo.com
ZC_ZONE=cr ZC_CONFIG_FILE=docs/config-local.json ZC_CACHE_DIR=/tmp/zc ZC_COOKIE_SECURE=0 \
ZC_VERIFY_URL=http://127.0.0.1:9900 ZC_VERIFY_TOKEN=token-local ZC_LOGIN_MODE=local \
ZC_TLS_CERT_FILE=certs/dev.crt ZC_TLS_KEY_FILE=certs/dev.key ./zonal-cache
```

En la **terminal 4** se prueba. Para no tocar `/etc/hosts`, `curl --connect-to` manda `ejemplo.com` a `127.0.0.1`
(equivale a lo que hace el DNS Interceptor):

```bash
C="--connect-to ejemplo.com:8080:127.0.0.1:8080 --connect-to ejemplo.com:8443:127.0.0.1:8443"
B=http://ejemplo.com:8080
```

Cada respuesta trae encabezados de diagnóstico: `X-Cache` (`HIT`, `MISS`, `BYPASS` = no cacheable,
`MISS-NOSTORE` = no cupo), `X-ZC-Zone`, `X-ZC-Rule` (patrón de URL que aplicó), `X-ZC-Policy`, `X-ZC-TTL`
y `X-ZC-Domain-Bytes` (bytes que ocupa el dominio en disco). La terminal 3 imprime una línea por petición.

### R1. Flujo: seguridad → caché → origen → guardar → servir

```bash
curl -si $C $B/index.html | grep -E "^HTTP|X-Cache|X-ZC-Rule|origen="   # 200, X-Cache: MISS, "origen=web ... visita=1"
curl -si $C $B/index.html | grep -E "X-Cache|origen="                     # X-Cache: HIT, sigue "visita=1" (no fue al origen)
curl -s http://127.0.0.1:9800/stats                                       # {"/index.html":1}
```

### R2. Caché en disco y tamaño máximo por dominio

```bash
ls -l /tmp/zc/ejemplo.com/          # un archivo por objeto (nombre = SHA-256) + index.zc (metadatos de políticas)
head -2 /tmp/zc/ejemplo.com/<archivo>   # "ZC1" y el Content-Type; luego el cuerpo
curl -si $C $B/index.html | grep X-ZC-Domain-Bytes   # nunca supera maxCacheBytes del dominio
```

Si un objeto no cabe en `maxCacheBytes` (dominio) o en `cacheBytes` (URL), se expulsan entradas con la política
del tipo de archivo; si aun así no cabe, se sirve sin guardar (`MISS-NOSTORE`). La prueba con números exactos
está en `make e2e-proxy` (sección "Políticas de reemplazo").

### R3. Las cinco políticas de reemplazo

Cada tipo de archivo de una URL tiene su política (`docs/config-local.json`: html=LRU, png=LFU, txt=FIFO,
`/api/*` json=MRU, `/privado/*`=RANDOM):

```bash
for p in /index.html /logo.png /nota.txt; do curl -s -D - -o /dev/null $C $B$p | grep X-ZC-Policy; done   # LRU, LFU, FIFO
```

Para **ver** a quién expulsa cada política, `make e2e-proxy` arma dominios de 250 B con objetos de 100 B: entran
`a` y `b`, se usa uno, entra `c`, y se comprueba cuál salió (LRU → el menos reciente, LFU → el menos usado,
FIFO → el primero en entrar, MRU → el más reciente, RANDOM → cualquiera sin pasar el límite).

### R4. Tipos de archivo y TTL

```bash
curl -si $C $B/estilo.css | grep X-Cache     # BYPASS: .css no está configurado => proxy sin cachear
curl -si $C $B/nota.txt   | grep X-ZC-TTL    # 30 (configurado para txt)
# Después de que vence el TTL, la siguiente petición vuelve a ser MISS y se pide de nuevo al origen.
```

### R5. Autenticación con `x-api-key`

```bash
curl -si $C $B/api/items.json | head -1                              # 401 Unauthorized
curl -si $C -H "x-api-key: incorrecta" $B/api/items.json | head -1   # 401
curl -si $C -H "x-api-key: clave-demo" $B/api/items.json | grep -E "^HTTP|X-Cache|Cache-Control|origin"
#   200, MISS y luego HIT, Cache-Control: private, cuerpo {"origin":"java",...} => fue a SU origen (REST API)
curl -s  $C -H "x-api-key: clave-demo" $B/api/echo/headers   # el origen NO recibe x-api-key
```

La caché guarda solo el **SHA-256** de cada key (lo que entrega el API) y compara en tiempo constante.

### R6. Usuario y contraseña, sesión en peticiones posteriores y cerrar sesión

```bash
curl -si $C $B/privado/a.txt | grep -E "^HTTP|Location"     # 302 a /__zc/login?return_to=%2Fprivado%2Fa.txt
FORM=$(curl -s -c jar $C "$B/__zc/login?return_to=%2Fprivado%2Fa.txt")
CSRF=$(echo "$FORM" | sed -n 's/.*name="csrf" value="\([0-9a-f]*\)".*/\1/p')
curl -si -b jar $C -d "username=kevin&password=mala&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login | head -1   # 401
curl -si -b jar -c jar $C -d "username=kevin&password=s3creto&return_to=/privado/a.txt&csrf=$CSRF" $B/__zc/login | grep -E "^HTTP|Set-Cookie"
#   302 + Set-Cookie: zc_session=...; HttpOnly; SameSite=Lax; Max-Age=3600
curl -si -b jar $C $B/privado/a.txt | grep -E "^HTTP|X-Cache"   # 200 con la sesión (petición posterior): MISS, luego HIT
curl -si -b jar -c jar $C $B/__zc/logout | grep -E "^HTTP|Max-Age=0"   # cerrar sesión
curl -si -b jar $C $B/privado/a.txt | head -1                    # 302 otra vez
```

- La contraseña la valida el API (`POST /api/cache/verify-credentials`, bcrypt en Firestore). Aquí lo hace el mock.
- Con `ZC_LOGIN_MODE=ui` la caché redirige al **formulario del UI** (`ZC_LOGIN_UI_URL`); el UI devuelve un ticket
  firmado a `/__zc/callback` y la caché crea la sesión. Ese flujo lo prueba `make e2e` ("Modo UI").
- Seis intentos fallidos seguidos desde la misma IP → `429`.
- El formulario lleva un token CSRF ligado a la cookie `zc_csrf`: por eso el intento fallido usa solo `-b jar` (si se
  guardara la respuesta con `-c jar`, el formulario nuevo reemplazaría el token y el siguiente intento daría 403).

### R7. SSL termination

```bash
curl -sk $C https://ejemplo.com:8443/index.html                          # mismo contenido por HTTPS
curl -skv $C https://ejemplo.com:8443/index.html 2>&1 | grep -E "SSL connection|subject"   # TLSv1.3, CN=ejemplo.com
curl -sk $C https://ejemplo.com:8443/echo/headers                        # el origen recibe X-Forwarded-Proto: https
```

El TLS termina en la caché; hacia el origen se usa HTTP o HTTPS según el `origin` configurado. Con
`ZC_TLS_CERT_DIR` hay un certificado por dominio (SNI).

### R8. Configuración desde Firebase

```bash
curl -s http://127.0.0.1:8080/__zc/healthz     # {"ok":true,"zone":"cr","domains":3}
```

Con el API real (sección 4) la caché descarga `GET /api/cache/config?zone=<zona>` cada `ZC_CONFIG_REFRESH_SECS`
(60 s). Para comprobarlo: cambie en Firestore/UI la política o el TTL de una URL, espere un minuto y vea el nuevo
`X-ZC-Policy`/`X-ZC-TTL`. Si el API falla, la caché conserva la última configuración buena.

### R9. Probar con un REST API, Apache, un sitio externo HTTP y uno HTTPS

| Origen | Cómo se prueba aquí | En el clúster |
|---|---|---|
| REST API | `/api/*` → origen "java" (R5; POST/PUT/DELETE abajo) | `origin` de la URL = `http://rest-api-java.default.svc.cluster.local:8080` |
| Apache | `/*` → origen "web" (R1) | `origin` = `http://apache-web.default.svc.cluster.local` |
| Externo HTTP | `curl -si -H "Host: externo-http.com" http://127.0.0.1:8080/` → `http://example.com` | igual |
| Externo HTTPS | `curl -si -H "Host: externo-https.com" http://127.0.0.1:8080/` → `https://example.com` | igual |

```bash
curl -s $C -H "x-api-key: clave-demo" -H "Content-Type: application/json" -X POST --data '{"name":"bike","price":10}' $B/api/items.json
curl -s $C -H "x-api-key: clave-demo" -H "Content-Type: application/json" -X PUT --data '{"price":12}' $B/api/items/1.json
curl -s $C -H "x-api-key: clave-demo" -X DELETE                 $B/api/items/1.json
curl -si -H "Host: externo-https.com" http://127.0.0.1:8080/ | grep -E "^HTTP|X-Cache|<title>"   # 200, MISS, "Example Domain"
```

Solo se cachean respuestas `200` de `GET`; los demás verbos y códigos pasan directo (`X-Cache: BYPASS`).
Para orígenes HTTPS se valida el certificado (`ZC_ORIGIN_TLS_VERIFY=1`); con CA propia use `ZC_ORIGIN_CA_FILE`.

---

## 4. Con el API Node.js real (Firestore)

```bash
# Terminal 1 — API (necesita el .env de Firebase; ver api-nodejs/README.md)
cd api-nodejs && SERVICE_KEY=una-clave-larga npm start          # http://127.0.0.1:3000

# Terminal 2 — caché leyendo la config de Firestore a través del API
cd ZonalCache && ZC_CONFIG_URL=http://127.0.0.1:3000 ZC_CONFIG_TOKEN=una-clave-larga ZC_ZONE=cr \
  ZC_CACHE_DIR=/tmp/zc ZC_COOKIE_SECURE=0 ./zonal-cache
```

Para que un dominio aparezca, en Firestore debe existir `domains/<dominio>` con `verified: true` y sus documentos
en `urls` (`pattern`, `origin`, `cacheSizeMB`, `fileTypes[{ext, ttlSeconds}]`, `replacementPolicy`, `authType`),
más `apiKeys` (`keyHash` = SHA-256) y `urlUsers` (`passwordHash` bcrypt) según el tipo de autenticación. El
modelo completo está en `api-nodejs/API.md`. Sin datos reales, `make e2e-api` prueba lo mismo con un almacén en memoria.

En Vercel configure `SERVICE_KEY` (= `ZC_CONFIG_TOKEN` de las cachés) y, para el DNS Interceptor, `ZONE_CACHES`,
`COUNTRY_ZONES` e `IP_COUNTRY_RANGES` (tabla en `api-nodejs/README.md`).

## 5. Docker

```bash
cd ZonalCache
docker build -t zonal-cache:dev .        # también corre las pruebas unitarias; si fallan no hay imagen
docker run --rm -p 8080:8080 -e ZC_ZONE=cr \
  -e ZC_CONFIG_URL=https://<api>.vercel.app -e ZC_CONFIG_TOKEN=<SERVICE_KEY> zonal-cache:dev
```

## 6. Kubernetes con Helm (minikube)

Para desplegar juntos el Interceptor, Java REST API, Apache y ambas zonas de caché, use el instalador de la raíz:

```bash
minikube start
# Mantener en otra terminal (puede requerir permisos elevados):
minikube tunnel
bash deploy/install.sh
```

El instalador requiere `ZonalCache/.env` (ver `.env.example`) y configura los charts del repo. Después se deben
copiar las IP de `zc-cr` y `zc-us` que imprime a `ZONE_CACHES` en Vercel; vea [`docs/KUBERNETES.md`](../../docs/KUBERNETES.md)
para la configuración del API/UI, orígenes internos, DNS y pruebas de sistema.

```bash
minikube start
cp ZonalCache/.env.example ZonalCache/.env      # complete ZC_CONFIG_URL y ZC_CONFIG_TOKEN
bash ZonalCache/scripts/deploy-k8s.sh           # imagen + Secrets (zc-secrets, zc-tls) + releases zc-cr y zc-us
minikube tunnel                                 # en otra terminal: da EXTERNAL-IP a cada Service LoadBalancer
kubectl get svc -l app.kubernetes.io/name=zonal-cache   # anote la EXTERNAL-IP de zc-cr y de zc-us
```

Luego, en Vercel (API): `ZONE_CACHES=cr=<ip zc-cr>,us=<ip zc-us>` y `COUNTRY_ZONES=CR=cr,*=us`.

Si el REST API Java y el Apache de la Persona 5 todavía no están en el clúster, un Apache temporal sirve para probar:

```bash
kubectl create deployment apache-web --image=httpd:2.4 && kubectl expose deployment apache-web --port=80
# origin de la URL en el UI/Firestore: http://apache-web.default.svc.cluster.local
```

Pruebas en el clúster:

```bash
IP=$(kubectl get svc zc-cr -o jsonpath='{.status.loadBalancer.ingress[0].ip}')
curl -s http://$IP/__zc/healthz                                       # zona cr y cantidad de dominios
curl -si --resolve ejemplo.com:80:$IP  http://ejemplo.com/index.html   # MISS, luego HIT
curl -sik --resolve ejemplo.com:443:$IP https://ejemplo.com/index.html # SSL termination
kubectl logs -f deploy/zc-cr                                          # una línea por petición
# Persistencia: el disco es un PVC y los índices se guardan al apagar
kubectl delete pod -l app.kubernetes.io/instance=zc-cr && kubectl rollout status deploy/zc-cr
curl -si --resolve ejemplo.com:80:$IP http://ejemplo.com/index.html | grep X-Cache   # HIT tras el reinicio
```

Con el DNS Interceptor, en lugar de `--resolve`: `nslookup ejemplo.com <ip-del-interceptor>` debe devolver la IP
de `zc-cr` para un cliente de CR (según `IP_COUNTRY_RANGES`), y luego `curl http://ejemplo.com/...` usando ese DNS.
Sin el chart del interceptor, se puede correr `dns.c` en la máquina: `DNS_API_URL=https://<api>.vercel.app ./dns --port 5353`
y `nslookup -port=5353 ejemplo.com 127.0.0.1` (lo mismo que automatiza `make e2e-sistema`).

Valores útiles del chart (`helm/zonal-cache/values.yaml`): `zone`, `config.url`, `login.mode`, `tls.enabled`,
`service.type`, `persistence.size`, `origin.timeoutSecs`, `origin.tlsVerify`, `origin.caSecretName`, `extraEnv`.

---

## 7. Variables de entorno del servidor

| Variable | Default | Uso |
|---|---|---|
| `ZC_CONFIG_URL` + `ZC_CONFIG_TOKEN` | — | API Node.js y su `SERVICE_KEY`. Alternativa: `ZC_CONFIG_FILE` (JSON local) |
| `ZC_ZONE` | — | Zona de esta caché (`cr`, `us`, …); se envía al API y sale en `X-ZC-Zone` |
| `ZC_CONFIG_REFRESH_SECS` | 60 | Refresco de la configuración |
| `ZC_CACHE_DIR` | — | Carpeta de objetos (en el pod, el PVC `/var/cache/zc`) |
| `ZC_HTTP_PORT` / `ZC_HTTPS_PORT` | 8080 / 8443 | HTTPS solo si hay `ZC_TLS_CERT_FILE` y `ZC_TLS_KEY_FILE` (`ZC_TLS_CERT_DIR` para SNI) |
| `ZC_BIND_ADDR` | todas | IPv4 donde escuchar (útil para varias zonas en una máquina) |
| `ZC_LOGIN_MODE` | local | `local` (formulario de la caché) o `ui` (`ZC_LOGIN_UI_URL` + `ZC_TICKET_SECRET`) |
| `ZC_VERIFY_URL` / `ZC_VERIFY_TOKEN` | = `ZC_CONFIG_*` | Dónde se validan usuario/contraseña |
| `ZC_SESSION_TTL_SECS`, `ZC_LOGIN_MAX_ATTEMPTS`, `ZC_LOGIN_WINDOW_SECS`, `ZC_COOKIE_SECURE` | 3600, 5, 300, 1 | Sesiones y rate limit |
| `ZC_ORIGIN_TIMEOUT_SECS` / `ZC_ORIGIN_CONNECT_TIMEOUT_SECS` | 30 / 10 | Tiempo máximo hacia el origen (504 / 502) |
| `ZC_ORIGIN_TLS_VERIFY` / `ZC_ORIGIN_CA_FILE` | 1 / — | Validación del certificado de orígenes HTTPS |
| `ZC_MAX_OBJECT_BYTES` / `ZC_MAX_REQUEST_BODY` | 50 MiB / 10 MiB | Respuesta máxima del origen / cuerpo máximo del cliente |
| `ZC_CLIENT_TIMEOUT_SECS` | 15 | Espera máxima leyendo al cliente |
| `ZC_STARTUP_RETRIES` | 30 | Reintentos (cada 2 s) si el API no responde al arrancar |
| `ZC_INDEX_SAVE_SECS` | 30 | Cada cuánto se guardan los índices (también al recibir SIGTERM) |

## 8. Problemas comunes

| Síntoma | Causa probable |
|---|---|
| `404 Dominio no administrado` | El `Host` no está en la config: dominio sin verificar por TXT, mal escrito, o la caché aún no refrescó |
| `502 ... Couldn't resolve host` | El `origin` no resuelve desde la caché (en el clúster use el nombre `*.svc.cluster.local`) |
| `502 ... SSL certificate problem` | Origen HTTPS con certificado no confiable: `ZC_ORIGIN_CA_FILE` (o `origin.caSecretName` en Helm) |
| Siempre `BYPASS` | La URL no define el tipo de archivo pedido (agregue la extensión o `*` en `fileTypes`) o no es `GET 200` |
| Siempre `MISS-NOSTORE` | El objeto es más grande que `cacheBytes` de la URL o `maxCacheBytes` del dominio |
| Pod no queda `Ready` | `/__zc/healthz` da 503 hasta cargar la config: revise `ZC_CONFIG_URL`, el Secret `zc-secrets` y `kubectl logs` |
| `411 Length Required` | El cliente mandó el cuerpo con `Transfer-Encoding: chunked`; use `Content-Length` (curl y Postman lo hacen) |
| Login responde 502 | El API de verificación no responde (`ZC_VERIFY_URL`) |

## 9. Limitaciones conocidas

- La respuesta del origen se arma completa en memoria antes de enviarla (máximo `ZC_MAX_OBJECT_BYTES`); no hay streaming.
- No se acepta `Transfer-Encoding: chunked` del cliente (411) y cada conexión atiende una petición (`Connection: close`).
- Sesiones en memoria del pod: una réplica por zona (ya configurado en el chart).
- La imagen y el contenedor se validaron con `docker build`/`docker run`, y las plantillas del chart con un renderizado
  de prueba. Minikube construye la imagen localmente; para el despliegue integrado siga `docs/KUBERNETES.md`.
