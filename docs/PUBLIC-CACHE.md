# Panel público de caché — 9 de noviembre de 2026

## Conexión desplegada

```text
Navegador → UI Vercel /api/* → Node API Vercel (JWT + propietario)
          → HTTPS redes-panel-{cr,us}.centrodecapacitaciongyg.com
          → Cloudflare Tunnel → gateway nginx (clave privada)
          → caché C de la zona → Apache / Java / origen HTTP(S)

Node API → Firestore: dominios, reglas, claves y usuarios de URL
Interceptor DNS → Node API → RTDB /ipToCountry: país y zona
```

El selector **Zona de caché** fija CR o US para la demostración; no prueba geolocalización automática. El DNS Interceptor UDP 53 y las IP MetalLB siguen siendo privados. Cloudflare Tunnel publica HTTP/HTTPS y no convierte esas IP en direcciones públicas.

| Host | Destino |
|---|---|
| `redes-cr.centrodecapacitaciongyg.com` | Caché CR, acceso directo del navegador |
| `redes-us.centrodecapacitaciongyg.com` | Caché US, acceso directo del navegador |
| `redes-panel-cr.centrodecapacitaciongyg.com` | Gateway autenticado → caché CR |
| `redes-panel-us.centrodecapacitaciongyg.com` | Gateway autenticado → caché US |

Los cuatro CNAME proxied apuntan al túnel `ic7602-p2-wsl` (`cd80ff92-d98a-47b7-b930-a7adea3fd79f`). Los TXT `_p2redes.redes-cr` y `_p2redes.redes-us` se validaron mediante el API normal de producción. Los registros originales del sitio principal y del correo se conservaron.

## Variables y despliegue

En el API Vercel:

```dotenv
CACHE_TEST_URLS={"cr":"https://redes-panel-cr.centrodecapacitaciongyg.com","us":"https://redes-panel-us.centrodecapacitaciongyg.com"}
CACHE_TEST_TUNNEL_KEY=<64 caracteres hex aleatorios; igual al gateway>
CACHE_TEST_LOGIN_MODE=ui
CACHE_TEST_COOKIE_SECURE=1
```

Conserve `TICKET_SECRET`, las credenciales Firebase y el resto de variables existentes. La clave del gateway pertenece solo al backend y Kubernetes; no use un prefijo `VITE_`. La UI usa `VITE_API_BASE_URL=/api` y `API_PROXY_ORIGIN=https://proyecto-redes-2-api.vercel.app` en su proyecto Vercel. `frontend/vercel.mjs` valida el origen inyectado y configura el rewrite antes del fallback SPA, para que las cookies sean del mismo origen del navegador.

El API valida JWT, propiedad del dominio verificado y regla. El cliente puede elegir una zona configurada, pero no un destino arbitrario. El gateway valida la clave, restaura el Host del recurso y elimina los encabezados privados antes de reenviar a la caché. El cuerpo mostrado se limita a 64 KiB y se presenta como texto. Cada sesión usa una cookie HttpOnly/Secure/SameSite=Lax aislada por cuenta, regla y zona.

El chart `helm/public-cache` despliega `cloudflared` y nginx en un pod. El conector y nginx verifican el certificado interno de `zc-tls` y su nombre; no se deshabilitó TLS. El certificado interno actual expira el **9 de diciembre de 2026**: renueve `zc-tls` y vuelva a desplegar el gateway/conector antes de esa fecha.

Para instalar o actualizar desde Bash en la copia Linux, exporte las variables de su configuración privada:

```bash
cd /home/antho/ic7602-p2-deployment
export P2_TEST_BASE_DOMAIN=centrodecapacitaciongyg.com
export P2_TUNNEL_ID=cd80ff92-d98a-47b7-b930-a7adea3fd79f
export P2_TUNNEL_CREDENTIALS=/home/antho/.cloudflared/cd80ff92-d98a-47b7-b930-a7adea3fd79f.json
# Cargue CACHE_TEST_TUNNEL_KEY desde su archivo privado, sin imprimirlo.
bash deploy/public-cache.sh
kubectl get pods,svc,pvc
kubectl rollout status deployment/public-cache
```

Las credenciales del túnel y `.env.public-cache` son archivos privados ignorados por Git. Reanude Docker/Minikube según [WSL-DEPLOYMENT.md](WSL-DEPLOYMENT.md). El pod reconecta el túnel automáticamente cuando el cluster vuelve a estar disponible; Windows y WSL deben permanecer encendidos.

## Cloudflare: causa del bloqueo

