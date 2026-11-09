'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const { createCacheLoginRouter } = require('../src/cache-login-routes');
const { seed } = require('./memory-store');
const SECRET = 'test-only-ticket-secret-32-characters-minimum';
const INPUT = { domain: 'ejemplo.com', pattern: '/privado/*', callback: 'https://ejemplo.com/__zc/callback',
  returnTo: '/privado/index.html?x=1', username: 'kevin', password: 's3creto' };

async function server(options, run) {
  const app = express();
  app.use(express.json());
  app.use('/login', createCacheLoginRouter({ store: seed(), env: { TICKET_SECRET: SECRET }, ...options }));
  const listener = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => listener.once('listening', resolve));
  const post = (body) => fetch(`http://127.0.0.1:${listener.address().port}/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  try { await run(post); } finally { listener.close(); }
}

test('resource credentials issue a cache-compatible 60s ticket without an account JWT', async () => {
  await server({}, async (post) => {
    const response = await post(INPUT);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const result = await response.json();
    const url = new URL(result.redirectUrl);
    assert.equal(url.origin, 'https://ejemplo.com');
    assert.equal(url.pathname, '/__zc/callback');
    assert.equal(url.searchParams.get('return_to'), INPUT.returnTo);
    const [payload, signature] = url.searchParams.get('ticket').split('.');
    assert.equal(signature, crypto.createHmac('sha256', SECRET).update(payload).digest('hex'));
    const ticket = JSON.parse(Buffer.from(payload, 'base64url'));
    assert.equal(ticket.domain, INPUT.domain); assert.equal(ticket.pattern, INPUT.pattern); assert.equal(ticket.user, INPUT.username);
    assert.ok(ticket.exp > Date.now() / 1000 && ticket.exp <= Date.now() / 1000 + 60);
    assert.equal(ticket.nonce.length, 64);
    assert.ok(!JSON.stringify(result).includes(INPUT.password));
    assert.notEqual((await (await post(INPUT)).json()).redirectUrl, result.redirectUrl);
  });
});

test('rejects callbacks to other hosts, credentials in URLs, insecure callbacks and unsafe return paths', async () => {
  await server({}, async (post) => {
    for (const callback of ['https://evil.test/__zc/callback', 'https://ejemplo.com.evil.test/__zc/callback',
      'https://user@ejemplo.com/__zc/callback', 'https://ejemplo.com:8443/__zc/callback',
      'http://ejemplo.com/__zc/callback', 'https://ejemplo.com/elsewhere', 'https://ejemplo.com/__zc/callback?ticket=x']) {
      assert.equal((await post({ ...INPUT, callback })).status, 400, callback);
    }
    for (const returnTo of ['//evil.test', '/%2fevil.test', '/\\evil.test', '/%5cevil', '/%0d%0aLocation:evil', 'https://evil.test', '/%zz']) {
      assert.equal((await post({ ...INPUT, returnTo })).status, 400, returnTo);
    }
    assert.equal((await post({ ...INPUT, returnTo: `/privado/a?x=${'a'.repeat(1900)}` })).status, 400);
    assert.equal((await post({ ...INPUT, pattern: '/' + 'a'.repeat(200) })).status, 400);
    assert.equal((await post({ ...INPUT, password: 'é'.repeat(37) })).status, 400);
  });
});

test('bad password, unknown user, wrong rule and unverified domain fail closed; failures are limited', async () => {
  await server({}, async (post) => {
    for (const change of [{ password: 'bad' }, { username: 'unknown' }, { pattern: '/api/*' }, { domain: 'pendiente.com', callback: 'https://pendiente.com/__zc/callback' }]) {
      assert.equal((await post({ ...INPUT, ...change })).status, 401);
    }
    await post({ ...INPUT, password: 'bad' });
    await post({ ...INPUT, password: 'bad' });
    await post({ ...INPUT, password: 'bad' });
    const blocked = await post(INPUT);
    assert.equal(blocked.status, 429); assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  });
  await server({ env: {} }, async (post) => assert.equal((await post(INPUT)).status, 503));
});

test('verified wildcard uses stored URL credentials but binds the ticket to the actual host', async () => {
  const base = seed();
  const store = { ...base,
    getDomain: async (domain) => domain === '*.ejemplo.com' ? { domain, verified: true } : null,
    findUrl: async (domain, pattern) => domain === '*.ejemplo.com' ? base.findUrl('ejemplo.com', pattern) : null,
  };
  await server({ store }, async (post) => {
    const response = await post({ ...INPUT, domain: 'sub.ejemplo.com', callback: 'https://sub.ejemplo.com/__zc/callback' });
    assert.equal(response.status, 200);
    const ticket = new URL((await response.json()).redirectUrl).searchParams.get('ticket');
    assert.equal(JSON.parse(Buffer.from(ticket.split('.')[0], 'base64url')).domain, 'sub.ejemplo.com');
  });
});
