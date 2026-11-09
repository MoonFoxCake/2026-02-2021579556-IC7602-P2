# DNS API (Java)

Componente REST entre el **DNS Interceptor** (Rust), la **DNS UI** (React), la base de datos **Firebase Realtime Database** y el servidor DNS remoto. Está implementado con **Javalin** (sobre Jetty) y **Gson**, en Java 21.

Jetty atiende cada petición HTTP en un hilo de su pool, así que el API soporta múltiples peticiones concurrentes.

Se usa el **diseño B**: el API **informa** el tipo de registro, los targets, su salud y los datos de ubicación o latencia, y el **Interceptor decide** qué IP devolver.

- Contrato con el Interceptor: [CONTRATO_INTERCEPTOR.md](CONTRATO_INTERCEPTOR.md)
- Contrato con la UI: [CONTRATO_DNS_UI.md](CONTRATO_DNS_UI.md)

## Endpoints

| Método | Ruta | Consumidor | Descripción |
|---|---|---|---|
| `GET` | `/health` | Docker/K8s | Healthcheck → `{"status":"UP"}` |
| `POST` | `/api/exists` | Interceptor | `{"domain": "..."}` → `{"domain": "...", "exists": true\|false}` |
| `GET` | `/api/records/{hostname}?sourceIp=` | Interceptor | Tipo, TTL, targets con salud, ubicación del cliente (geo) y latencias (round-trip). 404 si no existe |
| `POST` | `/api/dns_resolver` | Interceptor | `{"data": "<BASE64>"}` → `{"data": "<BASE64>"}` (reenvía el paquete crudo al DNS remoto) |
| `GET` | `/api/ip-to-country/lookup?ip=` | UI / depuración | País, ciudad y coordenadas de una IPv4 |
| `GET` | `/api/ui/summary` | UI | Resumen para dashboard |
| `GET` | `/api/ui/records` | UI | Registros con targets y estado de salud |
| `GET` | `/api/ui/records/{recordId}` | UI | Detalle con el resultado de cada Health Checker |
| `GET` | `/api/ui/health-checkers` | UI | Checkers con ubicación y si están online |
| `GET` | `/api/ui/ip-to-country?limit=&cursor=` | UI | Base IP-to-Country paginada |
| `GET` | `/api/ui/record-types` | UI | Tipos de registro y campos requeridos |

Códigos de error:
- `400`: petición inválida.
- `404`: no existe.
- `502`: Firebase no respondió o rechazó la lectura.
- `504`: timeout del DNS remoto.

## Datos que lee en Firebase

| Ruta | Quién la escribe | Uso en el API |
|---|---|---|
| `/dnsRecords/{recordId}` | DNS UI | Registros: `hostname`, `type`, `enabled`, `ttl`, `targets` |
| `/healthResults/{recordId}/{targetId}/{checkerId}` | Health Checker | Salud por mayoría simple entre checkers y latencias |
| `/healthCheckers/{checkerId}` | Health Checker | Ubicación de cada checker (para round-trip) y `lastSeenAt` |
| `/ipToCountry/{rangeId}` | DNS UI / carga inicial | País y ubicación del cliente (geo y round-trip) |

El formato de cada ruta está en [CONTRATO_DNS_UI.md](CONTRATO_DNS_UI.md).

Las reglas (`firebase/database.rules.json`) incluyen `ipToCountry` con `.indexOn: ["ipFrom"]`. Si el emulador ya estaba corriendo, **reinícienlo** para que cargue las reglas nuevas.

## Conexión con Firebase

Las reglas exigen `auth != null`, así que el API inicia sesión con email y contraseña en Firebase Auth (`accounts:signInWithPassword`). `FirebaseAuth` guarda el `idToken` y lo renueva antes de que expire.

`FirebaseRestClient` hace todas las lecturas por REST:

```
GET {DB_URL}/{ruta}.json?{consulta}&auth=<token>[&ns=<namespace>]
```

## Variables de entorno

La configuración viene de variables de entorno o de un archivo `.env` (ver `.env.example`); no hay valores quemados en el código.

