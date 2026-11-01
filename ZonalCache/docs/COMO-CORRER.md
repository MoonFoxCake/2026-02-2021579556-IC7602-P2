# Zonal Cache — cómo correr y probar (Persona 3)

## 1. Requisitos (Ubuntu / WSL2)

```bash
sudo apt-get install -y build-essential libcurl4-openssl-dev libssl-dev openssl curl nodejs npm
```

## 2. Compilar y probar la caché (sin depender de nadie)

```bash
cd ZonalCache
make            # libzc_p3.a + tools/zc_p3_demo
make test       # 7 suites unitarias (políticas, config, auth, TLS, config en vivo, registro, gate)
make e2e        # 29 pruebas con curl: demo + mock del API (tests/mock-api.mjs)
```

## 3. Probar la caché con el adaptador del API Node.js

```bash
cd api-nodejs && npm install && npm test   # 4 pruebas del adaptador (/api/cache/*)
cd ../ZonalCache && make e2e-api           # 16 pruebas: demo C <-> rutas del API con almacén en memoria
```

El router de caché está implementado en `api-nodejs/src/cache-routes.js` y la aplicación lo monta en
`api-nodejs/src/app.js`. `npm test` comprueba sus rutas y el traductor de configuración. `e2e-api` levanta ese
router con `api-nodejs/test/serve-memory.js` y datos semilla que imitan el modelo de Firestore
(`domains`, `urls`, `apiKeys`, `urlUsers`): prueba el contrato entre el router y el servidor demo, pero **no**
conecta con Firestore real ni valida un despliegue en Vercel. El adaptador incluye un almacén Firestore, pero
esa conexión debe probarse con credenciales y datos reales.

La caché envía `?zone=<zona>` al endpoint de configuración; actualmente el router no filtra por ese parámetro.
Por tanto, estas pruebas tampoco demuestran que cada zona reciba una configuración distinta.

## 4. Correr a mano (para ver las respuestas)

```bash
# Terminal 1: API (requiere credenciales/configuración de Firebase para usar Firestore real)
cd api-nodejs && SERVICE_KEY=mi-clave-larga npm start          # escucha en :3000 (ver src/server.js)

# Terminal 2: caché
cd ZonalCache && ZC_CONFIG_URL=http://127.0.0.1:3000 ZC_CONFIG_TOKEN=mi-clave-larga ZC_ZONE=cr \
  ZC_CACHE_DIR=/tmp/zc ZC_HTTP_PORT=8080 ZC_COOKIE_SECURE=0 ZC_LOGIN_MODE=local ./tools/zc_p3_demo

# Terminal 3: probar con el dominio "ejemplo.com" sin tocar /etc/hosts
curl -i --connect-to ejemplo.com:8080:127.0.0.1:8080 http://ejemplo.com:8080/index.html     # MISS, luego HIT
curl -i --connect-to ejemplo.com:8080:127.0.0.1:8080 -H "x-api-key: <key>" http://ejemplo.com:8080/api/x
```

HTTPS: `scripts/gen-dev-cert.sh ./certs ejemplo.com` y arrancar con `ZC_TLS_CERT_FILE`, `ZC_TLS_KEY_FILE`, `ZC_HTTPS_PORT=8443`;
probar con `curl -k`.

## 5. ¿Funciona con el resto del proyecto?

| Pieza | Estado frente a la caché |
|---|---|
| **API Node.js (P4)** | El router `src/cache-routes.js` implementa `GET /api/cache/config` y `POST /api/cache/verify-credentials`, y traduce datos de dominios, URLs, claves y usuarios al formato de la caché. Las pruebas usan un almacén en memoria; falta validar Firestore real y el despliegue/configuración de producción. Además, el router todavía no filtra la configuración por `zone`. |
| **UI (P5)** | La UI de administración y el formulario `/cache-login` siguen pendientes. El modo `local` permite que la caché muestre su propio formulario; el flujo `ui` con ticket firmado está disponible en el mock de pruebas, no en el API/UI del proyecto. |
| **DNS Interceptor (P1)** | Sigue siendo el del P1; no selecciona ni devuelve la IP de una caché zonal. |
| **Servidor HTTP real (P2)** | **Falta el proxy real.** `tools/zc_p3_demo.c` simula el origen; P2 debe usar `g.origin` (ya resuelto: origen de la URL o del dominio). |
| **REST Java / Apache (P5)** | Son los orígenes que se escriben en el campo `origin` de cada URL. |
| **Docker / Helm** | Escritos pero **no validados** (sin `docker build` ni `helm lint` en el entorno de preparación). |

## 6. Contrato con el API (resumen)

- Autenticación de servicio: `Authorization: Bearer <SERVICE_KEY>` **o** `x-service-key: <SERVICE_KEY>`. En la caché va en
  `ZC_CONFIG_TOKEN` (Secret de Kubernetes); en Vercel, `SERVICE_KEY`.
- `origin` puede ir **por URL** (recomendado: así una URL va a Java y otra a Apache) o por dominio.
- `maxCacheBytes` del dominio = suma de `cacheSizeMB` de sus URLs; `cacheBytes` por URL se aplica como grupo.
- Dominios sin verificar por TXT no se entregan: la caché responde 404.
- Un `authType` desconocido **falla cerrado** (nadie pasa), nunca deja la URL abierta.
- Aunque la caché envía el parámetro `zone`, el endpoint actual devuelve la configuración de todos los dominios
  verificados y aún no aplica selección/aislamiento por zona.
