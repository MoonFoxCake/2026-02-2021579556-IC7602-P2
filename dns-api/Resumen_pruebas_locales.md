# Resumen de pruebas locales del DNS API

## Objetivo
Validar que la API funciona sin Docker usando Firebase emulador local y el servidor DNS remoto real.

## Variables de entorno necesarias

Se usaron estas variables en la sesión local que sí funcionó:

```env
DNS_API_PORT=8080
REMOTE_DNS_SERVER=8.8.8.8
REMOTE_DNS_PORT=53
UDP_TIMEOUT_MS=2000
DB_PROVIDER=firebase
DB_URL=http://127.0.0.1:9000
DB_API_KEY=fake-api-key
FIREBASE_AUTH_URL=http://127.0.0.1:9099
FIREBASE_DATABASE_NAMESPACE=p1-redes-a87a7-default-rtdb
FIREBASE_EMAIL=dns-api@test.com
FIREBASE_PASSWORD=secreto123
```

## Qué se necesitó para que arrancara

1. Instalar Java 21.
2. Instalar Maven y dejarlo disponible en PATH.
3. Mover el proyecto a una ruta sin restricciones de Windows (por ejemplo `C:\dev\IC7602\...`) para evitar problemas con OneDrive y `target`.
4. Levantar Firebase emuladores:
   - Auth: `127.0.0.1:9099`
   - Realtime Database: `127.0.0.1:9000`
5. Crear el usuario de Firebase Auth:
   - `dns-api@test.com`
   - `secreto123`
6. Cargar las variables de entorno en la misma terminal donde se ejecuta la API.

## Pruebas ejecutadas

### 1) Pruebas unitarias de Java
Comando:

```powershell
mvn test
```

Resultado verificado:

- `Tests run: 5`
- `Failures: 0`
- `Errors: 0`
- `Skipped: 0`

### 2) Prueba de integración del proyecto
Comando:

```bash
bash ./tests/pruebas_integracion.sh
```

Esto valida:

- Health del servicio (`/health`)
- `exists` con dominio existente, inexistente y deshabilitado
- `records` por hostname
- `dns_resolver` con respuesta DNS válida
- JSON inválido y campos faltantes
- concurrencia de 50 solicitudes simultáneas

Resultado verificado:

- `== Resultado: 15 correctas, 0 fallidas ==`

## Repetición exacta

### Terminal 1: Firebase

```powershell
cd "C:\dev\IC7602\2026-02-2023055841-IC7602-P1\firebase"
firebase emulators:start
```

### Terminal 2: API

```powershell
cd "C:\dev\IC7602\2026-02-2023055841-IC7602-P1\DNS API"
Get-Content .env | Where-Object { $_ -and $_ -notmatch '^#' } | ForEach-Object {
    $k, $v = $_ -split '=', 2
    Set-Item "env:$k" $v
}
mvn clean package -DskipTests
java -jar .\target\dns-api.jar
```

### Terminal 3: validación

```bash
cd /c/dev/IC7602/2026-02-2023055841-IC7602-P1/DNS\ API
bash ./tests/pruebas_integracion.sh
```

## Observación importante
La configuración que funciona con el emulador no usa `host.docker.internal`; usa `127.0.0.1` porque la API y los emuladores corren en la misma máquina local.

## Conclusión
La API quedó validada de extremo a extremo sin Docker, siempre que:

- el emulador de Firebase esté levantado,
- el usuario `dns-api@test.com` exista en Auth,
- las variables del `.env` se carguen antes de ejecutar la API,
- y los puertos sean `9000`, `9099` y `8080`.