| Variable | Default | Descripción |
|---|---|---|
| `DNS_API_PORT` | `8080` | Puerto HTTP |
| `REMOTE_DNS_SERVER` / `REMOTE_DNS_PORT` | `8.8.8.8` / `53` | DNS remoto para `/api/dns_resolver` |
| `UDP_TIMEOUT_MS` | `2000` | Timeout del DNS remoto |
| `DB_PROVIDER` | `firebase` | Único proveedor soportado |
| `DB_URL` | — | Emulador: `http://127.0.0.1:9000` (en Docker, `http://host.docker.internal:9000`) |
| `DB_API_KEY` | — | Emulador: cualquier valor. Producción: Web API Key |
| `FIREBASE_AUTH_URL` | vacío | Emulador: `http://127.0.0.1:9099`. Producción: vacío |
| `FIREBASE_DATABASE_NAMESPACE` | vacío | Emulador: `p1-redes-a87a7-default-rtdb` |
| `FIREBASE_EMAIL` / `FIREBASE_PASSWORD` | — | Usuario de Firebase Auth; no se usa con cuenta de servicio |
| `GOOGLE_APPLICATION_CREDENTIALS` | vacío | Ruta al JSON de cuenta de servicio; tiene prioridad sobre email/password |
| `DEFAULT_RECORD_TTL` | `60` | TTL si el registro no define `ttl` |
| `HEALTH_RESULT_MAX_AGE_SECONDS` | `0` | Descarta resultados más viejos que esto (0 = sin límite) |
| `HEALTH_UNKNOWN_AS_HEALTHY` | `true` | Un target sin resultados cuenta como healthy |
| `CHECKER_ONLINE_SECONDS` | `120` | Un checker está online si reportó hace menos de esto |
| `CORS_ALLOWED_ORIGIN` | `*` | Origen permitido para la DNS UI |

### Cuenta de servicio (Firebase real)

El API admite el JSON de cuenta de servicio usando la biblioteca oficial Google Auth.
Configure un `.env` local junto a `pom.xml` (no se versiona):

```dotenv
DB_URL=https://<su-proyecto>-default-rtdb.firebaseio.com
GOOGLE_APPLICATION_CREDENTIALS=/ruta/absoluta/cuenta-firebase-adminsdk.json
```

