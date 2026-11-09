# Despliegue WSL validado - 9 de noviembre de 2026

## Alcance y estado

Se desplegaron DNS Interceptor, cachés CR/US, Java REST API y Apache en Minikube dentro de Ubuntu-24.04. Las cachés consultan el API de producción `https://proyecto-redes-2-api.vercel.app`, que accede a Firestore `p2-redes-b7bab`.

Es un despliegue local: las direcciones siguientes son accesibles desde Ubuntu WSL, no desde Internet. No se configuró `CACHE_TEST_URL` con una IP privada porque Vercel no podría alcanzarla. No se validó TXT público: el equipo no dispone de un dominio ni de un endpoint público. Ambas cachés usan ahora `ZC_LOGIN_MODE=ui`; el handoff externo y DB-IP están implementados y verificados según [GEO-LOGIN.md](GEO-LOGIN.md).

| Servicio | Dirección observada | Puerto |
|---|---|---|
| DNS Interceptor | 192.168.49.242 | UDP 53 |
| Caché CR | 192.168.49.240 | HTTP 80 / HTTPS 443 |
| Caché US | 192.168.49.241 | HTTP 80 / HTTPS 443 |
| Java (interno) | rest-api-java.default.svc.cluster.local | HTTP 8080 |
| Apache (interno) | apache-web.default.svc.cluster.local | HTTP 80 |

Los puertos e IP deben consultarse de nuevo si se recrea el cluster o los Services. Los dominios existentes terminados en `.test` son datos de prueba y no demuestran propiedad de un dominio público.

## Entorno instalado

- Ubuntu-24.04 en WSL 2, usuario `antho`.
- Docker Engine 29.1.3 dentro de Ubuntu, separado de Docker Desktop.
- Minikube 1.39.0, Kubernetes 1.37.0, kubectl 1.37.2 y Helm 3.22.1.
- Cluster `minikube`: 4 CPU y 4096 MiB de RAM.
- Dos PVC de 1 GiB, uno por caché.
- Copia Linux del código: `/home/antho/ic7602-p2-deployment`, inicialmente desde el commit `5391239b19bd3dfde79c43327348df09c76aa173`.
- La configuración de servicios se guarda en `ZonalCache/.env`, ignorada por Git. `ZC_CONFIG_TOKEN` coincide con `SERVICE_KEY` del API; no copie secretos a esta documentación.

Se mantuvo Ubuntu activo con un proceso WSL oculto mientras se ejecuta esta demostración. Un reinicio o terminación de WSL requiere volver a iniciar Docker y Minikube.

## Red local con MetalLB

El túnel de Minikube entregaba la misma IP `127.0.0.1` a ambas zonas. Se sustituyó por el chart oficial de MetalLB en modo L2. No ejecutar `minikube tunnel` con esta configuración.

Dentro de Ubuntu WSL, con Docker y Minikube iniciados:

```bash
helm repo add metallb https://metallb.github.io/metallb
helm repo update metallb
helm upgrade --install metallb metallb/metallb \
  --version 0.16.2 \
  --namespace metallb-system --create-namespace \
  --set speaker.frr.enabled=false --set frrk8s.enabled=false \
  --set speaker.ignoreExcludeLB=true --wait
```

`speaker.ignoreExcludeLB` permite anunciar desde el único nodo de control de este cluster local. Antes de aplicar el pool, confirme que la red Docker de Minikube es `192.168.49.0/24` y que el rango está libre. La configuración usada fue:

```yaml
apiVersion: metallb.io/v1beta1
kind: IPAddressPool
metadata:
  name: ic7602-local
  namespace: metallb-system
spec:
  addresses:
    - 192.168.49.240-192.168.49.250
---
apiVersion: metallb.io/v1beta1
kind: L2Advertisement
metadata:
  name: ic7602-local
  namespace: metallb-system
spec:
  ipAddressPools:
    - ic7602-local
```

Guárdela en un archivo YAML y aplique `kubectl apply -f <archivo>`. Para consultar ClusterIP directamente desde WSL se añadió una ruta privada a `10.96.0.0/12` mediante el nodo `192.168.49.2`; la ruta debe restaurarse después de reiniciar WSL.

## Reanudar desde PowerShell

Mantenga una terminal interactiva Ubuntu abierta durante la demostración. Ejecute:

```powershell
wsl -d Ubuntu-24.04 -u root -- systemctl start docker
wsl -d Ubuntu-24.04 -- minikube start --driver=docker --cpus=4 --memory=4096
wsl -d Ubuntu-24.04 -u root -- ip route replace 10.96.0.0/12 via 192.168.49.2
wsl -d Ubuntu-24.04 -- kubectl get pods,services
wsl -d Ubuntu-24.04 -- helm list --all-namespaces
```

