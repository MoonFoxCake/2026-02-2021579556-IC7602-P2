# REST API Java

API de demostración para probar el proxy/cache zonal. Los datos son JSON en memoria; se borran al reiniciar el proceso o el Pod.

| Método | Ruta | Comportamiento |
|---|---|---|
| GET | `/api/items.json` | Lista elementos |
| GET | `/api/items/{id}.json` | Obtiene un elemento o `404` |
| POST | `/api/items.json` | Crea desde un objeto JSON y responde `201` con `Location` |
| PUT | `/api/items/{id}.json` | Reemplaza el objeto o responde `404` |
| DELETE | `/api/items/{id}.json` | Elimina y responde `204`, o `404` |
| GET | `/api/health` | Estado del servicio |

Ejemplo:

```bash
curl -i -H 'Content-Type: application/json' -d '{"name":"bike","price":10}' http://localhost:8080/api/items.json
curl -i http://localhost:8080/api/items.json
```

Pruebas: `mvn test`. Imagen: `docker build -t rest-api-java:dev .`. El chart es `helm/rest-api-java`; la guía de Minikube está en [docs/KUBERNETES.md](../docs/KUBERNETES.md).