Security → Analytics → Events mostró **Bot fight mode / Managed Challenge** para GET de Vercel a `redes-panel-cr.../index.html`. El gateway respondía correctamente desde Windows, pero Vercel recibía una página HTML «Just a moment…» con 403.

Se desactivó **Bot Fight Mode** para esta zona con aprobación explícita del propietario. La edición gratuita es global y no permite excepciones mediante WAF custom rules; [documentación oficial](https://developers.cloudflare.com/bots/get-started/bot-fight-mode/). Los registros originales de web/correo son DNS-only; los cuatro hosts del proyecto son los que actualmente pasan por el proxy. Esta decisión también afectará a futuros hosts proxied de la zona. Si necesita protección de bots con excepciones, revise un plan compatible antes de reactivarla. El gateway sigue rechazando peticiones sin su clave privada.

## Repetir la demostración en la UI

Abra [la UI](https://proyecto-redes-2.vercel.app/), inicie sesión con `anthony@test.com` y vaya a **Acceso a caché**. La cuenta de administración y el usuario del recurso son distintos.

| Dominio | Regla | Origen / autenticación |
|---|---|---|
| `redes-cr.centrodecapacitaciongyg.com` | `/index.html` | Apache interno, pública |
| `redes-cr.centrodecapacitaciongyg.com` | `/api/*` | Java interno, API key; probar `/api/items.json` |
| `redes-cr.centrodecapacitaciongyg.com` | `/gyg.html` | Sitio HTTPS existente, pública |
| `redes-us.centrodecapacitaciongyg.com` | `/index.html` | Apache interno, usuario `demo-cache` |

Las cuatro reglas de demostración usan 2 MB, LRU y TTL de 15 segundos. Se conservaron como recursos de demostración aprobados. La clave y contraseña generadas están en el archivo privado local `tmp/p2-public-cache/demo-credentials.json`, fuera del repositorio. No son la contraseña de la cuenta de administración.

1. Seleccione zona CR, dominio CR y `/index.html`; pulse **Probar MISS → HIT**. Debe ver HTTP 200, MISS y HIT, zona `cr`, LRU y TTL 15.
2. Cambie solo la zona a US y repita. Debe ver `us`; esto prueba el otro pod con el mismo recurso.
3. Seleccione `/api/*`: sin clave o con clave incorrecta, HTTP 401. Con la clave aprobada, `/api/items.json` devuelve JSON y MISS → HIT.
4. Seleccione el dominio US y su regla `/index.html`. Sin sesión se requiere login; una contraseña incorrecta se rechaza. Use `demo-cache` y la contraseña del archivo privado; después pruebe MISS → HIT.
5. Cambie de zona: requiere otra sesión. Cerrar sesión en una zona no cierra la otra. Cierre ambas al terminar y compruebe que vuelve a pedir login.
6. Seleccione el dominio CR y `/gyg.html` para mostrar el origen externo HTTPS. Espere más de 15 segundos y envíe el mismo recurso para observar un nuevo MISS por expiración.

La regla adicional `/` del dominio CR tenía `http://apache:80`, inexistente en este cluster. Se corrigió únicamente su origen a `http://apache-web.default.svc.cluster.local`; la configuración tarda unos segundos en refrescarse. Para demostrar caché por extensión use las reglas explícitas anteriores.

## Evidencia y límites

Pasaron 14 comprobaciones de producción a través del proxy Vercel: JWT obligatorio, configuración CR/US, rechazo de zona arbitraria, Apache MISS/HIT, Java sin clave y con clave, ticket/login/cookie segura/logout y origen HTTPS externo en ambas zonas, más expiración TTL.

En Chrome se comprobaron CR/US MISS/HIT, JSON con clave válida, rechazo de claves ausentes/incorrectas, contraseña incorrecta, login correcto, borrado del campo contraseña, cookie segura del origen de la UI, sesiones independientes por zona y cierre de ambas sesiones. Las pruebas no crearon elementos Java ni recursos temporales adicionales.

La ampliación técnica validó también UDP real desde clientes aislados con direcciones de origen CR/US contra el LoadBalancer Kubernetes, usando DB-IP real, y un sitio externo HTTP sin redirección a HTTPS. El Service DNS ahora usa `externalTrafficPolicy: Local`: la misma prueba fallaba con `Cluster`. `make check` también verificó los cinco algoritmos de expulsión con objetos reales en disco. Pasos y límites: [TECHNICAL-VALIDATION.md](TECHNICAL-VALIDATION.md). No se afirma disponer de clientes físicos en ambos países, DNS geográfico público ni pruebas de carga masiva.
