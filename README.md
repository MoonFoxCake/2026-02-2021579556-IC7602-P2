# IC7602 Proyecto 2

El despliegue objetivo divide los servicios así: la UI React y el API Node.js se publican en Vercel desde GitHub; el DNS Interceptor, las cachés zonales, el REST API Java y Apache se ejecutan en Kubernetes con Helm.

## Kubernetes con Minikube

En Windows/WSL use la [configuración validada con MetalLB](docs/WSL-DEPLOYMENT.md) para obtener IP distintas por zona. No ejecute `minikube tunnel` junto con MetalLB.

Requisitos: Docker (Desktop o Engine dentro de WSL), Minikube, `kubectl`, Helm 3 y Bash. Configure primero el API Node.js en Vercel y Firestore. No guarde credenciales en Git.

1. Copie `ZonalCache/.env.example` a `ZonalCache/.env` y configure la URL del API Vercel, `ZC_CONFIG_TOKEN` (igual a `SERVICE_KEY` en Vercel) y el modo de login.
2. Inicie Minikube: `minikube start`.
3. En WSL configure MetalLB según la guía anterior. Si usa otro proveedor basado en túnel, mantenga `minikube tunnel` activo en otra terminal.
4. Desde Bash en la raíz del repositorio ejecute: `bash deploy/install.sh`.
5. Copie el valor `ZONE_CACHES` que imprime el script al API Vercel. Configure `COUNTRY_ZONES`, `FIREBASE_DATABASE_URL` y la [tabla DB-IP y el login externo](docs/GEO-LOGIN.md). Vuelva a desplegar el API después de cambiar sus variables.
6. Registre y verifique un dominio de prueba en la UI. Configure sus orígenes con los nombres internos `http://rest-api-java.default.svc.cluster.local:8080` y `http://apache-web.default.svc.cluster.local`.

El instalador espera que la configuración API esté disponible para las cachés. Java y Apache son ClusterIP; el interceptor y cada caché usan LoadBalancer. Mantenga disponible el proveedor elegido: MetalLB o túnel.

Guía de instalación, comprobaciones y solución de problemas: [docs/KUBERNETES.md](docs/KUBERNETES.md).

IP-to-Country reutiliza el esquema y la consulta indexada del P1 en Realtime Database. El login externo está en `/cache-login` y autentica usuarios de las reglas de URL almacenados en Firestore. Configuración, importación y pruebas: [docs/GEO-LOGIN.md](docs/GEO-LOGIN.md).

La UI de producción puede consultar las cachés CR/US de WSL mediante Cloudflare Tunnel y un gateway autenticado. Dominios, variables, pruebas del panel y pasos para repetir la demostración: [docs/PUBLIC-CACHE.md](docs/PUBLIC-CACHE.md).

Pruebas completas, preservación de IP de origen en DNS y sitio externo HTTP real: [docs/TECHNICAL-VALIDATION.md](docs/TECHNICAL-VALIDATION.md).

## Compose local

Con Docker Desktop en modo Linux, desde la raíz del repo:

```bash
docker compose up --build -d --wait
```

Abra http://localhost:5173 e ingrese con `demo@p2.test` / `local-demo-password`. Compose incluye la UI, el API Node.js, el emulador Firestore, el Interceptor, la caché zonal, Java y Apache. No necesita `.env`, credenciales Firebase, Vercel, Helm ni instalaciones locales de Node/Java. La primera construcción descarga imágenes y dependencias; la aplicación usa servicios locales al ejecutarse.

El dominio `p2.test` se crea verificado **solo en el emulador**, con reglas para Apache (`/*`) y Java (`/api/*`). Las cuentas usan el mecanismo JWT/bcrypt del API sobre Firestore; este proyecto no usa Firebase Authentication. Guía con puertos, pruebas, persistencia y diagnóstico: [docs/LOCAL.md](docs/LOCAL.md).

```bash
docker compose run --rm local-smoke
docker compose down
```

Las pruebas locales y manuales de la caché están en [ZonalCache/docs/COMO-CORRER.md](ZonalCache/docs/COMO-CORRER.md). Las variables y el Dockerfile del API están documentados en [api-nodejs/README.md](api-nodejs/README.md).
