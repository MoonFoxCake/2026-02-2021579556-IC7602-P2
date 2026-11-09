# DNS API

Importado del P1 con sus endpoints, pruebas y autenticación de cuenta de servicio.
Se inicia desde la raíz del P2:

```bash
docker compose up --build -d --wait
curl http://127.0.0.1:18083/api/records/multi.test
```

El interceptor usa `http://dns-api:8080`; el host accede por `127.0.0.1:18083`.
Compose monta `secrets/firebase-service-account.json` de solo lectura. La clave no
se versiona ni se incluye en la imagen. `DNS_DATABASE_URL` y
`DNS_FIREBASE_CREDENTIALS` permiten configurar la base y la ruta de la clave.
Vea [la guía local](../docs/LOCAL.md).

Pruebas sin credenciales ni conexión a Firebase:

```bash
cd dns-api
mvn test
```

Para ejecutar Java directamente, copie `.env.example` a `.env` y ajuste la ruta
al JSON, luego ejecute `mvn package` y `java -jar target/dns-api.jar`.
El contrato del interceptor está en [CONTRATO_INTERCEPTOR.md](CONTRATO_INTERCEPTOR.md).
