# Contrato del API Node.js (borrador)

> Estado: **borrador para acordar con el equipo**. Lo marcado como *Propuesta* está pendiente de confirmar.
> Base URL: `https://<proyecto>.vercel.app/api` (todas las rutas llevan el prefijo `/api`).
> Formato: JSON en request y response. Errores: `{ "error": "mensaje" }` con el código HTTP adecuado.

## 1. Quién usa qué

| Cliente | Autenticación | Rutas |
|---|---|---|
| UI (React) | `Authorization: Bearer <JWT>` | `/auth/*`, `/domains/*`, `/urls/*`, `/api-keys/*` |
| Cachés zonales y DNS Interceptor | Header `x-service-key: <SERVICE_KEY>` | `/service/*` |

- `SERVICE_KEY` es una clave larga y aleatoria guardada en variable de entorno (Vercel y en cada componente). Se llama distinto a `x-api-key` a propósito: `x-api-key` es la que usan los **clientes finales** contra las cachés.
- Cada persona usuaria solo puede ver y modificar **sus propios** dominios, URLs, claves y usuarios (autorización por propiedad).

## 2. Modelo de datos (Firestore)

| Colección | ID del documento | Campos |
|---|---|---|
| `users` | auto | `email`, `passwordHash` (bcrypt), `createdAt` |
| `domains` | nombre del dominio en minúsculas (ej. `ejemplo.com`) | `ownerId`, `txtToken`, `verified` (bool), `verifiedAt`, `createdAt` |
| `urls` | auto | `ownerId`, `domain`, `pattern` (ej. `/imagenes/*`), `origin` (ej. `http://rest-api:8080`), `cacheSizeMB`, `fileTypes` (`[{ ext, ttlSeconds }]`), `replacementPolicy` (`LRU\|LFU\|FIFO\|MRU\|RANDOM`), `authType` (`none\|apikey\|userpass`), `createdAt` |
| `apiKeys` | auto | `urlId`, `keyHash` (SHA-256), `prefix` (primeros 6 caracteres, solo para mostrar), `createdAt` |
| `urlUsers` | `{urlId}_{username}` | `urlId`, `username`, `passwordHash` (bcrypt), `createdAt` |
| `sessions` | hash del token | `urlId`, `username`, `expiresAt` |
| `zones` *(Propuesta)* | código de país (ej. `CR`) | `cacheHost` (IP o nombre de la caché zonal de ese país) |

Notas:
- Usar el nombre del dominio como ID garantiza que un dominio solo pueda registrarse una vez.
- Las API keys son aleatorias y largas, por eso basta SHA-256 (no bcrypt). Se muestran **una sola vez**, al crearlas.
- Las contraseñas de `users` y `urlUsers` nunca se guardan en claro.

## 3. Endpoints para la UI

### Cuenta
| Método | Ruta | Cuerpo | Respuesta |
|---|---|---|---|
| POST | `/auth/register` | `{ email, password }` | `201 { id, email }` |
| POST | `/auth/login` | `{ email, password }` | `200 { token, expiresIn }` |
| GET | `/auth/me` | — | `200 { id, email }` |

*Cerrar sesión:* la UI descarta el JWT (expira en poco tiempo).

### Dominios
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/domains` | Lista los dominios de la persona usuaria |
| POST | `/domains` | `{ domain }` → crea el dominio y devuelve `txtToken` y las instrucciones del registro TXT |
| POST | `/domains/:domain/verify` | Consulta el DNS; si encuentra el TXT, marca `verified: true` |
| DELETE | `/domains/:domain` | Elimina el dominio y sus URLs |

*Propuesta del registro TXT:* nombre `_p2redes.<dominio>`, valor `p2redes-verify=<txtToken>`.

### URLs (dentro de un dominio)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/domains/:domain/urls` | Lista las URLs del dominio |
| POST | `/domains/:domain/urls` | Crea una URL (campos de la colección `urls`) |
| PUT | `/urls/:id` | Modifica una URL |
| DELETE | `/urls/:id` | Elimina una URL y sus claves y usuarios |

### API keys (`authType = apikey`)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/urls/:id/api-keys` | Lista (solo `prefix` y fecha) |
| POST | `/urls/:id/api-keys` | Crea una clave y la devuelve **una sola vez** |
| DELETE | `/api-keys/:id` | Elimina |

### Usuarios de la URL (`authType = userpass`)
| Método | Ruta | Descripción |
|---|---|---|
| GET | `/urls/:id/users` | Lista usuarios |
| POST | `/urls/:id/users` | `{ username, password }` |
| PUT | `/urls/:id/users/:username` | Cambia la contraseña |
| DELETE | `/urls/:id/users/:username` | Elimina |

## 4. Endpoints de servicio (cachés e interceptor)

