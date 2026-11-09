# Contrato DNS API ↔ DNS Interceptor (diseño B)

En el **diseño B**, el DNS API **informa** y el DNS Interceptor **decide**:

- El API devuelve el tipo del registro (`single`, `multi`, `round-trip`, `weight`, `geo`), todos sus targets con su estado de salud y, según el tipo, la ubicación del cliente o la latencia estimada.
- El Interceptor aplica la estrategia, elige la IP y arma la respuesta DNS.

## Flujo en el Interceptor

```
Llega un paquete DNS
│
├─ ¿QR = 0 y OPCODE = 0 (query estándar) y QTYPE = A?
│     no → POST /api/dns_resolver (caso 1 del enunciado)
│
└─ sí → GET /api/records/{hostname}?sourceIp={IP de origen}
          ├─ 404 (found:false)       → POST /api/dns_resolver
          ├─ 502 / error de red      → POST /api/dns_resolver
          └─ 200 → filtrar targets con healthy == true
                    ├─ ninguno healthy → POST /api/dns_resolver
                    └─ aplicar la estrategia según "type" → armar respuesta A con esa IP y "ttl"
```

Con este endpoint ya no hace falta llamar a `/api/exists` antes: el 404 indica que el registro no existe.

> **Nota sobre el código actual del Interceptor:** hoy envía `{"Viene de": ...}` a `/api/exists`, pero el API espera `{"domain": ...}` y responde 400.

## Endpoint

```
GET /api/records/{hostname}?sourceIp={ipv4}
```

| Parámetro | Descripción |
|---|---|
| `hostname` | Nombre consultado. Se normaliza: no importan las mayúsculas ni el punto final (`Geo.Test.` = `geo.test`). |
| `sourceIp` | IPv4 de origen de la consulta DNS. **Necesaria para `geo` y `round-trip`**; en los demás tipos se ignora. |

## Respuesta 200

| Campo | Tipo | Descripción |
|---|---|---|
| `found` | bool | Siempre `true` en 200 |
| `hostname` | string | Hostname del registro |
| `recordId` | string | Id del registro en Firebase. Úsenlo como llave del contador round-robin |
| `type` | string | `single`, `multi`, `round-trip`, `weight` o `geo` |
| `ttl` | int | TTL (segundos) para la respuesta DNS |
| `client` | objeto? | Solo en `geo` y `round-trip` con `sourceIp`: ubicación del cliente (ver abajo) |
| `healthyTargetCount` | int | Cantidad de targets con `healthy: true` |
| `targets` | lista | Todos los targets, incluidos los caídos |

Cada **target**:

| Campo | Tipo | Cuándo viene | Descripción |
|---|---|---|---|
| `id` | string | siempre | Id del target |
| `address` | string | siempre | IPv4 a devolver |
| `port` | int? | si está definido | Puerto del servicio (no se usa en la respuesta DNS) |
| `healthy` | bool | siempre | **Usar solo targets con `true`** |
| `healthStatus` | string | siempre | `healthy`, `unhealthy` o `unknown` (sin resultados todavía; cuenta como healthy por defecto) |
| `weight` | int | `weight` | Peso ≥ 1 (1 si no se definió) |
| `country` | string? | si está definido | Código ISO de 2 letras en mayúscula (`geo`) |
| `latencyMs` | float? | `round-trip` | Latencia estimada desde la ubicación del cliente |
| `latencySource` | string? | `round-trip` | `nearest-checker`, `same-city`, `same-country` o `average` |
| `latencyCheckerId` | string? | `round-trip` | Checker cuya medición se usó |
| `latencyDistanceKm` | float? | `round-trip` | Distancia cliente ↔ checker |

**`client`** (ubicación según la base IP-to-Country):

| Campo | Descripción |
|---|---|
| `ip` | La `sourceIp` recibida |
| `found` | `false` si la IP no está en ningún rango cargado |
| `countryCode` | ISO de 2 letras (si `found`) |
| `countryName`, `city`, `latitude`, `longitude`, `rangeId` | Si existen en el rango |

Los campos que no aplican **no vienen** en el JSON (no vienen como `null`).

## Respuesta 404 y errores

```json
{"found":false,"hostname":"no-existe.test"}
```

`502` significa que Firebase no respondió. En ese caso, igual que con 404, reenvíen con `/api/dns_resolver`.

## Qué hace el Interceptor con cada tipo

Siempre sobre los targets con `healthy == true`:

| Tipo | Estrategia | Estado necesario en el Interceptor |
|---|---|---|
| `single` | El único target | — |
| `multi` | Round-robin: `targets[contador % n]` y luego `contador += 1` | Contador por `recordId` (`Mutex<HashMap<String, usize>>`) |
| `weight` | Aleatorio ponderado por `weight` | — (crate `rand`) |
| `geo` | Targets con `country == client.countryCode`. Si no hay (o `client.found == false`), **uno al azar** | — |
| `round-trip` | El de menor `latencyMs`. Los que no tienen `latencyMs` van al final | — |