La cuenta debe tener permisos sobre esa base. La clave `p2-redes-b7bab` tiene acceso
al proyecto `p2-redes-b7bab`, no al proyecto anterior `p1-redes-a87a7`; no se migran datos.
`FIREBASE_DATABASE_NAMESPACE` debe quedar sin definir en producción; solo se usa con
el emulador. No se requieren Web API Key ni email/password con esta modalidad.
El token OAuth se renueva automáticamente y se envía en el encabezado Authorization.
Véase [autenticación REST de Firebase](https://firebase.google.com/docs/database/rest/auth).

Las claves `*firebase-adminsdk*.json` se excluyen de Git y del contexto Docker. Nunca
las copie a `src/main/resources` ni dentro del JAR. Para ejecutarlo en Docker, monte
el JSON de solo lectura y defina `GOOGLE_APPLICATION_CREDENTIALS` con la ruta dentro
del contenedor, por ejemplo mediante un override de Compose:

```yaml
services:
  dns-api:
    environment:
      GOOGLE_APPLICATION_CREDENTIALS: /run/secrets/firebase.json
    volumes:
      - ${GOOGLE_APPLICATION_CREDENTIALS}:/run/secrets/firebase.json:ro
```

## Ejecutar

### Con Docker Compose

Desde la raíz del P2, coloque la clave en `secrets/firebase-service-account.json`:

```bash
docker compose up --build -d --wait
```

El servicio se publica en http://127.0.0.1:18083; consulte [la guía local](../docs/LOCAL.md).

### Sin Docker

```bash
cd dns-api
cp .env.example .env
mvn clean package
java -jar target/dns-api.jar
```

## Pruebas

### 1. Pruebas unitarias (no necesitan Firebase)

```bash
cd dns-api
mvn test
```

Las pruebas usan un Firebase falso en memoria (`testutil/FakeFirebase`), así que no dependen del emulador.

| Clase | Qué verifica |
|---|---|
| `FirebaseDnsExistsCheckerTest` | Existe / no existe / deshabilitado / normalización del dominio / error 401 |
| `RecordServiceTest` | Respuesta al Interceptor para `single`, `multi`, `weight`, `geo` y `round-trip`: salud, pesos, país del cliente, checker más cercano, fallbacks de latencia, JSON sin campos que no aplican |
| `HealthEvaluatorTest` | Mayoría simple, empate = unhealthy, `unknown`, resultados viejos |
| `IpToCountryServiceTest` | Conversión IPv4, búsqueda de rangos, IP fuera de rangos, paginación |
| `UiServiceTest` | Estados `healthy`/`degraded`/`down`/`unknown`/`disabled`, detalle por checker, checkers online, resumen |
| `ConfigTest` | Carga de configuración sin requerir credenciales |

### 2. Pruebas de integración (emulador + API corriendo)

1. Iniciar los emuladores: `cd firebase && firebase emulators:start`
2. Iniciar el API (con Docker o sin Docker)
3. En otra terminal (Git Bash en Windows):

```bash
cd dns-api
bash tests/pruebas_integracion.sh
```

El script carga `tests/datos_prueba.json` en el emulador. Ese archivo trae un registro de cada tipo, dos Health Checkers simulados (Cartago y Miami), resultados de salud y rangos IP-to-Country simulados (`127.0.0.0/8` → CR y `8.8.8.0/24` → US). Luego ejecuta **36 verificaciones**:

| Sección | Qué verifica |
|---|---|
| 1 | Login y consulta directa a Firebase, sin Java |
| 2 | `/health` y `/api/exists` (existe, mayúsculas, inexistente, deshabilitado, errores 400) |
| 3 | `/api/records` para cada tipo: TTL, target caído, pesos, país CR/US según `sourceIp`, IP fuera de rangos, latencia desde CR (Cartago, 15 ms) y desde US (Miami, 10 ms), registro sin targets sanos |
| 3b | `/api/ip-to-country/lookup` |
| 3c | Los 6 endpoints de la UI, 404 y CORS |
| 4 | `/api/dns_resolver` con un paquete DNS real y errores 400 |
| 5 | 50 peticiones concurrentes |

### Prueba manual rápida

```bash
curl "http://localhost:8080/api/records/geo.test?sourceIp=8.8.8.8"
curl "http://localhost:8080/api/records/rtt.test?sourceIp=127.0.0.1"
curl  http://localhost:8080/api/ui/summary
curl  http://localhost:8080/api/ui/records/prueba-multi
```

## Estructura

```
dns-api/
├── pom.xml, Dockerfile, .env.example
├── Funcionamiento DNS API.md
├── CONTRATO_INTERCEPTOR.md              # contrato diseño B con el Interceptor
├── CONTRATO_DNS_UI.md                   # endpoints para la UI y formato de datos en Firebase
├── tests/
│   ├── pruebas_integracion.sh
│   └── datos_prueba.json                # datos de los 5 tipos para el emulador
└── src/
    ├── main/java/cr/ac/tec/ic7602/dnsapi/
    │   ├── App.java                     # arranque, CORS y rutas
    │   ├── config/Config.java
    │   ├── dns/                         # DnsExistsChecker, UdpDnsClient
    │   ├── firebase/                    # FirebaseAuth, FirebaseRestClient, FirebaseDnsExistsChecker
    │   ├── geo/                         # Ipv4, GeoDistance, IpToCountryService
    │   ├── health/                      # HealthEvaluator, TargetHealth, CheckerResult
    │   ├── model/                       # RecordTypes, ResolveResponse, TargetInfo, ClientLocation, ...
    │   │   └── ui/UiModels.java         # vistas para la UI
    │   ├── service/                     # DnsDataRepository, RecordService, UiService, LatencyEstimator
    │   └── http/                        # handlers, Json, Cors
    └── test/java/cr/ac/tec/ic7602/dnsapi/
        ├── testutil/                    # FakeFirebase, TestData
        ├── firebase/  service/  health/  geo/  config/
```

## Pendientes

- [ ] Que el Interceptor consuma `/api/records/{hostname}` y aplique las estrategias (ver `CONTRATO_INTERCEPTOR.md`).
- [ ] Cargar una base IP-to-Country real en `/ipToCountry` (por ejemplo, IP2Location LITE).
- [ ] Reglas de escritura en Firebase para la DNS UI.
