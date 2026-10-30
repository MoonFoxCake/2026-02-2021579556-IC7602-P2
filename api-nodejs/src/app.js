'use strict';

/**
 * Aplicacion Express del API.
 * Se exporta sin llamar a listen(): la usan tanto el servidor local (src/server.js)
 * como la funcion serverless de Vercel (api/index.js).
 */

const express = require('express');

const app = express();
app.disable('x-powered-by');
app.use(express.json());

const DB_CHECK_TIMEOUT_MS = 5000;

function withTimeout(promise, ms) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timeout de ${ms} ms al consultar Firestore`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

app.get('/', (req, res) => {
  res.json({ service: 'p2-redes-api', health: '/api/health' });
});

// Verifica que el API esta arriba (no toca la base de datos).
app.get('/api/health', (req, res) => {
  res.json({ ok: true, service: 'p2-redes-api', time: new Date().toISOString() });
});

// Verifica que las variables de entorno y la conexion con Firestore funcionan.
app.get('/api/health/db', async (req, res) => {
  try {
    // require diferido: asi /api/health responde aunque falten las variables de Firebase.
    const { db } = require('./firebase');
    await withTimeout(db.collection('_healthcheck').doc('ping').get(), DB_CHECK_TIMEOUT_MS);
    res.json({ ok: true, firestore: 'reachable' });
  } catch (err) {
    res.status(503).json({ ok: false, firestore: 'unreachable', error: err.message });
  }
});

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;
