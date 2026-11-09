# Ejecutar P2 completamente local

Requisito: Docker Desktop iniciado en modo contenedores Linux, con Docker Compose v2. Desde la raíz del repositorio (PowerShell, Bash o una terminal de VS Code):

```bash
docker compose up --build -d --wait
```

La primera construcción necesita Internet para imágenes y paquetes. Compose inicia todos los servicios, incluido el DNS API importado del P1 en `dns-api/`. Las cuentas, configuración de caché y orígenes del P2 usan servicios locales; el DNS API consulta Firebase Realtime Database real y el DNS remoto.

## DNS API integrado

Antes de iniciar Compose, coloque la cuenta de servicio en `secrets/firebase-service-account.json` (ya preparada en este equipo). La carpeta está excluida de Git. En otro equipo debe copiar la clave por separado. Puede cambiar la ruta mediante `DNS_FIREBASE_CREDENTIALS` y la base mediante `DNS_DATABASE_URL` en el `.env` de la raíz; vea [.env.example](../.env.example).

Compose monta la clave de solo lectura en `/run/secrets/dns-firebase`. No se copia al código ni a la imagen. El interceptor consulta `http://dns-api:8080` por la red interna y espera el healthcheck del API. No requiere el proceso Java del P1 ni acceso al puerto 8080 del host, ni la regla UFW que se usaba para esa conexión.

```bash
docker compose up --build -d --wait
curl http://127.0.0.1:18083/health
curl http://127.0.0.1:18083/api/records/multi.test
dig @127.0.0.1 -p 1053 multi.test A
dig @127.0.0.1 -p 1053 geo.test A
dig @127.0.0.1 -p 1053 google.com A
```

La base configurada por defecto es `p2-redes-b7bab`, a la que pertenece la credencial. Los registros DNS provienen de esa base. Crear `p2.test` en el emulador del P2 no crea un registro en Realtime Database; para resolverlo hacia la caché local debe existir también allí con el destino adecuado. No se migran ni modifican datos de Firebase durante el arranque.

El puerto publicado del DNS API es `18083` para evitar conflictos con procesos existentes en `8080`. `/health` comprueba el servidor HTTP; una consulta a `/api/records/multi.test` comprueba también el acceso a Firebase. Si devuelve 502, revise la cuenta de servicio y sus permisos sobre la base configurada.

## UI y datos de demostración

Abra http://localhost:5173. Cuenta inicial: `demo@p2.test`, contraseña `local-demo-password`.

El servicio `local-seed` espera al emulador y crea, sin sobrescribir documentos existentes:

- La cuenta de demostración con contraseña bcrypt.
- El dominio `p2.test`, verificado solo en el emulador para evitar necesitar un TXT público.
- La regla `/*`, origen `http://apache-web:8080`, archivos HTML, TTL 30 s.
- La regla `/api/*`, origen `http://rest-api-java:8080`, archivos JSON, TTL 30 s.

Las reglas iniciales son públicas (`authType=none`). Desde la UI se pueden crear cuentas y modificar reglas, políticas, claves y usuarios. Otros dominios continúan exigiendo TXT real: el seed no desactiva la verificación del API. La pestaña **Acceso a caché** permite probar recursos y autenticación mediante el formulario local de la caché, sin editar hosts ni configurar DNS en el navegador.

## Probar la caché desde la UI

1. Inicie sesión y abra **Acceso a caché**.
2. Seleccione `p2.test` y la regla `/*`. La ruta inicial es `/index.html`; para `/api/*`, use `/api/items.json`.
3. Pulse **Probar MISS → HIT**. El panel agrega una consulta única y envía dos GET a la misma URL. Los resultados más recientes aparecen primero y muestran estado HTTP, HIT/MISS/BYPASS, tiempo API→caché, zona, regla aplicada, política, TTL, encabezados y cuerpo como texto.
4. Pulse **Enviar solicitud** para repetir la URL actual. Después de su TTL debería volver a mostrar MISS. La prueba doble utiliza una consulta nueva para evitar entradas previas, sin purgar datos.
5. Para probar una API key: cambie la regla a **API key** en **Reglas de caché**, cree una clave en **Accesos**, vuelva al panel y pulse **Actualizar reglas**. Espere al menos 5 s. Una solicitud sin clave debe dar HTTP 401; con la clave correcta puede ejecutar la prueba doble.
6. Para usuario/contraseña: cambie la regla a ese modo, cree un usuario en **Accesos** y actualice el panel. Ingrese las credenciales del recurso y pulse **Iniciar sesión en caché**, luego envíe solicitudes. **Cerrar sesión de caché** revoca la sesión real: otra solicitud debería mostrar HTTP 302 y autenticación requerida. La cuenta de administración es independiente.

