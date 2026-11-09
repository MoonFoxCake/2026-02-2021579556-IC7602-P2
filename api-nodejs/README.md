# REST API Node.js

API Express con Firebase Admin/Firestore para la UI, el DNS Interceptor y las cachés zonales. El destino de producción definido por el proyecto es Vercel con deployments desde GitHub; el Dockerfile sirve para desarrollo e integración local con Compose.

## Local y contenedor

Requiere Node.js 20 o superior.

```bash
npm ci
npm start
npm test
```

Para contenedor, cree `.env` desde `.env.example` en la raíz del repositorio, configure Firebase y secretos recién rotados, y ejecute `docker compose up --build api-nodejs`. La imagen corre sin root, publica el puerto 3000 y excluye env files y claves de cuenta de servicio del contexto. Compruebe `/api/health` (proceso) y `/api/health/db` (conectividad Firestore).

Variables principales: `FIREBASE_PROJECT_ID`, `FIREBASE_CLIENT_EMAIL`, `FIREBASE_PRIVATE_KEY`, `JWT_SECRET`, `SERVICE_KEY`, `ZONE_CACHES`, `COUNTRY_ZONES`, `IP_COUNTRY_RANGES` y `CORS_ORIGINS`. Nunca agregue valores secretos a Dockerfile, Compose, Helm values o Git.

La guía de servicios y despliegue Minikube está en [docs/KUBERNETES.md](../docs/KUBERNETES.md). El contrato del API y los modelos Firestore están en [API.md](API.md).
