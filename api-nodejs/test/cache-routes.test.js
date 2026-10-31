'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createCacheRouter, buildCacheConfig } = require('../src/cache-routes');
const { seed, sha256 } = require('./memory-store');

const KEY = 'clave-de-servicio-de-prueba';

async function withServer(opts, fn) {
  const app = express();
  app.use('/api/cache', createCacheRouter({ store: seed(), serviceKey: KEY, ...opts }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}/api/cache`;
  try { await fn(base); } finally { srv.close(); }
}
const auth = { Authorization: `Bearer ${KEY}` };
const post = (base, body, headers = auth) => fetch(`${base}/verify-credentials`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('buildCacheConfig traduce el modelo de Firestore al formato de la caché', async () => {
  const s = seed();
  const cfg = buildCacheConfig({ domains: await s.listDomains(), urls: await s.listUrls(), apiKeys: await s.listApiKeys() });
  assert.equal(cfg.domains.length, 1);                       // solo dominios verificados
  const d = cfg.domains[0];
  assert.equal(d.domain, 'ejemplo.com');
  assert.equal(d.origin, 'http://origen-web:80');            // origen del dominio = el de "/*"
  assert.equal(d.maxCacheBytes, 5 * 1024 * 1024);            // suma de las URLs (1+2+1+1 MiB)
  const byPat = Object.fromEntries(d.urls.map((u) => [u.pattern, u]));
  assert.deepEqual(byPat['/*'].fileTypes, [{ ext: 'html', ttl: 60, policy: 'LRU' }, { ext: 'png', ttl: 3600, policy: 'LRU' }]);
  assert.equal(byPat['/api/*'].origin, 'http://rest-api-java:8080');
  assert.deepEqual(byPat['/api/*'].auth, { mode: 'apikey', apiKeyHashes: [sha256('clave-demo')] }); // minúsculas
  assert.equal(byPat['/api/*'].fileTypes[0].policy, 'MRU');
  assert.equal(byPat['/privado/*'].auth.mode, 'userpass');
  assert.equal(byPat['/privado/*'].cacheBytes, 1024 * 1024);
  // authType desconocido => falla cerrado (nadie pasa), y política desconocida => LRU
  assert.deepEqual(byPat['/raro/*'].auth, { mode: 'apikey', apiKeyHashes: [] });
  assert.ok(!JSON.stringify(cfg).includes('passwordHash'));
});

test('/config exige credencial de servicio', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/config`)).status, 401);
    assert.equal((await fetch(`${base}/config`, { headers: { Authorization: 'Bearer mala' } })).status, 401);
    const ok = await fetch(`${base}/config`, { headers: auth });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get('cache-control'), 'no-store');
    assert.equal((await ok.json()).domains[0].domain, 'ejemplo.com');
    const alt = await fetch(`${base}/config`, { headers: { 'x-service-key': KEY } });   // también acepta x-service-key
    assert.equal(alt.status, 200);
  });
});

test('sin SERVICE_KEY configurada el endpoint falla cerrado (503)', async () => {
  await withServer({ serviceKey: '' }, async (base) => {
    assert.equal((await fetch(`${base}/config`, { headers: auth })).status, 503);
  });
});

test('/verify-credentials', async () => {
  await withServer({}, async (base) => {
    const good = { domain: 'EJEMPLO.com', pattern: '/privado/*', username: 'kevin', password: 's3creto' };
    assert.equal((await post(base, good)).status, 200);
    assert.equal((await post(base, { ...good, password: 'mala' })).status, 401);
    assert.equal((await post(base, { ...good, username: 'otro' })).status, 401);          // usuario inexistente
    assert.equal((await post(base, { ...good, pattern: '/api/*' })).status, 401);          // la URL no es userpass
    assert.equal((await post(base, { ...good, domain: 'pendiente.com' })).status, 401);   // dominio sin verificar
    assert.equal((await post(base, { domain: 'ejemplo.com' })).status, 400);               // cuerpo incompleto
    assert.equal((await post(base, good, {})).status, 401);                                // sin credencial de servicio
  });
});