Los GET pasan por el API hacia el destino fijo `CACHE_TEST_URL=http://zonal-cache:8080`, con el Host del dominio seleccionado. El API exige JWT y propiedad de la regla/dominio; no permite elegir un servidor arbitrario ni seguir redirects. Reutiliza el login CSRF nativo de la caché y guarda la sesión en una cookie HttpOnly aislada por cuenta/regla. No devuelve cookies del origen, contraseñas ni tokens en los resultados; limita la vista del cuerpo a 64 KiB y lo muestra sin ejecutar HTML. Las API keys solo se mantienen en memoria durante esta vista.

El panel requiere `ZC_LOGIN_MODE=local`. El flujo externo de redirección con tickets (`ZC_LOGIN_MODE=ui`) es una integración diferente y no se activa con este panel. Estas pruebas consultan directamente la caché; el smoke test comprueba DNS con el servicio `dns-api` como se indica abajo.

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
| DNS API (Realtime Database real) | http://localhost:18083/health |
| DNS Interceptor | UDP 127.0.0.1:1053 (contenedor 5353) |

## Comprobar la integración

El smoke test comprueba la demostración del P2 y requiere que `multi.test` tenga al menos un destino saludable en la base del DNS API:

```bash
docker compose ps -a
docker compose run --rm local-smoke
```

El smoke test comprueba HTML de la UI, proxy del API, conectividad Firestore, login, dominio inicial, CRUD Java a través de la caché, `MISS`/`HIT` para JSON/HTML, y consulta DNS UDP para `multi.test`, contrastando la respuesta con los destinos saludables que devuelve el DNS API. También crea un dominio temporal solo en el emulador y verifica API keys, CSRF, login correcto/incorrecto, MISS/HIT autenticados y revocación de sesión mediante el API del panel. Borra sus datos al terminar y no modifica las reglas de `p2.test`.

Pruebas manuales en PowerShell:

```powershell
Invoke-RestMethod http://localhost:3000/api/health/db
Invoke-RestMethod http://localhost:18080/api/health
nslookup -port=1053 google.com 127.0.0.1
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
- Puerto ocupado: detenga el proceso que ocupa 80, 1053, 3000, 5173, 18080, 18081, 18082 o 18083; vea `docker compose ps` y `docker compose logs`. Para DNS puede definir `LOCAL_DNS_PORT` en `.env`; el puerto predeterminado 1053 evita el 5353 reservado por mDNS en muchos equipos Windows.
- `local-seed` termina con código 0: es lo esperado; el API empieza después de completarse. Un código distinto de 0 impide iniciar los servicios dependientes.
- Si `nslookup` de Windows devuelve `recvfrom: No error` o `No response from server`, ejecute `docker compose run --rm local-smoke` para comprobar DNS desde la red Docker. En la validación local también se comprobó una consulta UDP desde el host; el fallo de esa herramienta de Windows quedó sin resolver.
- Configuración de caché aún sin cambios: el refresco local ocurre cada 5 s. Las respuestas GET ya cacheadas conservan su contenido hasta el TTL.

Referencias: [conectar Firebase Admin al emulador](https://firebase.google.com/docs/emulator-suite/connect_firestore), [imagen oficial Google Cloud CLI](https://github.com/GoogleCloudPlatform/cloud-sdk-docker), [inicio/importación/exportación de Firestore](https://docs.cloud.google.com/sdk/gcloud/reference/emulators/firestore/start).
