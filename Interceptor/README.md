# DNS Interceptor

Servicio GNU C que escucha consultas DNS por UDP y consulta el API indicado por `DNS_API_URL`. Puede usar el DNS API del P1 (registros y resolución remota) o el API Node.js del P2 (caché zonal). El URL base es obligatorio; no hay un destino predeterminado en el ejecutable.

```bash
docker build -f Interceptor/dockerfile -t dns-interceptor:dev Interceptor
docker run --rm -p 127.0.0.1:1053:5353/udp -e DNS_API_URL=https://<api>.vercel.app dns-interceptor:dev --port 5353
```

En Kubernetes, el contenedor escucha UDP 5353 sin privilegios y el Service expone UDP 53. El chart está en `helm/dns-interceptor`. Para el despliegue completo siga [docs/KUBERNETES.md](../docs/KUBERNETES.md).

Para ejecutar todo el proyecto con Firestore emulado y UI local, use `docker compose up --build -d --wait` desde la raíz. El puerto DNS del host es 1053 para evitar conflictos con mDNS de Windows; consulte [docs/LOCAL.md](../docs/LOCAL.md).

Compose inicia el DNS API incluido en `dns-api/` y configura `DNS_API_URL=http://dns-api:8080`. El interceptor espera a que ese servicio esté saludable y lo consulta por la red interna de Docker. Puede cambiar el destino con la variable `DNS_API_URL` al ejecutar Compose. La credencial de Firebase se monta únicamente en el DNS API; consulte [docs/LOCAL.md](../docs/LOCAL.md).
