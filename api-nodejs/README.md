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

Variables principales: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET`, `SERVICE_KEY`, `ZONE_CACHES`, `COUNTRY_ZONES`, `IP_COUNTRY_RANGES` y `CORS_ORIGINS`. Nunca agregue valores secretos a Dockerfile, Compose, Helm values o Git.

La guía de servicios y despliegue Minikube está en [docs/KUBERNETES.md](../docs/KUBERNETES.md). El contrato del API y los modelos Firestore están en [API.md](API.md).

## Panel de pruebas de caché

`CACHE_TEST_URL` configura un destino fijo HTTP/HTTPS, sin ruta ni credenciales, alcanzable desde este API. Compose usa `http://zonal-cache:8080`. Sin esa variable el panel indica que no hay caché disponible. La caché debe usar `ZC_LOGIN_MODE=local`. `CACHE_TEST_COOKIE_SECURE=0` permite HTTP local; por defecto la cookie es Secure y SameSite=None para HTTPS. CORS debe permitir expresamente el origen de la UI y credenciales; navegadores que bloquean cookies de terceros deben usar UI/API bajo el mismo origen.

Todas las rutas `/api/cache-test/*` requieren JWT de administración y devuelven `Cache-Control: no-store`:

| Método y ruta | Entrada / salida |
|---|---|
| GET `/status` | `{ enabled }` |
| POST `/request` | `{ urlId, host, path, apiKey? }` → `{ status, headers, body, truncated, elapsedMs, requiresLogin }` |
| POST `/login` | `{ urlId, host, path, username, password }` → `{ authenticated, status, message }`, cookie HttpOnly de sesión |
| POST `/logout` | `{ urlId, host, path }` → revoca la sesión en la caché y borra la cookie |

Se verifica propiedad de la regla y del dominio verificado. Solo se aceptan hosts del dominio y rutas locales no reservadas; se rechazan URLs absolutas, traversal y saltos de línea. El destino nunca viene del cliente. Los GET no siguen redirecciones y devuelven como datos los estados del recurso (incluido 401/302), para no confundirlos con la sesión de administración. Solo se exponen encabezados de contenido/caché, hasta 64 KiB de cuerpo y ninguna credencial. El JWT no se reenvía a la caché. El login reutiliza CSRF/sesiones de GNU C y no introduce un protocolo nuevo de tickets.