## Ejemplos reales

`GET /api/records/multi.test`, con el target t3 caído:

```json
{"found":true,"hostname":"multi.test","recordId":"prueba-multi","type":"multi","ttl":60,"healthyTargetCount":2,
 "targets":[
  {"id":"t1","address":"10.0.1.1","healthy":true,"healthStatus":"unknown"},
  {"id":"t2","address":"10.0.1.2","healthy":true,"healthStatus":"unknown"},
  {"id":"t3","address":"10.0.1.3","healthy":false,"healthStatus":"unhealthy"}]}
```

`GET /api/records/weight.test`:

```json
{"found":true,"hostname":"weight.test","recordId":"prueba-weight","type":"weight","ttl":60,"healthyTargetCount":2,
 "targets":[
  {"id":"t1","address":"10.0.2.1","healthy":true,"healthStatus":"unknown","weight":3},
  {"id":"t2","address":"10.0.2.2","healthy":true,"healthStatus":"unknown","weight":1}]}
```

`GET /api/records/geo.test?sourceIp=8.8.8.8`:

```json
{"found":true,"hostname":"geo.test","recordId":"prueba-geo","type":"geo","ttl":60,
 "client":{"ip":"8.8.8.8","found":true,"rangeId":"prueba-google","countryCode":"US","countryName":"United States (simulado)","city":"Miami","latitude":25.7617,"longitude":-80.1918},
 "healthyTargetCount":2,
 "targets":[
  {"id":"cr","address":"10.0.3.1","healthy":true,"healthStatus":"unknown","country":"CR"},
  {"id":"us","address":"10.0.3.2","healthy":true,"healthStatus":"unknown","country":"US"}]}
```

`GET /api/records/rtt.test?sourceIp=127.0.0.1`:

```json
{"found":true,"hostname":"rtt.test","recordId":"prueba-rtt","type":"round-trip","ttl":60,
 "client":{"ip":"127.0.0.1","found":true,"rangeId":"prueba-loopback","countryCode":"CR","countryName":"Costa Rica (simulado)","city":"San José","latitude":9.9281,"longitude":-84.0907},
 "healthyTargetCount":2,
 "targets":[
  {"id":"t1","address":"10.0.4.1","healthy":true,"healthStatus":"healthy","latencyMs":15.0,"latencySource":"nearest-checker","latencyCheckerId":"prueba-checker-cartago","latencyDistanceKm":20.06},
  {"id":"t2","address":"10.0.4.2","healthy":true,"healthStatus":"healthy","latencyMs":80.0,"latencySource":"nearest-checker","latencyCheckerId":"prueba-checker-cartago","latencyDistanceKm":20.06}]}
```

## Structs de Rust sugeridos (serde)

Los campos `Option` aceptan que el campo no venga en el JSON.

```rust
use serde::Deserialize;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecordInfo {
    pub found: bool,
    pub hostname: Option<String>,
    pub record_id: Option<String>,
    #[serde(rename = "type")]
    pub record_type: Option<String>,
    pub ttl: Option<u32>,
    pub client: Option<ClientLocation>,
    pub healthy_target_count: Option<u32>,
    #[serde(default)]
    pub targets: Vec<Target>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClientLocation {
    pub ip: String,
    pub found: bool,
    pub country_code: Option<String>,
    pub city: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Target {
    pub id: String,
    pub address: String,
    pub healthy: bool,
    pub health_status: String,
    pub weight: Option<u32>,
    pub country: Option<String>,
    pub latency_ms: Option<f64>,
}
```

## Cómo se calcula la información

- **Salud por target:** cada Health Checker escribe su resultado en `/healthResults/{recordId}/{targetId}/{checkerId}`. El API aplica la **mayoría simple entre checkers** (un empate cuenta como unhealthy). Sin resultados, el target queda `unknown` y cuenta como healthy (configurable con `HEALTH_UNKNOWN_AS_HEALTHY`). Con `HEALTH_RESULT_MAX_AGE_SECONDS` se descartan resultados viejos.
- **Ubicación del cliente:** se busca `sourceIp` en `/ipToCountry` (rangos `ipFrom`–`ipTo` numéricos).
- **Latencia (round-trip):** se usa la medición del Health Checker más cercano al cliente, por coordenadas. Si no hay coordenadas, se usan los checkers de la misma ciudad o del mismo país; si tampoco, el promedio de todos.
- **Alcance:** solo se soporta IPv4 (registros A).
