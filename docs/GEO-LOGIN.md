# IP-to-Country y acceso externo

## Flujo implementado

```mermaid
sequenceDiagram
    participant Cliente
    participant DNS as Interceptor C (Kubernetes)
    participant API as Node API (Vercel)
    participant RTDB as Realtime Database
    participant Cache as Caché C (Kubernetes)
    participant UI as React UI (Vercel)
    participant FS as Firestore
    participant Origen as Apache / Java
    Cliente->>DNS: Consulta DNS del dominio
    DNS->>API: /api/records/host?sourceIp=IP
    API->>FS: Dominio verificado
    API->>RTDB: ipFrom <= IP, último rango
    API-->>DNS: País y caché zonal
    DNS-->>Cliente: IP de la caché
    Cliente->>Cache: GET del recurso userpass
    Cache-->>Cliente: 302 a UI /cache-login
    Cliente->>UI: Usuario y contraseña del recurso
    UI->>API: POST /api/cache-login
    API->>FS: Regla verificada + usuario bcrypt
    API-->>UI: Callback con ticket firmado de 60 segundos
    UI-->>Cliente: Navegación al callback del dominio
    Cliente->>Cache: /__zc/callback
    Cache-->>Cliente: Cookie HttpOnly + Secure + SameSite=Lax; 302 al recurso
    Cliente->>Cache: GET con cookie
    Cache->>Origen: MISS: obtener contenido
    Cache-->>Cliente: Contenido; siguientes GET pueden ser HIT
```

La cuenta de administración de la UI y el usuario de una URL son credenciales distintas. El formulario externo no requiere JWT de administración y sus errores no eliminan esa sesión. La caché valida tickets y sesiones; la contraseña solo se envía a la UI/API HTTPS. Los secretos de firma no llegan al frontend.

## Tabla DB-IP usando el modelo del P1

Se reutiliza `IpToCountryService.java` del P1 como referencia: convertir IPv4 a entero sin signo, consultar `orderBy="ipFrom"&endAt=N&limitToLast=1`, comprobar también `N <= ipTo`. Un intervalo es inclusivo. La tabla RTDB está en `/ipToCountry/<id>` con `ipFrom`, `ipTo`, `startIp`, `endIp`, `countryCode`, `countryName`. Debe existir `.indexOn: ["ipFrom"]` en las reglas de ese nodo; conserve las demás reglas de seguridad.

En producción se usa `FIREBASE_DATABASE_URL` y la cuenta de servicio existente. Cuentas, dominios, URL rules, API keys y usuarios de URL siguen en Firestore. El Compose sin credenciales conserva únicamente el fixture P1 en su emulador Firestore; no representa la tabla mundial.

