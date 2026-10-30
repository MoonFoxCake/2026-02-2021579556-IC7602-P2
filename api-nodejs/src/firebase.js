'use strict';

/**
 * Inicializacion unica de Firebase Admin / Firestore.
 * Toda la configuracion viene de variables de entorno (sin valores quemados).
 * Los demas modulos del API deben importar `db` desde aqui.
 */

const admin = require('firebase-admin');

const REQUIRED_VARS = [
  'FIREBASE_PROJECT_ID',
  'FIREBASE_CLIENT_EMAIL',
  'FIREBASE_PRIVATE_KEY',
];

function readCredentials() {
  const missing = REQUIRED_VARS.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    throw new Error(
      `Faltan variables de entorno: ${missing.join(', ')}. ` +
        'Revisa tu archivo .env (ver .env.example).'
    );
  }

  return {
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    // En variables de entorno los saltos de linea llegan escapados como "\n".
    // Se quitan comillas externas por si la variable se pego con ellas (ej. en Vercel).
    privateKey: process.env.FIREBASE_PRIVATE_KEY.replace(/^"|"$/g, '').replace(/\\n/g, '\n'),
  };
}

// En entornos serverless (Vercel) el modulo puede cargarse varias veces:
// evitamos inicializar la app mas de una vez.
if (admin.apps.length === 0) {
  admin.initializeApp({
    credential: admin.credential.cert(readCredentials()),
  });
}

const db = admin.firestore();

module.exports = { admin, db };
