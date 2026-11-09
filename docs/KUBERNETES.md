# Despliegue de IC7602 P2

## Arquitectura y requisitos

- Vercel, con despliegue automático desde GitHub: UI React y API Node.js.
- Minikube/Kubernetes: DNS Interceptor (UDP 53), Zonal Cache por zona (HTTP 80/HTTPS 443), Java REST API (8080) y Apache (80).
- Herramientas: Docker, Minikube, `kubectl`, Helm 3 y Bash. En Windows se puede ejecutar Bash desde WSL.
- No usar la llave Firebase, `SERVICE_KEY`, JWT u otros secretos que se hayan expuesto; revocarlos y configurar valores nuevos.

## Preparar configuración

1. Desplegar el API Node.js y la UI en Vercel. El API necesita sus variables Firebase, `JWT_SECRET`, `SERVICE_KEY`, `ZONE_CACHES`, `COUNTRY_ZONES` e `IP_COUNTRY_RANGES`. `SERVICE_KEY` debe ser igual a `ZC_CONFIG_TOKEN`.
2. Copiar `ZonalCache/.env.example` como `ZonalCache/.env`. Llenar `ZC_CONFIG_URL` con la URL base del API Vercel y `ZC_CONFIG_TOKEN` con el valor del servicio. Mantener `ZC_LOGIN_MODE=local`: el formulario/ticket de login servido por la UI todavía está pendiente; `ui` no es un flujo integrado listo para producción.
3. `DNS_API_URL` puede quedar vacío para usar la misma URL que `ZC_CONFIG_URL`.
4. Verificar que la URL de la UI está permitida en `CORS_ORIGINS` del API Vercel.

Los archivos `.env` están ignorados por Git. No se pasan secretos como argumentos de construcción Docker; la configuración del cluster se entrega en tiempo de ejecución mediante ConfigMaps y Kubernetes Secrets. El Dockerfile existente del Interceptor se llama `Interceptor/dockerfile` (minúsculas), por lo que Compose y el instalador lo seleccionan explícitamente.

## Instalar en Minikube

1. `minikube start`.
2. Iniciar `minikube tunnel` en otra terminal y mantenerla abierta. En Windows, abrir la terminal con los permisos que Minikube requiera para rutas LoadBalancer.
3. Desde la raíz del repo: `bash deploy/install.sh`.

El script compila/carga las imágenes en Minikube y aplica Helm para Java, Apache, Zonal Cache (cada zona configurada en `ZonalCache/.env`) y DNS Interceptor. Espera los Deployments y muestra las IP/estado de los Services.

Después de asignarse las IP de `zc-cr` y `zc-us`, actualice manualmente `ZONE_CACHES` en el proyecto API de Vercel con el mapeo que imprimió el instalador, por ejemplo `cr=<IP-zc-cr>,us=<IP-zc-us>`. Configure `COUNTRY_ZONES` para mapear los países a esas zonas. Si `IP_COUNTRY_RANGES` no cubre el origen del cliente de prueba, agregue el rango correspondiente. Vercel publicará los cambios desde su flujo de deployment actual.

El DNS devuelve una dirección IP, no un puerto; por eso cada caché necesita su propio endpoint en 80/443. Los Charts usan LoadBalancer para ese requisito. El API de Firestore debe tener al menos un dominio verificado con TXT y sus URLs de prueba configuradas antes del smoke test final.

## Verificación

```bash
kubectl get pods,svc
kubectl rollout status deploy/rest-api-java
kubectl rollout status deploy/apache-web
kubectl rollout status deploy/dns-interceptor
kubectl logs deploy/zc-cr
```

Verificar orígenes directamente dentro del cluster:

```bash
kubectl run curl-check --rm -i --restart=Never --image=curlimages/curl -- \
  -fsS http://rest-api-java.default.svc.cluster.local:8080/api/health
kubectl run apache-check --rm -i --restart=Never --image=curlimages/curl -- \
  -fsS http://apache-web.default.svc.cluster.local/
```

Verificar desde el cliente usando la IP externa del interceptor y el dominio TXT verificado:

```bash
nslookup <dominio-de-prueba> <IP-externa-dns-interceptor>
curl -i http://<dominio-de-prueba>/index.html
curl -i http://<dominio-de-prueba>/index.html
curl -i -H 'Content-Type: application/json' -d '{"name":"demo"}' \
  http://<dominio-de-prueba>/api/items.json
curl -i http://<dominio-de-prueba>/api/items.json
curl -ik https://<dominio-de-prueba>/index.html
```

La primera lectura cacheable debe indicar `MISS` y la siguiente `HIT`. Para el API Java, el registro de URL `/api/*` debe apuntar a `http://rest-api-java.default.svc.cluster.local:8080`; para Apache, la regla web debe apuntar a `http://apache-web.default.svc.cluster.local`.

## Compose local

Compose ejecuta todos los servicios localmente, incluida la UI y Firestore emulado. No requiere Vercel, Firebase hospedado ni credenciales. Desde la raíz:

```bash
docker compose up --build -d --wait
docker compose run --rm local-smoke
```

La UI está en http://localhost:5173. Los datos iniciales y las pruebas DNS/cache están documentados en [LOCAL.md](LOCAL.md). El despliegue Kubernetes/Vercel de las secciones anteriores mantiene sus variables y credenciales propias.

## Pruebas

```bash
cd api-nodejs && npm test
cd ../ZonalCache && make check
cd ../rest-api-java && mvn test
cd ..
helm lint helm/dns-interceptor
helm lint helm/rest-api-java
helm lint helm/apache-web
helm lint ZonalCache/helm/zonal-cache
```

Las pruebas automatizadas del API y de caché usan datos simulados/locales. La prueba con Firestore real, el flujo UI/ticket, el DNS con un dominio público y el despliegue Minikube deben reportarse por separado; no se consideran validados por un build de imagen o un template Helm.
