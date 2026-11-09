# Contrato DNS API ↔ DNS UI

El DNS API expone endpoints **de solo lectura** con la información ya combinada para mostrar en la DNS UI: registros con sus targets, el estado de salud agregado, el detalle de cada Health Checker, un resumen para dashboard y la base IP-to-Country.

La UI no tiene que cruzar `/dnsRecords`, `/healthResults` y `/healthCheckers` por su cuenta, ni aplicar la mayoría simple de salud: el API ya lo hace.

Según la arquitectura del enunciado, **crear, modificar y borrar** registros lo hace la UI directamente en Firebase. Más abajo está el formato que el API espera leer.

## Configuración

- URL base: `http://localhost:8080`, o el puerto de `DNS_API_PORT`.
- **CORS** ya está habilitado. El origen permitido se configura con `CORS_ALLOWED_ORIGIN` (por defecto `*`; por ejemplo, `http://localhost:5173` para Vite).
- Todas las respuestas son JSON en UTF-8. Los campos que no aplican no vienen en el JSON.
- Si Firebase no responde, el API devuelve `502` con `{"error": "..."}`.

## Endpoints

| Método | Ruta | Para qué sirve en la UI |
|---|---|---|
| `GET` | `/api/ui/summary` | Tarjetas del dashboard |
| `GET` | `/api/ui/records` | Tabla de registros con su estado |
| `GET` | `/api/ui/records/{recordId}` | Detalle de un registro: targets, health checks y resultado por checker (404 si no existe) |
| `GET` | `/api/ui/health-checkers` | Lista o mapa de Health Checkers y si están online |
| `GET` | `/api/ui/ip-to-country?limit=50&cursor=` | Tabla paginada de la base IP-to-Country |
| `GET` | `/api/ui/record-types` | Tipos de registro y campos requeridos, para armar formularios |
| `GET` | `/api/ip-to-country/lookup?ip=8.8.8.8` | Probar a qué país corresponde una IP |

### Estados

**Estado de un target** (`healthStatus`):
- `healthy`: la mayoría de los checkers lo reporta bien.
- `unhealthy`: no hay mayoría a favor; un empate cuenta como unhealthy.
- `unknown`: todavía no hay resultados.

**Estado de un registro** (`status`):
- `healthy`: ningún target caído.
- `degraded`: algunos targets caídos.
- `down`: todos los targets caídos.
- `unknown`: sin resultados todavía.
- `disabled`: `enabled: false`.

Sugerencia de colores: verde, amarillo, rojo, gris y gris tachado, en ese orden.

**Health Checker** (`online`): reportó hace menos de `CHECKER_ONLINE_SECONDS` (120 s por defecto).

## Ejemplos reales

`GET /api/ui/summary`:

```json
{"totalRecords":9,"enabledRecords":7,
 "recordsByType":{"single":5,"multi":1,"round-trip":1,"weight":1,"geo":1},
 "recordsByStatus":{"down":1,"unknown":4,"degraded":1,"disabled":2,"healthy":1},
 "targets":{"healthy":2,"unhealthy":2,"unknown":10},
 "healthCheckersTotal":2,"healthCheckersOnline":2,"generatedAt":"2026-09-27T09:48:51.973Z"}
```

`GET /api/ui/records` devuelve `{"count": N, "records": [ ... ]}`. Cada elemento tiene la misma forma que el detalle.

`GET /api/ui/records/prueba-rtt` (recortado a un target):

```json
{"id":"prueba-rtt","hostname":"rtt.test","type":"round-trip","enabled":true,"ttl":60,"status":"healthy",
 "health":{"healthy":2,"unhealthy":0,"unknown":0},
 "targets":[
  {"id":"t1","address":"10.0.4.1","healthCheck":{},"healthStatus":"healthy","healthy":true,
   "healthyVotes":2,"totalVotes":2,
   "checkerResults":[
    {"checkerId":"prueba-checker-cartago","healthy":true,"attempts":3,"successes":3,"latencyMs":15.0,
     "checkedAt":1790502443482,"checkedAtIso":"2026-09-27T09:47:23.482Z","stale":false},
    {"checkerId":"prueba-checker-miami","healthy":true,"attempts":3,"successes":3,"latencyMs":120.0,
     "checkedAt":1790502443482,"checkedAtIso":"2026-09-27T09:47:23.482Z","stale":false}]}]}
```

Cada target trae además `port`, `weight` y `country` si están definidos. `healthCheck` es el objeto tal como está guardado en Firebase.

`GET /api/ui/health-checkers`:

