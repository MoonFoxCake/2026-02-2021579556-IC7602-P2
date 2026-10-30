# P2 Redes - REST API (Node.js + Firestore)

API en Node.js para el Proyecto 2 de Redes (IC7602). Se despliega en Vercel y usa Firestore como base de datos.

> Estado: esqueleto inicial (conexion con Firestore). Los endpoints se documentaran aqui conforme se implementen.

## Requisitos

- Node.js 18 o superior
- Un proyecto de Firebase con Firestore creado y una clave de cuenta de servicio (JSON)

## Puesta en marcha local

1. Instalar dependencias:

   ```bash
   npm install
   ```

2. Generar el archivo `.env` desde el JSON de la cuenta de servicio:

   ```bash
   npm run env:from-json -- "ruta/al/archivo.json"
   ```

   (Alternativa manual: copiar `.env.example` a `.env` y llenar las tres variables.)

3. Probar la conexion con Firestore:

   ```bash
   npm run test:firestore
   ```

   Debe imprimir `Escritura OK`, `Lectura OK` y `Borrado OK`.

## Variables de entorno

| Variable | Descripcion |
|---|---|
| `FIREBASE_PROJECT_ID` | ID del proyecto de Firebase |
| `FIREBASE_CLIENT_EMAIL` | Correo de la cuenta de servicio |
| `FIREBASE_PRIVATE_KEY` | Clave privada (con saltos de linea escapados como `\n`) |

No hay valores quemados en el codigo. En Vercel se configuran en *Project Settings > Environment Variables*.

## Seguridad

- `.env` y el JSON de la cuenta de servicio estan en `.gitignore`: **nunca** se suben al repositorio.
- Las reglas de Firestore estan en modo produccion (`allow read, write: if false;`); solo este API accede a los datos mediante el Admin SDK.
