'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const { createDnsRouter } = require('../src/dns-routes');
const { buildCacheConfig } = require('../src/cache-routes');

const ENV = {
  ZONE_CACHES: 'cr=10.0.0.11,us=10.0.0.12',
  COUNTRY_ZONES: 'CR=cr,PA=cr,NI=cr,*=us',
  DNS_RECORD_TTL: '30',
};
const DOMAINS = {
  'ejemplo.com': { id: 'ejemplo.com', domain: 'ejemplo.com', verified: true },
  '*.comodin.com': { id: '*.comodin.com', domain: '*.comodin.com', verified: true },
  'pendiente.com': { id: 'pendiente.com', domain: 'pendiente.com', verified: false },
  'solo-us.com': { id: 'solo-us.com', domain: 'solo-us.com', verified: true, zones: ['us'] },
};
const store = { getDomain: async (d) => DOMAINS[d] || null };

async function withServer(env, fn, lookupCountry = async (ip) => ({ '192.168.49.20': 'CR', '172.20.0.5': 'US' })[ip] || null) {
  const app = express();
  app.use('/api', createDnsRouter({ store, env, lookupCountry }));
  const srv = http.createServer(app);
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${srv.address().port}/api/records`); } finally { srv.close(); }
}

test('dominio verificado: record geo con las cachés zonales y la zona del cliente', async () => {
  await withServer(ENV, async (base) => {
    const cr = await (await fetch(`${base}/ejemplo.com?sourceIp=192.168.49.20`)).json();
    assert.equal(cr.type, 'geo');
    assert.equal(cr.ttl, 30);
    assert.deepEqual(cr.targets.map((t) => [t.address, t.country]), [['10.0.0.11', 'CR'], ['10.0.0.12', 'US']]);
    assert.equal(cr.client.country, 'CR');
    assert.equal(cr.client.countryCode, 'CR');              // dns.c compara esto con targets[].country
    const us = await (await fetch(`${base}/ejemplo.com?sourceIp=172.20.0.5`)).json();
    assert.equal(us.client.countryCode, 'US');
    const otro = await (await fetch(`${base}/ejemplo.com?sourceIp=8.8.8.8`)).json();
    assert.equal(otro.client.countryCode, 'US');            // país desconocido -> zona "*"
    const forzado = await (await fetch(`${base}/ejemplo.com?country=pa`)).json();
    assert.equal(forzado.client.country, null);              // query string cannot override the database
    assert.equal(forzado.client.countryCode, 'US');
  });
});

test('comodín, no verificado, no registrado y zonas restringidas', async () => {
  await withServer(ENV, async (base) => {
    assert.equal((await fetch(`${base}/www.comodin.com`)).status, 200);
    assert.equal((await fetch(`${base}/pendiente.com`)).status, 404);   // sin TXT -> el interceptor reenvía
    assert.equal((await fetch(`${base}/google.com`)).status, 404);
    const r = await (await fetch(`${base}/solo-us.com?sourceIp=192.168.49.20`)).json();
    assert.deepEqual(r.targets.map((t) => t.id), ['us']);
    assert.equal(r.client.countryCode, 'US');                // su zona (cr) no sirve el dominio -> la que hay
  });
});

test('sin ZONE_CACHES el endpoint falla con 503 (no inventa IPs)', async () => {
  await withServer({}, async (base) => {
    assert.equal((await fetch(`${base}/ejemplo.com`)).status, 503);
  });
});

test('database failures are 503, not a fabricated default country', async () => {
  await withServer(ENV, async (base) => {
    assert.equal((await fetch(`${base}/ejemplo.com?sourceIp=8.8.8.8`)).status, 503);
  }, async () => { throw new Error('unavailable'); });
});

test('config de caché filtrada por zona solo si el dominio define "zones"', () => {
  const domains = [{ domain: 'a.com', verified: true }, { domain: 'b.com', verified: true, zones: ['US'] }];
  const urls = [{ id: 'u', domain: 'a.com', pattern: '/*', authType: 'none' }, { id: 'v', domain: 'b.com', pattern: '/*', authType: 'none' }];
  const names = (zone) => buildCacheConfig({ domains, urls, apiKeys: [], zone }).domains.map((d) => d.domain);
  assert.deepEqual(names('cr'), ['a.com']);
  assert.deepEqual(names('us'), ['a.com', 'b.com']);
  assert.deepEqual(names(undefined), ['a.com', 'b.com']);
});
