# Zonal Cache — Módulos de la Persona 3

Políticas de reemplazo, autenticación (x-api-key y usuario/contraseña con sesiones), SSL termination y
lectura de configuración. Están escritos como **biblioteca en GNU C** (`libzc_p3.a`). El servidor real de la caché
(`src/zonal_cache.c`: sockets, proxy al origen con libcurl y objetos en disco) la usa por medio de `zc_gate`.

## Compilar y probar

```bash
sudo apt-get install -y build-essential libcurl4-openssl-dev libssl-dev
cd ZonalCache
make             # zonal-cache (servidor real) + libzc_p3.a + demo
make test        # 7 suites unitarias (342 comprobaciones)
make e2e         # 29 pruebas: servidor real + mock del API + origen real
make e2e-proxy   # 49 pruebas del proxy con orígenes HTTP/HTTPS reales
make e2e-api     # 16 pruebas contra el router real de api-nodejs
make e2e-sistema # 11 pruebas: dig -> DNS Interceptor -> API -> cachés cr/us -> origen
make check       # todo lo anterior
```

> Guía completa de ejecución y estado de integración: [`COMO-CORRER.md`](COMO-CORRER.md).

## Archivos

| Archivo | Qué hace |
|---|---|
| `p3/zc_policy.[ch]` | Índice de metadatos por dominio + LRU, LFU, FIFO, MRU, Random. Expiración por TTL, persistencia del índice. |
| `p3/zc_config.[ch]` | Parseo de la config, búsqueda de dominio/regla (wildcards), tipo de archivo → TTL y política, refresco periódico. |
| `p3/zc_auth.[ch]` | `x-api-key` (SHA-256), login usuario/contraseña, sesiones por cookie, rate limit, formulario HTML, utilidades. |
| `p3/zc_tls.[ch]` | SSL termination con OpenSSL (TLS ≥ 1.2). |
| `p3/json_lite.h` | Parser JSON tomado del `dns.c` del equipo. |
| `src/zonal_cache.c` | **Servidor real**: HTTP/HTTPS, `zc_gate`, HIT desde disco, proxy al origen (libcurl, HTTP y HTTPS, todos los verbos), guardar y expulsar. |
| `tests/origin.mjs` | Origen de prueba (hace de Apache / REST API / sitio HTTPS) para las pruebas e2e. |
| `scripts/gen-dev-cert.sh` | Certificado autofirmado para pruebas. |

## Variables de entorno (nada quemado en código)

| Variable | Default | Uso |
|---|---|---|
| `ZC_CONFIG_URL` | — | Base del API Node.js (Vercel). Alternativa: `ZC_CONFIG_FILE` (JSON local, útil para pruebas). |
| `ZC_CONFIG_TOKEN` | — | Token Bearer de la caché ante el API Node.js. **Secret de Kubernetes**, no va en el chart. |
| `ZC_ZONE` | — | Zona de esta caché (p.ej. `cr`, `us`). |
| `ZC_CONFIG_REFRESH_SECS` | 60 | Cada cuánto se vuelve a leer la config. Si falla, se conserva la última buena. |
| `ZC_VERIFY_URL` / `ZC_VERIFY_TOKEN` | = `ZC_CONFIG_*` | API que valida usuario/contraseña. |
| `ZC_SESSION_TTL_SECS` | 3600 | Duración de la sesión. |
| `ZC_SESSION_MAX` | 10000 | Máximo de sesiones en memoria. |
| `ZC_LOGIN_MAX_ATTEMPTS` / `ZC_LOGIN_WINDOW_SECS` | 5 / 300 | Intentos de login por IP por ventana (429 al excederse). |
| `ZC_COOKIE_SECURE` | 1 | Atributo `Secure`. Poner `0` para probar login sobre HTTP plano. |
| `ZC_TLS_CERT_FILE` / `ZC_TLS_KEY_FILE` | — | PEM para SSL termination (montar desde un Secret). |

## Contrato con el API Node.js (Persona 4) — hay que acordarlo