Para reconstruir las aplicaciones desde la copia Linux:

```bash
cd /home/antho/ic7602-p2-deployment
bash deploy/install.sh
```

Se usó una copia Linux para que los scripts tengan finales de línea LF. Si se copia una versión nueva desde Windows, normalice los scripts `.sh` antes de ejecutarlos.

## Vercel y Firestore

Se actualizó y volvió a desplegar el API de producción con:

```dotenv
ZONE_CACHES=cr=192.168.49.240,us=192.168.49.241
COUNTRY_ZONES=CR=cr,US=us,*=cr
FIREBASE_DATABASE_URL=https://p2-redes-b7bab-default-rtdb.firebaseio.com
```

El API usa DB-IP Lite 2026-11: 362,998 rangos IPv4 en `/ipToCountry` de RTDB, con esquema e índice del P1. Las IP privadas aparecen como desconocidas y usan `*=cr`; ya no se simula su país mediante variables CIDR.

Despliegues actuales Ready: API `dpl_71LQT9jBydw7FwhGweZcrBrEA1VP`, UI `dpl_Fk3Bc1yZjJHPFaqv4md1Q18pF1nm`. Las cachés usan `zonal-cache:handoff-20261109-https`; Apache usa `apache-web:geo-20261109`. Se mantuvieron las dos correcciones autorizadas de `prueba-natalia.test`, de `http://rest-api:8080` a `http://rest-api-java.default.svc.cluster.local:8080`. No se modificó la propiedad ni la verificación de dominios existentes.

## Pruebas realizadas

Pasaron 18 comprobaciones:

1. Apache respondió directamente dentro de Kubernetes.
2. Java respondió en `/api/health`.
3. Las zonas recibieron direcciones distintas.
4. La caché CR cargó configuración real mediante Vercel/Firestore.
5. La caché US cargó configuración real mediante Vercel/Firestore.
6. Primera lectura HTML: MISS.
7. Segunda lectura HTML: HIT.
8. Expiración del TTL: nuevo MISS.
9. La zona US también alcanzó Apache.
10. HTTPS terminó en la caché con certificado de desarrollo autofirmado.
11. Una petición sin API key fue rechazada con 401.
12. Una API key inválida fue rechazada con 401.
13. POST Java a través de la caché creó un elemento.
14. GET Java devolvió el elemento creado.
15. PUT Java actualizó el elemento.
16. GET JSON autenticado produjo MISS y luego HIT.
17. DELETE Java eliminó el elemento temporal.
18. El DNS Interceptor devolvió la IP CR para `geo.test`.

Las pruebas usaron temporalmente dos reglas y una API key en el fixture existente `geo.test`, con permiso explícito. Después se eliminaron los tres documentos y la credencial local; se reiniciaron ambas cachés para cargar la configuración limpia. El elemento Java temporal también fue eliminado. No se creó un dominio público ni se omitió una verificación TXT para uno nuevo.

Comprobaciones de lectura que pueden repetirse desde Ubuntu sin crear datos:

```bash
kubectl get pods,svc,pvc
curl -fsS http://192.168.49.240/__zc/healthz
curl -fsS http://192.168.49.241/__zc/healthz
curl -fsS https://proyecto-redes-2-api.vercel.app/api/health/db
dig @192.168.49.242 geo.test +short
```

Para repetir MISS/HIT y CRUD se necesitan reglas y credenciales válidas de un dominio autorizado. No reutilice credenciales temporales eliminadas. La ampliación de esta sesión verificó login externo en el navegador, tickets alterados/repetidos/expirados, cookie segura, MISS/HIT y logout mediante Vercel–Firestore–Kubernetes; véase [GEO-LOGIN.md](GEO-LOGIN.md). También se contrastaron 14 límites de países con el CSV DB-IP y cuatro direcciones desconocidas/inválidas, y el API resolvió US→US, CR→CR e IP privada→zona por defecto. Las pruebas de reemplazo bajo presión, sitios externos HTTP/HTTPS y TXT público no se repitieron.

En la comprobación final apareció una regla adicional de `google.com` con origen `http://apache80`, ajena a las reglas temporales de esta prueba. No se modificó. Ese nombre de Service no existe en este cluster; el origen Apache configurado es `http://apache-web.default.svc.cluster.local`. `google.com` no figuraba entre los dominios verificados, por lo que la caché no cargaba esa regla.

Referencias de red: [MetalLB con Helm](https://metallb.io/installation/#installation-with-helm) y [anuncios desde un cluster de un nodo](https://metallb.io/troubleshooting/#metallb-is-not-advertising-my-service-from-my-control-plane-nodes-or-from-my-single-node-cluster).