```json
{"count":2,"online":2,"healthCheckers":[
 {"id":"prueba-checker-cartago","city":"Cartago","country":"CR","latitude":9.8644,"longitude":-83.9194,
  "lastSeenAt":1790502443482,"lastSeenAtIso":"2026-09-27T09:47:23.482Z","secondsSinceLastSeen":88,"online":true}]}
```

`GET /api/ui/ip-to-country?limit=2`:

```json
{"items":[
  {"id":"prueba-google","startIp":"8.8.8.0","endIp":"8.8.8.255","ipFrom":134744064,"ipTo":134744319,
   "countryCode":"US","countryName":"United States (simulado)","city":"Miami","latitude":25.7617,"longitude":-80.1918},
  {"id":"prueba-loopback","startIp":"127.0.0.0","endIp":"127.255.255.255","ipFrom":2130706432,"ipTo":2147483647,
   "countryCode":"CR","countryName":"Costa Rica (simulado)","city":"San José","latitude":9.9281,"longitude":-84.0907}]}
```

Cuando hay más rangos, la respuesta incluye `"nextCursor": "<id>"`; para la siguiente página se envía `cursor=<nextCursor>`. En el ejemplo no viene porque solo hay 2 rangos, así que esa es la última página. El `limit` máximo es 500.

`GET /api/ui/record-types` devuelve, para cada tipo, `description`, `minTargets`, `maxTargets` y `requiredTargetFields`. También devuelve los campos de los health checks `tcp` y `http`.

## Ejemplo en React

```jsx
const API_URL = import.meta.env.VITE_DNS_API_URL ?? "http://localhost:8080";

export async function getRecords() {
  const res = await fetch(`${API_URL}/api/ui/records`);
  if (!res.ok) throw new Error(`DNS API respondió ${res.status}`);
  return (await res.json()).records;
}

// Uso
const [records, setRecords] = useState([]);
useEffect(() => { getRecords().then(setRecords).catch(console.error); }, []);
```

## Formato que la UI debe escribir en Firebase

Para que el API, el Health Checker y el Interceptor puedan leer lo que la UI crea, usen esta estructura.

### `/dnsRecords/{recordId}`

```json
{
  "hostname": "ejemplo.test",
  "type": "single | multi | round-trip | weight | geo",
  "enabled": true,
  "ttl": 60,
  "targets": {
    "{targetId}": {
      "address": "10.0.0.1",
      "port": 80,
      "weight": 3,
      "country": "CR",
      "healthCheck": { }
    }
  }
}
```

- `hostname` va en minúsculas y sin punto final.
- `ttl` es opcional (por defecto `DEFAULT_RECORD_TTL`).
- `weight` solo aplica en registros `weight` (entero ≥ 1).
- `country` solo aplica en registros `geo` (ISO de 2 letras).

`healthCheck` para **TCP**:

```json
{ "protocol": "tcp", "timeoutMs": 2000, "retries": 2, "intervalSeconds": 30 }
```

`healthCheck` para **HTTP**:

```json
{ "protocol": "http", "path": "/health", "timeoutMs": 2000, "retries": 2, "intervalSeconds": 30,
  "expectedStatusCodes": [200, 204], "basicAuthSecretRef": "nombre-del-secreto" }
```

`basicAuthSecretRef` es opcional. Estos son los nombres que ya lee el Health Checker (`firebase_client.c`).

### `/ipToCountry/{rangeId}`

```json
{ "ipFrom": 134744064, "ipTo": 134744319, "startIp": "8.8.8.0", "endIp": "8.8.8.255",
  "countryCode": "US", "countryName": "United States",
  "city": "Miami", "latitude": 25.7617, "longitude": -80.1918 }
```

- `ipFrom` e `ipTo` son **números**: `a*16777216 + b*65536 + c*256 + d`. El API los usa para buscar el rango, con el índice `.indexOn: ["ipFrom"]` definido en las reglas.
- `city`, `latitude` y `longitude` son opcionales, pero mejoran el cálculo de `round-trip`.
- El formato coincide con las bases IP2Location LITE (`ip_from, ip_to, country_code, country_name`).

### Permisos de escritura

Las reglas (`firebase/database.rules.json`) permiten escribir en `dnsRecords`, `ipToCountry` y `healthResults` solo a usuarios marcados como administradores en `/admins/{uid} = true`. En el emulador, `DNS_UI/scripts/crear_admin.sh` crea el usuario y lo marca como administrador. La implementación de la UI está en `DNS_UI/`.