Descargue el CSV mensual de [DB-IP Lite](https://db-ip.com/db/download/ip-to-country-lite). Está bajo [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); la UI, esta guía, las respuestas DNS del API y la página Apache incluyen atribución a [DB-IP](https://db-ip.com). El MD5 publicado corresponde al CSV descomprimido, no al `.gz`.

Con las variables Firebase configuradas en `api-nodejs/.env`, desde `api-nodejs`:

```bash
npm ci
# Primero validar; usar el checksum de la edición descargada.
npm run ip-country:dbip -- /ruta/dbip-country-lite-2026-11.csv.gz 93c945395f0bc2ceefea7dd55750417a
# Respaldar /ipToCountry y /metadata/ipToCountryDataset antes de reemplazarlos.
npm run ip-country:dbip -- /ruta/dbip-country-lite-2026-11.csv.gz 93c945395f0bc2ceefea7dd55750417a --import
```

El importador valida checksum, direcciones, orden de límites y ausencia de solapamientos antes de escribir. Omite IPv6 porque el interceptor heredado responde A/IPv4. Reemplaza solo la tabla derivada y su metadata mediante un PATCH atómico. Usa `writeSizeLimit=unlimited` únicamente para esa importación explícita: una tabla grande puede retrasar peticiones RTDB mientras se procesa. No cambia el límite global ni las reglas de seguridad. No interrumpa ni repita una importación sin revisar primero la metadata en el servidor.

Edición instalada el 2026-11-09: **2026-11**, **362,998 rangos IPv4**, 369,798 rangos IPv6 omitidos. SHA-256 del CSV: `5e968a64a29b973f794c5abc46d0711a0ba87c8a16c411e1cd70312db7a5d4e1`. DB-IP Lite tiene cobertura/precisión reducida respecto de la edición comercial. Código `ZZ`, IPv6, IPv4 inválida o fuera de rango → país desconocido y zona `COUNTRY_ZONES['*']`. Un fallo de RTDB → HTTP 503, sin inventar país. `?country=` e `IP_COUNTRY_RANGES` ya no sustituyen la base.

## Configuración del handoff

En el API Vercel: `TICKET_SECRET` aleatorio de al menos 32 caracteres, y `CORS_ORIGINS` con el origen real de la UI. Vuelva a desplegar después de cambiar variables. En el archivo ignorado `ZonalCache/.env`:

```dotenv
ZC_LOGIN_MODE=ui
ZC_LOGIN_UI_URL=https://<ui>/cache-login
ZC_TICKET_SECRET=<mismo-secreto-que-TICKET_SECRET>
```

`bash deploy/install.sh` crea/actualiza `zc-secrets` y los charts. El secreto debe coincidir en el API y ambas zonas. Si se actualiza un Secret sin cambiar el Deployment, reinicie ambas cachés para cargarlo. Mantenga una réplica por zona: las sesiones y los tickets usados viven en memoria del pod; al reiniciar hay que autenticarse otra vez. La protección contra replay se verifica en la zona receptora, no en un registro global entre zonas.

`POST /api/cache-login` recibe `{domain, pattern, callback, returnTo, username, password}`. Solo acepta el callback HTTPS `https://<mismo-host>/__zc/callback`, sin credenciales, query, fragmento ni puerto alternativo. Comprueba dominio verificado (incluidos comodines), regla `userpass` y bcrypt. Devuelve `{redirectUrl}` con `Cache-Control: no-store`; la UI navega allí. Los tickets ligan dominio, patrón, usuario, expiración y nonce. Hay límite de intentos fallidos. El callback y el retorno heredan el límite de 2000 bytes del servidor C; consultas de retorno demasiado largas reciben 400.

Con cookies Secure, una petición HTTP al recurso protegido primero se redirige al mismo recurso por HTTPS (puerto 443); desde allí inicia el handoff. Así el callback y la sesión posterior usan TLS. El modo de laboratorio con `ZC_COOKIE_SECURE=0` conserva el comportamiento HTTP anterior.

`/__zc/logout` revoca la sesión. El modo `local` permanece para el demo Compose y su panel `/api/cache-test`; ese panel necesita un destino alcanzable por el API y no se habilita con las IP privadas WSL desde Vercel.

## Pruebas reproducibles

```bash
cd api-nodejs
npm test
```

Para la integración real, cree una regla `userpass` `/index.html` de un dominio verificado cuyo origen sea `http://apache-web.default.svc.cluster.local`, y cree un usuario de esa regla. Configure las siguientes variables en su sesión, sin imprimir la contraseña:

```dotenv
HANDOFF_API_URL=https://<api-vercel>
HANDOFF_CACHE_URL=https://<dominio-verificado>/index.html
HANDOFF_USERNAME=<usuario-de-la-regla>
HANDOFF_PASSWORD=<contraseña-de-la-regla>
HANDOFF_TEST_EXPIRY=1
```

`npm run test:k8s-handoff` verifica redirección externa, contraseña inválida, callback ajeno, CORS, ticket firmado, alteración, replay, cookie segura, MISS/HIT en Apache, protección del objeto ya almacenado, logout y expiración real de un ticket no utilizado. Opcionalmente `HANDOFF_CACHE_IP` fija la conexión a una IP de laboratorio preservando Host/SNI. `HANDOFF_ALLOW_SELF_SIGNED=1` se usa solo con el certificado de desarrollo del cache; no deshabilita la validación TLS de los orígenes.

En un navegador, abrir el recurso protegido debe mostrar la UI externa; probar contraseña incorrecta, acceso correcto, recarga y `https://<dominio>/__zc/logout?return_to=/index.html`. El retorno debe volver a pedir credenciales. El navegador tiene que poder resolver y alcanzar la IP zonal; Vercel no necesita conectarse de vuelta a la caché durante este handoff.

El entorno WSL sigue siendo privado y usa certificados autofirmados. La prueba con `geo.test` usa un fixture verificado existente y resolución aislada en el navegador. No demuestra propiedad TXT pública ni disponibilidad del cluster desde Internet.

## Resultado del 9 de noviembre de 2026

| Comprobación | Resultado |
|---|---|
| API Node.js | 66 pruebas aprobadas |
| Caché C (`make test`, también dentro de la imagen) | 345 comprobaciones aprobadas |
| Frontend | Typecheck, lint y build correctos; 2 pruebas de routing aprobadas |
| Tabla real RTDB | 362,998 nodos; metadata/checksum verificados; 14 límites de países y 4 direcciones desconocidas/inválidas comprobados |
| Enrutamiento | API: US→US, CR→CR, IP privada→zona por defecto; interceptor DNS real→IP CR |
| Handoff real | 12 comprobaciones en CR, incluida expiración; 11 en US |
| Navegador | Redirección desde Kubernetes a Vercel, error de contraseña, acceso a Apache, logout y atribución DB-IP verificados |
| HTTP/HTTPS | Ambas zonas: HTTP protegido→HTTPS→UI; sesiones con cookie Secure |
| Limpieza | Regla/usuario temporales y fixtures provisionales Firestore eliminados; configuración limpia confirmada en ambas cachés; archivos temporales de credenciales y forwarder eliminados |

Los servicios quedaron Ready y los PVC Bound. Los cambios de código permanecen sin commit/push; los despliegues Vercel se hicieron mediante CLI. Sincronice estos cambios con Git antes del siguiente deployment automático para evitar que una versión anterior reemplace esta implementación.
