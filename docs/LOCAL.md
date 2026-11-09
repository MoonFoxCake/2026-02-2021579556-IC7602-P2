# Ejecutar P2 completamente local

Requisito: Docker Desktop iniciado en modo contenedores Linux, con Docker Compose v2. Desde la raíz del repositorio (PowerShell, Bash o una terminal de VS Code):

```bash
docker compose up --build -d --wait
```

La primera construcción necesita Internet para imágenes y paquetes. Una vez construidas, las cuentas, configuración, caché y orígenes de demostración usan servicios locales. No se necesita iniciar sesión en Firebase/Vercel, instalar Node/Java/Helm ni crear un archivo `.env`.

## UI y datos de demostración

Abra http://localhost:5173. Cuenta inicial: `demo@p2.test`, contraseña `local-demo-password`.

El servicio `local-seed` espera al emulador y crea, sin sobrescribir documentos existentes:

- La cuenta de demostración con contraseña bcrypt.
- El dominio `p2.test`, verificado solo en el emulador para evitar necesitar un TXT público.
- La regla `/*`, origen `http://apache-web:8080`, archivos HTML, TTL 30 s.
- La regla `/api/*`, origen `http://rest-api-java:8080`, archivos JSON, TTL 30 s.

Las reglas iniciales son públicas (`authType=none`). Desde la UI se pueden crear cuentas y modificar reglas, políticas, claves y usuarios. Otros dominios continúan exigiendo TXT real: el seed no desactiva la verificación del API. El login de la caché usa su formulario local; la pantalla de login/ticket de caché en la UI sigue pendiente.

El emulador es Firestore de Google. Las cuentas del proyecto usan JWT/bcrypt y colecciones Firestore; no necesitan el emulador de Firebase Authentication. El API usa `FIRESTORE_EMULATOR_HOST` sin protocolo y exige un proyecto `demo-`. Compose fija `demo-ic7602-p2`, no carga credenciales del `.env` y no conecta a Firestore hospedado. El seed se niega a ejecutarse sin esas condiciones. La UI pasa `/api/*` por Nginx al API y desactiva las integraciones de telemetría Vercel en su imagen local.

## Puertos

Todos los puertos publicados se limitan a `127.0.0.1`.

| Servicio | Dirección desde el equipo |
|---|---|
| UI y proxy `/api` | http://localhost:5173 |
| API Node.js | http://localhost:3000/api/health/db |
| Firestore REST del emulador | http://localhost:18082/v1/projects/demo-ic7602-p2/databases/(default)/documents |
| REST API Java | http://localhost:18080/api/items.json |
| Apache | http://localhost:18081/index.html |
| Caché zonal | http://127.0.0.1:80, encabezado `Host: p2.test` |
| DNS Interceptor | UDP 127.0.0.1:1053 (contenedor 5353) |

## Comprobar la integración

Después de iniciar Compose:

```bash
docker compose ps -a
docker compose run --rm local-smoke
```

El smoke test comprueba HTML de la UI, proxy del API, conectividad Firestore, login, dominio inicial, CRUD Java a través de la caché, `MISS`/`HIT` para JSON/HTML, y consulta DNS UDP para `p2.test`. Crea y elimina su propio elemento Java; usa consultas únicas para evitar entradas de caché de ejecuciones anteriores.

Pruebas manuales en PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/health/db
Invoke-RestMethod http://localhost:18080/api/health
nslookup -port=1053 p2.test 127.0.0.1
curl.exe --noproxy "*" --resolve p2.test:80:127.0.0.1 -i http://p2.test/index.html
curl.exe --noproxy "*" --resolve p2.test:80:127.0.0.1 -i http://p2.test/index.html
curl.exe --noproxy "*" --resolve p2.test:80:127.0.0.1 -i http://p2.test/api/items.json
```

`nslookup` consulta el Interceptor en su puerto local. `curl --resolve` lleva el dominio al puerto 80 de la caché sin modificar el DNS del equipo. En Bash use `curl` en lugar de `curl.exe`. Los dominios ajenos al demo pueden necesitar DNS externo; esa consulta no forma parte del funcionamiento local de `p2.test`.

## Detener, conservar o reiniciar datos

```bash
docker compose logs -f --tail=100
docker compose down
docker compose up -d --wait
```

Firestore exporta datos al volumen `firestore-data` durante un apagado normal y los importa al arrancar. Permita el apagado de hasta 30 s; un cierre forzado puede perder cambios posteriores al último export. La caché persiste en `zonal-cache-data`. Java conserva sus elementos solo en memoria y los pierde al recrear el contenedor.

Para borrar deliberadamente **todos los datos locales de Firestore y caché** y volver a crear el demo:

```bash
docker compose down --volumes
docker compose up -d --wait
```

Opcionalmente copie `.env.example` a `.env` para personalizar las variables `LOCAL_*`. Las credenciales y claves de desarrollo por defecto son públicas y están limitadas a este stack local; no son valores para Vercel. El seed no modifica la contraseña de una cuenta ya existente.

## Diagnóstico

- `open dockerfile: no such file`: el archivo del Interceptor debe llamarse exactamente `Interceptor/dockerfile`, en minúsculas, igual que `compose.yaml`. En Windows, un cambio de mayúsculas requiere renombrar primero a un nombre temporal y luego al nombre correcto.
- Puerto ocupado: detenga el proceso que ocupa 80, 1053, 3000, 5173, 18080, 18081 o 18082; vea `docker compose ps` y `docker compose logs`. Para DNS puede definir `LOCAL_DNS_PORT` en `.env`; el puerto predeterminado 1053 evita el 5353 reservado por mDNS en muchos equipos Windows.
- `local-seed` termina con código 0: es lo esperado; el API empieza después de completarse. Un código distinto de 0 impide iniciar los servicios dependientes.
- Si `nslookup` de Windows devuelve `recvfrom: No error` o `No response from server`, ejecute `docker compose run --rm local-smoke` para comprobar DNS desde la red Docker. En la validación local también se comprobó una consulta UDP desde el host; el fallo de esa herramienta de Windows quedó sin resolver.
- Configuración de caché aún sin cambios: el refresco local ocurre cada 5 s. Las respuestas GET ya cacheadas conservan su contenido hasta el TTL.

Referencias: [conectar Firebase Admin al emulador](https://firebase.google.com/docs/emulator-suite/connect_firestore), [imagen oficial Google Cloud CLI](https://github.com/GoogleCloudPlatform/cloud-sdk-docker), [inicio/importación/exportación de Firestore](https://docs.cloud.google.com/sdk/gcloud/reference/emulators/firestore/start).
