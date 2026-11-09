# IC7602 Proyecto 2

El despliegue objetivo divide los servicios así: la UI React y el API Node.js se publican en Vercel desde GitHub; el DNS Interceptor, las cachés zonales, el REST API Java y Apache se ejecutan en Kubernetes con Helm.

## Kubernetes con Minikube

Requisitos: Docker Desktop, Minikube, `kubectl`, Helm 3 y Bash (WSL funciona en Windows). Configure primero el API Node.js en Vercel y Firestore. No guarde credenciales en Git.

1. Copie `ZonalCache/.env.example` a `ZonalCache/.env` y configure la URL del API Vercel, `ZC_CONFIG_TOKEN` (igual a `SERVICE_KEY` en Vercel) y el modo de login.
2. Inicie Minikube: `minikube start`.
3. En una terminal con los permisos que requiera su sistema, mantenga activo `minikube tunnel`.
4. Desde Bash en la raíz del repositorio ejecute: `bash deploy/install.sh`.
5. Copie el valor `ZONE_CACHES` que imprime el script a las variables de entorno del proyecto API en Vercel. Configure también `COUNTRY_ZONES` e `IP_COUNTRY_RANGES` y deje que el despliegue de GitHub/Vercel publique la configuración.
6. Registre y verifique un dominio de prueba en la UI. Configure sus orígenes con los nombres internos `http://rest-api-java.default.svc.cluster.local:8080` y `http://apache-web.default.svc.cluster.local`.

El instalador espera que la configuración API esté disponible para las cachés. Los servicios Java y Apache son ClusterIP; el interceptor y cada caché usan LoadBalancer. `minikube tunnel` debe seguir activo para asignar IP externas.

Guía de instalación, comprobaciones y solución de problemas: [docs/KUBERNETES.md](docs/KUBERNETES.md).

## Compose local

1. Copie `.env.example` a `.env`; use credenciales Firebase y secretos rotados.
2. Configure los orígenes de URLs en Firestore para usar los alias locales que también funcionan en Kubernetes: `http://rest-api-java.default.svc.cluster.local:8080` y `http://apache-web.default.svc.cluster.local`.
3. Inicie los contenedores: `docker compose up --build`.

La UI permanece en Vercel (o puede ejecutarse para desarrollo con `cd frontend`, `pnpm install --frozen-lockfile`, `pnpm dev`). Compose publica el API en `localhost:3000`, el DNS Interceptor en UDP `5353`, la caché en HTTP `80`, el Java API en `localhost:18080` y Apache en `localhost:18081`.

Las pruebas locales y manuales de la caché están en [ZonalCache/docs/COMO-CORRER.md](ZonalCache/docs/COMO-CORRER.md). Las variables y el Dockerfile del API están documentados en [api-nodejs/README.md](api-nodejs/README.md).
