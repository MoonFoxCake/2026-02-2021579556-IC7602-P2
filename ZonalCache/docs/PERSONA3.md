# Zonal Cache — Módulos de la Persona 3

Políticas de reemplazo, autenticación (x-api-key y usuario/contraseña con sesiones), SSL termination y
lectura de configuración. Están escritos como **biblioteca en GNU C** (`libzc_p3.a`) para que el servidor HTTP
de la Persona 2 los llame, sin tocar sus archivos (evita conflictos de merge).

## Compilar y probar

```bash
sudo apt-get install -y build-essential libcurl4-openssl-dev libssl-dev
cd ZonalCache
make          # genera libzc_p3.a
make test     # 5 suites: políticas, config/reglas, auth/sesiones, TLS real, config en vivo
```

## Archivos

| Archivo | Qué hace |
|---|---|
| `p3/zc_policy.[ch]` | Índice de metadatos por dominio + LRU, LFU, FIFO, MRU, Random. Expiración por TTL, persistencia del índice. |
| `p3/zc_config.[ch]` | Parseo de la config, búsqueda de dominio/regla (wildcards), tipo de archivo → TTL y política, refresco periódico. |
| `p3/zc_auth.[ch]` | `x-api-key` (SHA-256), login usuario/contraseña, sesiones por cookie, rate limit, formulario HTML, utilidades. |
| `p3/zc_tls.[ch]` | SSL termination con OpenSSL (TLS ≥ 1.2). |
| `p3/json_lite.h` | Parser JSON tomado del `dns.c` del equipo. |
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

**1. `GET {ZC_CONFIG_URL}/api/cache/config?zone=<zona>`** con `Authorization: Bearer <token>` → `200` y JSON como
`docs/ejemplo-config.json`. Campos: `domain` (admite `*.x.com`), `origin`, `maxCacheBytes`, y por URL:
`pattern` (wildcards `*`), `auth.mode` (`none` | `apikey` | `userpass`), `auth.apiKeyHashes` (**SHA-256 hex** de cada
key; en Firestore nunca guardar la key en claro), `cacheBytes`, `fileTypes[{ext, ttl, policy}]` (`ext:"*"` = cualquier otra).

**2. `POST {ZC_VERIFY_URL}/api/cache/verify-credentials`** con Bearer y cuerpo
`{"domain","pattern","username","password"}` → `200` credenciales válidas, `401/403` inválidas, otro código = error.
El API debe guardar las contraseñas con bcrypt/argon2.

## Cómo lo integra la Persona 2 (flujo por petición)

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

## Pruebas manuales (cuando esté integrado el servidor)

```bash
curl -i  http://localhost:8080/api/x                         # 401 sin key
curl -i -H "x-api-key: MI_KEY" http://localhost:8080/api/x   # 200
curl -i  http://localhost:8080/privado/a.png                 # 302 a /__zc/login
curl -i -c jar -d "username=u&password=p&return_to=/privado/a.png" http://localhost:8080/__zc/login
curl -i -b jar http://localhost:8080/privado/a.png           # 200 (MISS) y luego HIT
scripts/gen-dev-cert.sh ./certs localhost && curl -k https://localhost:8443/
```

## Estado

| Aspecto | Estado |
|---|---|
| LRU / LFU / FIFO / MRU / Random | Funciona, con pruebas unitarias |
| TTL y expiración, límite por dominio, persistencia del índice | Funciona |
| `x-api-key` | Funciona (comparación en tiempo constante) |
| Usuario/contraseña + sesión + logout + rate limit | Funciona (verificador inyectable; el HTTP real depende del API de la Persona 4) |
| SSL termination | Funciona (probado con handshake TLS real) |
| Config desde API Node.js con refresco | Funciona con archivo local; contra el API real falta el endpoint de la Persona 4 |
| Integración en el servidor HTTP | Pendiente (Persona 2) |

## Limitaciones conocidas

- Límite por **dominio**; `cacheBytes` por URL se lee pero no se aplica.
- Sesiones en memoria del pod: con varias réplicas hace falta afinidad de sesión o una sola réplica.
- Un solo certificado (sin SNI por dominio).
- Expulsión O(n) por entrada: suficiente para miles de objetos.
- El formulario de login no tiene token CSRF.
- Si una URL no define `fileTypes` que calcen con el recurso, no se cachea (se hace proxy).
