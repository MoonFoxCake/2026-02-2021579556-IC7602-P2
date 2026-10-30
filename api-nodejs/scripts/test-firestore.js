'use strict';

/**
 * Prueba de conexion con Firestore: escribe, lee y borra un documento.
 * Uso: npm run test:firestore
 */

require('dotenv').config();

const { db } = require('../src/firebase');

async function main() {
  const ref = db.collection('_healthcheck').doc('ping');

  await ref.set({ ok: true, at: new Date().toISOString() });
  console.log('Escritura OK');

  const snap = await ref.get();
  console.log('Lectura OK ->', snap.data());

  await ref.delete();
  console.log('Borrado OK');

  console.log('\nFirestore esta funcionando correctamente.');
}

main().catch((err) => {
  console.error('\nFallo la prueba con Firestore:');
  console.error(err.message);
  process.exit(1);
});
