'use strict';

/**
 * Aplicacion Express del API.
 * Se exporta sin llamar a listen(): la usan tanto el servidor local (src/server.js)
 * como la funcion serverless de Vercel (api/index.js).
 */

const dgram = require('dgram');
const express = require('express');
const { cors } = require('./cors');  // CORS es para que la UI pueda llamar al API desde el navegador

const app = express();
app.disable('x-powered-by');
app.use(cors()); 
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

// Store compartido (Firestore) para los routers de servicio: caché zonal y DNS Interceptor.
const { createCacheRouter, firestoreStore } = require('./cache-routes');
const { createDnsRouter } = require('./dns-routes');
const store = firestoreStore();

// GET /api/records/:hostname?sourceIp=  -> IP de la caché zonal del cliente (lo usa dns.c, modo "geo").
app.use('/api', createDnsRouter({ store }));

// POST /api/dns_resolver
app.post('/api/dns_resolver', (req, res) => {
  const { data } = req.body;
  if (!data) return res.status(400).json({ error: 'Falta el campo data' });

  // El C nos mandó el paquete DNS en Base64, lo pasamos a Buffer binario
  const queryBuffer = Buffer.from(data, 'base64');

  // Usamos UDP nativo para reenviar la query al resolver real (UPSTREAM_DNS, por defecto 8.8.8.8)
  const client = dgram.createSocket('udp4');

  client.send(queryBuffer, Number(process.env.UPSTREAM_DNS_PORT || 53), process.env.UPSTREAM_DNS || '8.8.8.8', (err) => {
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


// Cuenta de la persona usuaria (registro, login con JWT, sesion). Lo usa la UI.
const { createAuthRouter } = require('./auth-routes');
app.use('/api/auth', createAuthRouter());

// Dominios de la persona usuaria y verificacion por TXT. Lo usa la UI.
const { createDomainsRouter } = require('./domains-routes');
app.use('/api/domains', createDomainsRouter());

// URLs de cada dominio, sus API keys y sus usuarios. Lo usa la UI.
const { createUrlsRouter } = require('./urls-routes');
app.use('/api', createUrlsRouter());

// Endpoints de servicio para las cachés zonales (config y verificación de credenciales).
app.use('/api/cache', createCacheRouter({ store }));
const { createCacheLoginRouter } = require('./cache-login-routes');
app.use('/api/cache-login', createCacheLoginRouter({ store }));

const { createCacheTestRouter } = require('./cache-test-routes');
app.use('/api/cache-test', createCacheTestRouter());

app.use((req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

module.exports = app;
