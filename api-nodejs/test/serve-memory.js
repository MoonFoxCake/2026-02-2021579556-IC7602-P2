'use strict';
// Levanta el API con el router de caché sobre un almacén en memoria (sin Firebase). Solo para pruebas de integración.
const express = require('express');
const { createCacheRouter } = require('../src/cache-routes');
const { seed } = require('./memory-store');
const app = express();
app.use('/api/cache', createCacheRouter({ store: seed(), serviceKey: process.env.SERVICE_KEY }));
app.listen(Number(process.env.PORT || 19901), '127.0.0.1', () => console.log('api en memoria listo'));