**1. `GET {ZC_CONFIG_URL}/api/cache/config?zone=<zona>`** con `Authorization: Bearer <token>` (el API acepta también `x-service-key`) → `200` y JSON como
`docs/ejemplo-config.json`. Campos: `domain` (admite `*.x.com`), `origin` (del dominio y/o **por URL**; el de la URL gana), `maxCacheBytes`, y por URL:
`pattern` (wildcards `*`), `auth.mode` (`none` | `apikey` | `userpass`), `auth.apiKeyHashes` (**SHA-256 hex** de cada
key; en Firestore nunca guardar la key en claro), `cacheBytes`, `fileTypes[{ext, ttl, policy}]` (`ext:"*"` = cualquier otra).

**2. `POST {ZC_VERIFY_URL}/api/cache/verify-credentials`** con Bearer y cuerpo
`{"domain","pattern","username","password"}` → `200` credenciales válidas, `401/403` inválidas, otro código = error.
El API debe guardar las contraseñas con bcrypt/argon2.

## Cómo lo usa el servidor (`src/zonal_cache.c`, flujo por petición)

```c
zc_cfg_handle_t *h = zc_cfg_acquire();
const zc_domain_t *dom = zc_config_find_domain(zc_cfg_get(h), host);   // NULL => 404/502
const zc_rule_t   *rule = zc_domain_match_rule(dom, path);

if (path_sin_query == ZC_LOGIN_PATH) {            // GET: zc_auth_login_form(host, return_to, NULL)
    // POST: zc_form_get(body,"username"/"password"/"return_to") + zc_auth_login(...)
    //  0 => 302 a zc_safe_return_path(return_to) + zc_auth_set_cookie | -1 => form con error
    //  -2 => 429 | -3 => 502
}
switch (zc_auth_check(auth, rule, host, hdr_x_api_key, hdr_cookie, time(NULL))) {
    case ZC_AUTH_DENY:           /* 401 */ break;
    case ZC_AUTH_LOGIN_REQUIRED: /* 302 a ZC_LOGIN_PATH?return_to=<path> */ break;
    case ZC_AUTH_ALLOW: break;
}
const zc_filetype_t *ft = rule ? zc_rule_filetype(rule, path) : NULL;  // NULL => proxy sin cachear
// clave = sha256 hex de método+host+path+query (la define la Persona 2)
int r = zc_index_lookup(ix_del_dominio, key, now, borrar_archivo_cb, dir);   // 1 hit
// miss/expirada => pedir al origen, escribir archivo y registrar:
zc_index_put(ix_del_dominio, key, bytes, ft->ttl, ft->policy, now, borrar_archivo_cb, dir);
```

- Un `zc_index_t` por dominio, con `max_cache_bytes` del dominio. Si el refresco trae otro límite: `zc_index_set_max`.
- `borrar_archivo_cb` recibe la clave expulsada y borra el archivo. **No debe llamar al índice** (se ejecuta con el lock tomado).
- `zc_index_save/load` guardan los metadatos para que LRU/LFU/FIFO sobrevivan a un reinicio del pod.
- TLS: `zc_tls_ctx_from_env()` una vez; por conexión `zc_tls_accept` → `zc_tls_read/write` → `zc_tls_close`.
  Con TLS use `ZC_COOKIE_SECURE=1`; en pruebas con HTTP use `0`.

## Pruebas manuales

