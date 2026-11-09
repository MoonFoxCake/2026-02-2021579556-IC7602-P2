# REST API Node.js

API Express con Firebase Admin/Firestore para la UI, el DNS Interceptor y las cachés zonales. El destino de producción definido por el proyecto es Vercel con deployments desde GitHub; el Dockerfile sirve para desarrollo e integración local con Compose.

## Local y contenedor

Requiere Node.js 20 o superior.

```bash
npm ci
npm start
npm test
```

Desde la raíz, `docker compose up --build -d --wait` ejecuta la UI, el API y Firestore local junto con los demás componentes. No necesita credenciales ni `.env`. El API usa `FIRESTORE_EMULATOR_HOST=firestore-emulator:8080` y `FIREBASE_PROJECT_ID=demo-ic7602-p2`; inicializa Firebase Admin solo con el ID de proyecto. Este modo exige el prefijo `demo-` y un host sin `http://`. La guía está en [docs/LOCAL.md](../docs/LOCAL.md).

Sin `FIRESTORE_EMULATOR_HOST`, se conserva la inicialización con cuenta de servicio para Vercel/Firebase hospedado. Configure `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET` y `SERVICE_KEY` en ese entorno. No defina la variable del emulador en Vercel. Para `npm start`, estas variables pueden ir en `api-nodejs/.env`, ignorado por Git.

La imagen corre sin root, publica el puerto 3000 y excluye env files y claves de cuenta de servicio del contexto. Compruebe `/api/health` (proceso) y `/api/health/db` (conectividad Firestore).

Variables principales: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `FIREBASE_DATABASE_URL`, `JWT_SECRET`, `SERVICE_KEY`, `TICKET_SECRET`, `ZONE_CACHES`, `COUNTRY_ZONES` y `CORS_ORIGINS`. Nunca agregue secretos a Dockerfile, Compose, Helm values o Git.

El país se consulta en `/ipToCountry` de Realtime Database con el esquema numérico inclusivo del P1 y un índice `ipFrom`. El importador `npm run ip-country:dbip -- <archivo.csv.gz> <MD5-publicado> --import` valida DB-IP Lite antes de reemplazar la tabla. El login externo usa `POST /api/cache-login`; verifica el usuario bcrypt de una regla `userpass` en Firestore y emite el ticket aceptado por la caché C. Configuración y pruebas: [GEO-LOGIN.md](../docs/GEO-LOGIN.md).

La guía de servicios y despliegue Minikube está en [docs/KUBERNETES.md](../docs/KUBERNETES.md). El contrato del API y los modelos Firestore están en [API.md](API.md).

## Panel de pruebas de caché

`CACHE_TEST_URLS` es un objeto JSON de zona → destino fijo HTTP/HTTPS alcanzable desde este API, sin ruta ni credenciales. `CACHE_TEST_URL` conserva la alternativa de una zona para Compose (`http://zonal-cache:8080`). Sin destinos configurados el panel indica que no hay caché disponible. `CACHE_TEST_LOGIN_MODE=ui` verifica credenciales y usa el ticket firmado; el modo local usa el formulario CSRF nativo. En HTTPS las cookies son Secure/HttpOnly/SameSite=Lax; `CACHE_TEST_COOKIE_SECURE=0` permite HTTP local con SameSite=Strict. Producción usa el proxy del mismo origen de la UI y `CACHE_TEST_TUNNEL_KEY` solo en backend: [PUBLIC-CACHE.md](../docs/PUBLIC-CACHE.md).

Todas las rutas `/api/cache-test/*` requieren JWT de administración y devuelven `Cache-Control: no-store`:

| Método y ruta | Entrada / salida |
|---|---|
| GET `/status` | `{ enabled, zones }` |
| POST `/request` | `{ urlId, host, path, zone?, apiKey? }` → `{ status, headers, body, truncated, elapsedMs, requiresLogin }` |
| POST `/login` | `{ urlId, host, path, zone?, username, password }` → `{ authenticated, status, message }`, cookie HttpOnly de sesión |
| POST `/logout` | `{ urlId, host, path, zone? }` → revoca la sesión de esa zona y borra su cookie |

Se verifica propiedad de la regla y del dominio verificado. Solo se aceptan hosts del dominio y rutas locales no reservadas; se rechazan URLs absolutas, traversal y saltos de línea. El destino nunca viene del cliente. Los GET no siguen redirecciones y devuelven como datos los estados del recurso (incluido 401/302), para no confundirlos con la sesión de administración. Solo se exponen encabezados de contenido/caché y hasta 64 KiB de cuerpo; no se devuelven credenciales. El JWT no se reenvía a la caché. El ticket del modo UI es el mismo protocolo que acepta el callback de GNU C. La sesión del panel se aísla por cuenta/regla/zona.
