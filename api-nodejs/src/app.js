'use strict';

/**
 * Aplicacion Express del API.
 * Se exporta sin llamar a listen(): la usan tanto el servidor local (src/server.js)
 * como la funcion serverless de Vercel (api/index.js).
 */

const dgram = require('dgram');
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

//TODO: esto es mockup para asegurarse que la conexion sirva

const MOCK_DB = {
  'geo.test': {
    type: 'geo',
    ttl: 60,
    targets: [
      { id: '1', address: '10.1.1.1', healthy: true, country: 'CR' },
      { id: '2', address: '10.2.2.2', healthy: true, country: 'US' }
    ]
  },
  'multi.test': {
    type: 'multi',
    ttl: 60,
    targets: [
      { id: '1', address: '192.168.1.100', healthy: true },
      { id: '2', address: '192.168.1.101', healthy: true }
    ]
  }
};

// GET /api/records/:hostname
app.get('/api/records/:hostname', async (req, res) => {
  const { hostname } = req.params;
  const { sourceIp } = req.query;

  const record = MOCK_DB[hostname];

  if (record) {
    res.json({
      found: true,
      hostname,
      recordId: `mock-${hostname}`,
      type: record.type,
      ttl: record.ttl,
      // Simulamos que el API hizo IP-to-Country y dice que el cliente es de CR
      client: {
        ip: sourceIp || '127.0.0.1',
        found: true,
        countryCode: 'CR'
      },
      targets: record.targets
    });
  } else {
    res.status(404).json({ found: false, hostname });
  }
});

// POST /api/dns_resolver
app.post('/api/dns_resolver', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Falta el campo data' });

  // El C nos mandó el paquete DNS en Base64, lo pasamos a Buffer binario
  const queryBuffer = Buffer.from(data, 'base64');

  // Usamos UDP nativo para reenviar la query a Google DNS (8.8.8.8)
  const client = dgram.createSocket('udp4');

  client.send(queryBuffer, 53, '8.8.8.8', (err) => {
    if (err) {
      client.close();
      return res.status(500).json({ error: err.message });
    }
  });

  // Esperamos la respuesta de Google DNS
  client.on('message', (msg) => {
    // Devolvemos la respuesta binaria en Base64 al interceptor C
    res.json({ data: msg.toString('base64') });
    client.close();
  });

  client.on('error', (err) => {
    res.status(500).json({ error: err.message });
    client.close();
  });
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