Paso a paso de cada requisito del enunciado (R1–R9) con los comandos y la salida esperada:
[`COMO-CORRER.md`, sección 3](COMO-CORRER.md#3-correr-a-mano-y-probar-cada-requisito-del-enunciado).

## Verificación para la entrega (requisito → código → prueba)

Revisión del 2 de noviembre de 2026. Se ejecuta todo con `cd api-nodejs && npm install && npm test` (47 ok) y
`cd ZonalCache && make && make check` (342 unitarias + 29 + 49 + 16 + 11 e2e, 0 fallos).

| Requisito (Persona 3) | Código | Pruebas que lo demuestran |
|---|---|---|
| LRU, LFU, FIFO, MRU, Random | `p3/zc_policy.c` | `test_policy` (166); `make e2e-proxy`: "LRU expulsa el menos reciente", "LFU expulsa el menos usado", "FIFO expulsa el primero que entró", "MRU expulsa el más reciente", "RANDOM: el dominio no pasa de 250 B" |
| Metadatos para las políticas (secuencia de inserción y acceso, hits, expiración, tamaño, grupo) y su persistencia | `p3/zc_policy.h` (`zc_entry_t`), `p3/zc_registry.c` (`index.zc`) | `test_policy`, `test_registry`; `make e2e`: "índice guardado al apagar", "tras reinicio = HIT"; `make e2e-proxy`: "índices guardados al apagar (SIGTERM)" |
| Tamaño máximo por dominio / por URL | `zc_index_put_ex`, `zc_registry_get` | `make e2e`: "dominio no supera maxCacheBytes", "archivos expulsados se borran"; `make e2e-proxy`: "objeto mayor que el dominio no se guarda" |
| `x-api-key` | `p3/zc_auth.c` (SHA-256, tiempo constante) | `test_auth`; `make e2e`: "api sin key = 401", "api key mala = 401", "api key buena = 200"; `make e2e-api`: "api key de Firestore (hash MAYÚSCULAS) = 200"; `make e2e-proxy`: "x-api-key NO se reenvía al origen" |
| Usuario/contraseña (llamado al API/UI) | `p3/zc_auth.c`, `p3/zc_gate.c` (`/__zc/login`, `/__zc/callback`) | `make e2e`: "login contraseña mala = 401", "login correcto = 302 + cookie", "login sin CSRF = 403", "rate limit login = 429", modo UI: "UI devuelve ticket al callback", "ticket reutilizado = 401", "UI rechaza callback de otro dominio"; `make e2e-api`: "login con contraseña mala (bcrypt) = 401", "login correcto verificado por el API = 302" |
| Sesión en peticiones posteriores y cerrar sesión | `p3/zc_auth.c` (cookie `zc_session`), `/__zc/logout` | `make e2e`: "con sesión = 200 MISS, private", "con sesión 2a vez = HIT", "logout = 302 y borra cookie", "tras logout = 302 a login"; `make e2e-proxy`: "zc_session/zc_csrf NO llegan al origen" |
| SSL termination | `p3/zc_tls.c` (TLS ≥ 1.2, SNI) | `test_tls`; `make e2e`: "HTTPS (SSL termination) = 200", "HTTPS negocia TLS >= 1.2"; `make e2e-proxy`: "cliente por HTTPS (SSL termination)" |
| Lectura de configuración desde Firebase (vía API Node.js) con refresco | `p3/zc_config.c` | `test_config`, `test_runtime`; `make e2e-api`: "API: /api/cache/config sin credencial = 401", "la caché cargó la config del API real", "dominio sin verificar (pendiente.com) = 404", "política del tipo html = LRU (Firestore)"; `make e2e-proxy`: "/__zc/healthz responde zona y dominios" |
| Módulos separados de la Persona 2 | Biblioteca `p3/` → `libzc_p3.a`; único punto de unión `p3/zc_gate.h` | El servidor `src/zonal_cache.c` y el demo `tools/zc_p3_demo.c` usan la misma biblioteca sin modificarla (`make e2e` y `make e2e-demo`: 29/29 cada uno) |

Pasos manuales con salida esperada: [`COMO-CORRER.md`, sección 3](COMO-CORRER.md#3-correr-a-mano-y-probar-cada-requisito-del-enunciado).

## Estado

| Aspecto | Estado |
|---|---|
| LRU / LFU / FIFO / MRU / Random | Funciona, con pruebas unitarias |
| TTL y expiración, límite por dominio, persistencia del índice | Funciona |
| `x-api-key` | Funciona (comparación en tiempo constante) |
| Usuario/contraseña + sesión + logout + rate limit | Funciona (verificador inyectable; el HTTP real depende del API de la Persona 4) |
| SSL termination | Funciona (probado con handshake TLS real) |
| Config desde API Node.js con refresco | Funciona contra `api-nodejs` (`src/cache-routes.js`) con Firestore simulado; falta probar con Firestore real |
| Integración en el servidor HTTP (proxy real + disco) | Funciona: `src/zonal_cache.c`, 49 pruebas e2e con orígenes HTTP/HTTPS reales |
| Docker / Helm | Imagen construida y probada con `docker run`; chart renderizado y validado; `scripts/deploy-k8s.sh` |

## Limitaciones conocidas

- Sesiones en memoria del pod: con varias réplicas hace falta afinidad de sesión o una sola réplica.
- Expulsión O(n) por entrada: suficiente para miles de objetos.
- Si una URL no define `fileTypes` que calcen con el recurso, no se cachea (se hace proxy).
