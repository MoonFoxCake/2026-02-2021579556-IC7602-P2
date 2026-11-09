'use strict';

const assert = require('node:assert/strict');
const dgram = require('node:dgram');
const { randomUUID } = require('node:crypto');

async function request(url, options) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(8000) });
}

async function ready(url) {
  for (let i = 0; i < 30; i++) {
    try { if ((await request(url)).ok) return; } catch { /* wait for startup */ }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`Not ready: ${url}`);
}

async function dnsCheck() {
  const socket = dgram.createSocket('udp4');
  const query = Buffer.from('12340100000100000000000002703204746573740000010001', 'hex');
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('DNS response timeout')), 8000);
    socket.once('error', reject);
    socket.once('message', (response) => {
      try {
        assert.equal(response.readUInt16BE(0), 0x1234);
        assert.equal(response[3] & 15, 0);
        assert.ok(response.readUInt16BE(6) >= 1);
        assert.equal([...response.subarray(-4)].join('.'), '127.0.0.1');
        resolve();
      } catch (error) { reject(error); }
    });
    socket.send(query, 5353, 'dns-interceptor', (error) => { if (error) reject(error); });
    socket.once('close', () => clearTimeout(timer));
  }).finally(() => socket.close());
}

async function smoke() {
  await Promise.all([
    ready('http://frontend:8080/'), ready('http://rest-api-java:8080/api/health'),
    ready('http://zonal-cache:8080/__zc/healthz'),
  ]);
  const ui = await request('http://frontend:8080/');
  assert.match(await ui.text(), /<div id="root"><\/div>/);
  assert.equal((await request('http://frontend:8080/api/health/db')).status, 200);
  const login = await request('http://frontend:8080/api/auth/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: process.env.LOCAL_DEMO_EMAIL, password: process.env.LOCAL_DEMO_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const { token } = await login.json();
  const domains = await request('http://frontend:8080/api/domains', {
    headers: { authorization: `Bearer ${token}` },
  });
  assert.ok((await domains.json()).domains.some((d) => d.domain === 'p2.test' && d.verified));
  console.log('PASS: UI, same-origin API proxy, emulator login and seeded domain');

  const headers = { 'content-type': 'application/json' };
  const base = 'http://p2.test:8080';
  const created = await request(`${base}/api/items.json`, {
    method: 'POST', headers, body: JSON.stringify({ probe: randomUUID() }),
  });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get('x-cache'), 'BYPASS');
  const item = await created.json();
  const path = `/api/items/${item.id}.json?probe=${randomUUID()}`;
  for (const expected of ['MISS', 'HIT']) {
    const response = await request(base + path, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), expected);
    assert.deepEqual(await response.json(), item);
  }
  const updated = await request(base + path, {
    method: 'PUT', headers, body: '{"name":"updated"}',
  });
  assert.equal(updated.status, 200);
  const direct = await request(`http://rest-api-java:8080/api/items/${item.id}.json`);
  assert.equal((await direct.json()).name, 'updated');
  assert.equal((await request(base + path, { method: 'DELETE', headers })).status, 204);
  assert.equal((await request(`http://rest-api-java:8080/api/items/${item.id}.json`)).status, 404);
  const apachePath = `/index.html?probe=${randomUUID()}`;
  for (const expected of ['MISS', 'HIT']) {
    const response = await request(base + apachePath, { headers });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('x-cache'), expected);
    assert.match(await response.text(), /Apache de prueba/);
  }
  console.log('PASS: Java CRUD through cache, cache MISS/HIT and Apache origin');
  await dnsCheck();
  console.log('PASS: Interceptor UDP DNS returns 127.0.0.1 for p2.test');
}

smoke().catch((error) => { console.error(error); process.exitCode = 1; });
