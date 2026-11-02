'use strict';

/**
 * Genera el archivo .env a partir del JSON de la cuenta de servicio de Firebase,
 * para no copiar la clave privada a mano (tiene saltos de linea que se danan facil).
 *
 * Uso:
 *   npm run env:from-json -- "C:\ruta\al\archivo.json"
 *   npm run env:from-json -- ruta/al/archivo.json --force   (sobrescribe .env existente)
 *
 * El script NO imprime la clave privada en pantalla.
 */

const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const force = args.includes('--force');
const jsonPath = args.find((a) => !a.startsWith('--'));

if (!jsonPath) {
  console.error('Uso: npm run env:from-json -- <ruta-al-json> [--force]');
  process.exit(1);
}

let credentials;
try {
  credentials = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
} catch (err) {
  console.error(`No se pudo leer el JSON (${jsonPath}): ${err.message}`);
  process.exit(1);
}

const { project_id: projectId, client_email: clientEmail, private_key: privateKey } = credentials;
if (!projectId || !clientEmail || !privateKey) {
  console.error(
    'El JSON no parece una cuenta de servicio de Firebase (faltan project_id, client_email o private_key).'
  );
  process.exit(1);
}

const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath) && !force) {
  console.error('Ya existe un .env. Usa --force si quieres sobrescribirlo.');
  process.exit(1);
}

// Escapamos los saltos de linea reales como "\n" para que quepan en una sola linea.
const escapedKey = privateKey.replace(/\r?\n/g, '\\n');

const content =
  [
    `FIREBASE_PROJECT_ID=${projectId}`,
    `FIREBASE_CLIENT_EMAIL=${clientEmail}`,
    `FIREBASE_PRIVATE_KEY="${escapedKey}"`,
  ].join('\n') + '\n';

fs.writeFileSync(envPath, content, { mode: 0o600 });

console.log('Listo: se creo el archivo .env');
console.log(`  FIREBASE_PROJECT_ID  = ${projectId}`);
console.log(`  FIREBASE_CLIENT_EMAIL = ${clientEmail}`);
console.log('  FIREBASE_PRIVATE_KEY  = (oculta)');
console.log('Recuerda: el .env y el JSON original NO se suben a GitHub.');
