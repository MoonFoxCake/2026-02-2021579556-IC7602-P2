# Validación técnica — 9 de noviembre de 2026

## Integración aislada

Se instaló Node.js 24.22.2 en Ubuntu WSL y se validó una copia nueva del código, sin `.env`, credenciales Firebase ni binarios anteriores. Desde un checkout Linux con Node >=20, GNU C, libcurl/OpenSSL, curl, openssl y dig:

```bash
cd api-nodejs
npm ci
npm test
cd ../ZonalCache
make check
```

Resultado: **69 tests del API** y **450 comprobaciones C/integración** sin fallos: 345 unitarias, 29 E2E de autenticación, 49 de proxy/políticas, 16 C↔API y 11 DNS↔API↔CR/US↔origen.

`test/serve-memory.js` ahora monta el router DNS real y utiliza los orígenes inyectados. Su adaptador de países es exclusivo del fixture y nunca conecta a Firebase. La prueba inspecciona las IP que el interceptor realmente envió al API. Los puertos HTTP de prueba son 18380/18381 para evitar el stack Compose; pueden cambiarse con `ZC_E2E_HTTP_PORT` y `ZC_E2E_API_HTTP_PORT`. `.gitattributes` conserva LF en scripts Bash al clonar desde Windows.

## IP original y selección geográfica en Kubernetes

El chart DNS usa `externalTrafficPolicy: Local` para LoadBalancer/NodePort. Con `Cluster`, la regresión real devolvía CR al cliente de prueba US; con `Local`, la misma petición devolvió US. El país no se fuerza mediante parámetros ni variables del API.

Desde WSL, con el cluster activo:

```bash
sudo env \
  P2_API_URL=https://proyecto-redes-2-api.vercel.app \
  P2_DNS_IP=192.168.49.242 P2_CR_IP=192.168.49.240 P2_US_IP=192.168.49.241 \
  P2_DOMAIN=redes-cr.centrodecapacitaciongyg.com \
  P2_CR_SOURCE_IP=181.193.0.1 P2_US_SOURCE_IP=8.8.8.8 \
  bash deploy/test-geographic-routing.sh
```

El script valida el país mediante el API/RTDB real, crea clientes en namespaces Linux externos al nodo Kubernetes y envía UDP real al LoadBalancer. Sus direcciones de origen son sintéticas dentro del laboratorio. No tienen ruta por defecto a Internet: solo alcanzan el DNS y la caché seleccionada. Interfaces, rutas y reglas de forwarding temporales se eliminan al terminar, incluso si falla una aserción.

| Origen sintético | DB-IP real | Respuesta DNS | HTTP usando esa IP |
|---|---|---|---|
| 181.193.0.1 | CR | 192.168.49.240 | Zona cr, 200, MISS → HIT |
| 8.8.8.8 | US | 192.168.49.241 | Zona us, 200, MISS → HIT |

Esto valida IP original y enrutamiento en el laboratorio. No afirma que existan clientes físicos en ambos países ni publica UDP 53 por Cloudflare Tunnel. El selector manual del panel se comprueba por separado.

## Sitio externo HTTP real

`http://http.badssl.com/style.css` respondió **200 por HTTP, sin redirección HTTPS**. Una regla temporal `/style.css` del dominio CR usó 1 MB, LRU y TTL 3 segundos. Ambas zonas devolvieron MISS, HIT y un nuevo MISS tras expirar. El SHA-256 del origen y de ambas cachés coincidió:

`0e755b89c8859e52f62869c84913efb0d11c48734437c93c506c210be2157e6b`

La regla se eliminó al terminar; se conservaron las reglas y credenciales de demostración. Para repetir, configure en una terminal privada:

```dotenv
EXTERNAL_HTTP_API_URL=https://proyecto-redes-2.vercel.app/api
EXTERNAL_HTTP_ADMIN_TOKEN=<JWT de su cuenta de administración>
EXTERNAL_HTTP_DOMAIN=redes-cr.centrodecapacitaciongyg.com
EXTERNAL_HTTP_ORIGIN=http://http.badssl.com
EXTERNAL_HTTP_PATH=/style.css
```

Desde `api-nodejs`: `npm run test:external-http`. Requiere un dominio propio verificado y destinos del panel configurados. Se niega a modificar un patrón existente, espera el refresco y elimina solo su propia regla. Si el sitio externo cambia, elija otro recurso HTTP pequeño con extensión y respuesta 200.

## Instalación Compose limpia

Con Docker Engine/Desktop y Compose >=2.24.4, desde Bash: `bash deploy/test-compose.sh`. No requiere Node/Java/Firebase instalados en el host. Construye los componentes, ejecuta health checks y `local-smoke`, y elimina únicamente su proyecto temporal y sus volúmenes al terminar. No carga `.env` de producción ni publica puertos: puede ejecutarse junto al despliegue de demostración.

La primera validación desde la copia nueva pasó: tres tests Java, UI/proxy del mismo origen, login del emulador, CRUD Java mediante caché, Apache, UDP DNS y login CSRF/MISS/HIT/logout del panel. No se reutilizaron datos de Firestore de producción.

## Vercel y límites operativos

La UI conserva `VITE_API_BASE_URL=/api`. `API_PROXY_ORIGIN` configura el destino HTTPS en `frontend/vercel.mjs`, sin URL de producción fija en código. Cuatro tests validan routing y rechazo de orígenes inseguros. La UI fue publicada nuevamente: deployment `dpl_A9gvAAZ3Q2HjDLUKAaXG1TbYU5sQ`.

Para el deployment automático, integre los cambios revisados en `main` y sincronice el repositorio vinculado a Vercel. Windows/WSL deben permanecer activos. El certificado interno expira el 9 de diciembre de 2026; Bot Fight Mode permanece desactivado con autorización del propietario. No se hizo una prueba de carga masiva o alta disponibilidad.
