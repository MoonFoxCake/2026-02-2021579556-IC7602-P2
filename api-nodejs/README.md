# REST API Node.js

API Express con Firebase Admin/Firestore para la UI, el DNS Interceptor y las cachés zonales. El destino de producción definido por el proyecto es Vercel con deployments desde GitHub; el Dockerfile sirve para desarrollo e integración local con Compose.

## Local y contenedor

Requiere Node.js 20 o superior.

```bash
npm ci
npm start
npm test
```

Desde la raíz, `docker compose up --build -d --wait` ejecuta la UI, el API y Firestore local junto con los demás componentes. No necesita credenciales ni `.env`. El API usa `FIRESTORE_EMULATOR_HOST=firestore-emulator:8080` y `FIREBASE_PROJECT_ID=demo-ic7602-p2`; inicializa Firebase Admin solo con el ID de proyecto. Este modo exige el prefijo `demo-` y un host sin `http://`. La guía está en [docs/LOCAL.md](../docs/LOCAL.md).

Sin `FIRESTORE_EMULATOR_HOST`, se conserva la inicialización con cuenta de servicio para Vercel/Firebase hospedado. Configure `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET` y `SERVICE_KEY` en ese entorno. No defina la variable del emulador en Vercel. Para `npm start`, estas variables pueden ir en `api-nodejs/.env`, ignorado por Git.

La imagen corre sin root, publica el puerto 3000 y excluye env files y claves de cuenta de servicio del contexto. Compruebe `/api/health` (proceso) y `/api/health/db` (conectividad Firestore).

Variables principales: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET`, `SERVICE_KEY`, `ZONE_CACHES`, `COUNTRY_ZONES`, `IP_COUNTRY_RANGES` y `CORS_ORIGINS`. Nunca agregue valores secretos a Dockerfile, Compose, Helm values o Git.

La guía de servicios y despliegue Minikube está en [docs/KUBERNETES.md](../docs/KUBERNETES.md). El contrato del API y los modelos Firestore están en [API.md](API.md).
