'use strict';
// Routers reales con datos aislados de integración; nunca conecta a Firebase.
const express = require('express');
const { createCacheRouter } = require('../src/cache-routes');
const { createDnsRouter } = require('../src/dns-routes');
const { seed } = require('./memory-store');
const app = express();
const store = seed({ webOrigin: process.env.ORIGIN_WEB, javaOrigin: process.env.ORIGIN_JAVA });
app.get('/', (req, res) => res.json({ ok: true }));
const dnsRequests = [];
app.use('/api/records/:hostname', (req, res, next) => {
  dnsRequests.push({ hostname: req.params.hostname, sourceIp: req.query.sourceIp });
  next();
});
app.get('/test/dns-requests', (req, res) => res.json(dnsRequests));
app.use('/api', createDnsRouter({ store,
  lookupCountry: async (ip) => ({ '127.0.0.1': 'CR', '127.0.0.5': 'US' })[ip] || null,
}));
app.use('/api/cache', createCacheRouter({ store, serviceKey: process.env.SERVICE_KEY }));
app.listen(Number(process.env.PORT || 19901), '127.0.0.1', () => console.log('api en memoria listo'));