Todos requieren `x-service-key`.

| Método | Ruta | Lo usa | Respuesta |
|---|---|---|---|
| GET | `/service/domains/:domain` | Interceptor | `{ registered: true/false, verified: true/false }` |
| GET | `/service/zones/:country` *(Propuesta)* | Interceptor | `{ country, cacheHost }` |
| GET | `/records/:domain?sourceIp=<ip>` | Interceptor (formato que ya usa `dns.c`) | Ver sección "Compatibilidad con el interceptor actual" |
| GET | `/service/config/:domain` | Caché | Todas las reglas de URL del dominio (ver ejemplo) |
| POST | `/service/verify-api-key` | Caché | `{ urlId, apiKey }` → `{ valid: true/false }` |
| POST | `/service/login` | Caché / formulario de login | `{ urlId, username, password }` → `{ sessionToken, expiresAt }` |
| POST | `/service/verify-session` | Caché | `{ urlId, sessionToken }` → `{ valid: true/false }` |

Ejemplo de respuesta de `/service/config/ejemplo.com`:

```json
{
  "domain": "ejemplo.com",
  "urls": [
    {
      "id": "abc123",
      "pattern": "/imagenes/*",
      "origin": "http://apache:80",
      "cacheSizeMB": 100,
      "fileTypes": [
        { "ext": "png", "ttlSeconds": 3600 },
        { "ext": "html", "ttlSeconds": 60 }
      ],
      "replacementPolicy": "LRU",
      "authType": "apikey"
    }
  ]
}
```

La caché debe guardar esta respuesta en memoria unos segundos para no consultar el API en cada petición.

### Compatibilidad con el interceptor actual (*Propuesta*)

El `dns.c` del repositorio (heredado del P1) consulta `GET {DNS_API_URL}/api/records/{dominio}?sourceIp={ip}` y espera este JSON. Si el API lo devuelve con `type: "geo"` y las cachés zonales como `targets`, el interceptor elige la caché del país del cliente **sin cambiar su lógica**:

```json
{
  "recordId": "ejemplo.com",
  "type": "geo",
  "ttl": 60,
  "client": { "countryCode": "CR" },
  "targets": [
    { "address": "10.0.0.11", "healthy": true, "country": "CR" },
    { "address": "10.0.0.12", "healthy": true, "country": "US" }
  ]
}
```

- Dominio no registrado o sin verificar: `404` (el interceptor entonces reenvía la consulta).
- `targets` sale de la colección `zones`; `healthy` es `true` mientras no se implemente un chequeo de salud.
- `client.countryCode` requiere saber el país de `sourceIp`. Si el API no tiene la tabla IP to Country, se omite y el interceptor elige un target al azar.
- Hoy el interceptor **no envía** el header `x-service-key`; habría que agregarlo para proteger este endpoint.

## 5. Seguridad del API (para la documentación)

- Contraseñas con bcrypt; API keys hasheadas con SHA-256.
- JWT firmado con `JWT_SECRET` (variable de entorno) y expiración corta.
- Autorización por propiedad en todas las rutas de la UI.
- Rutas de servicio protegidas con `x-service-key` comparada en tiempo constante.
- CORS limitado al dominio de la UI.
- Límite de intentos en login.
- Ningún secreto en el código: todo por variables de entorno.

## 6. Decisiones abiertas (a acordar con el equipo)

1. ¿La caché y el interceptor leen todo a través de este API, o directo de Firestore? *(Este borrador asume que a través del API.)*
2. ¿De dónde saca la caché el origen? *(Este borrador asume el campo `origin` de cada URL.)*
3. Tamaño máximo: ¿por dominio o por URL? *(El enunciado dice "por dominio" en la caché y "por URL" en la UI.)*
4. Cómo viaja la sesión de usuario y contraseña entre el formulario de la UI y la caché.
5. Sintaxis de los wildcards (`*` en la ruta, ¿también en el dominio?) y qué regla gana si varias coinciden.
6. ¿Qué pasa con un dominio no registrado? *(Se asume que el interceptor lo reenvía a un DNS normal.)*
7. Qué dominio real usarán para probar la validación TXT (necesitan poder crear registros TXT en él).
8. De dónde lee el interceptor la base IP to Country y la relación país → caché zonal.
9. Quién convierte la IP del cliente en país: ¿el API (necesita la tabla) o el interceptor (la lee y envía el país)?
10. Qué hace el interceptor con dominios no registrados: hoy llama a `POST /api/dns_resolver` (API Java del P1, en Base64). El P2 no lo pide; lo más simple es reenviar por UDP a un DNS real.
11. Error conocido en `dns.c`: las IP salen invertidas en la respuesta DNS (falta `ntohl(addr.s_addr)` antes de `dns_build_response`).
