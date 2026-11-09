'use strict';

const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');

module.exports = async function cacheTestSmoke(request) {
  if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_PROJECT_ID?.startsWith('demo-')) {
    throw new Error('Cache UI smoke requires the local demo Firestore emulator');
  }
  const { db } = require('../src/firebase');
  const base = 'http://frontend:8080/api';
  const domain = `cache-ui-${randomUUID().slice(0, 8)}.test`;
  let token;
  let created = false;
  const call = async (path, body, { method = 'POST', cookie } = {}) => {
    const response = await request(base + path, {
      method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(cookie ? { cookie } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const json = await response.json();
    assert.ok(response.ok, JSON.stringify(json));
    return { json, response };
  };
  try {
    token = (await call('/auth/login', { email: process.env.LOCAL_DEMO_EMAIL,
      password: process.env.LOCAL_DEMO_PASSWORD })).json.token;
    const owner = (await call('/auth/me', undefined, { method: 'GET' })).json;
    await db.collection('domains').doc(domain).create({ ownerId: owner.id, verified: true, createdAt: new Date().toISOString() });
    created = true;
    const createRule = async (pattern, origin, ext, authType) => (await call(`/domains/${domain}/urls`, {
      pattern, origin, cacheSizeMB: 1, fileTypes: [{ ext, ttlSeconds: 30 }], replacementPolicy: 'LRU', authType,
    })).json;
    const keyRule = await createRule('/*', 'http://apache-web:8080', 'html', 'apikey');
    const userRule = await createRule('/api/*', 'http://rest-api-java:8080', 'json', 'userpass');
    const apiKey = (await call(`/urls/${keyRule.id}/api-keys`, {})).json.apiKey;
    await call(`/urls/${userRule.id}/users`, { username: 'reader', password: 'local-smoke-password' });
    const keyInput = { urlId: keyRule.id, host: domain, path: `/index.html?probe=${randomUUID()}` };
    let loaded = false;
    for (let i = 0; i < 30; i++) {
      if ((await call('/cache-test/request', keyInput)).json.status === 401) { loaded = true; break; }
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
    assert.ok(loaded, 'Cache did not reload the temporary rules');
    assert.equal((await call('/cache-test/request', { ...keyInput, apiKey: 'wrong' })).json.status, 401);
    for (const expected of ['MISS', 'HIT']) {
      const { json } = await call('/cache-test/request', { ...keyInput, apiKey });
      assert.equal(json.status, 200); assert.equal(json.headers['x-cache'], expected);
    }
    const userInput = { urlId: userRule.id, host: domain, path: `/api/items.json?probe=${randomUUID()}` };
    assert.equal((await call('/cache-test/request', userInput)).json.requiresLogin, true);
    assert.equal((await call('/cache-test/login', { ...userInput, username: 'reader', password: 'wrong-password' })).json.authenticated, false);
    const login = await call('/cache-test/login', { ...userInput, username: 'reader', password: 'local-smoke-password' });
    assert.equal(login.json.authenticated, true);
    const setCookie = login.response.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    const cookie = setCookie.split(';')[0];
    for (const expected of ['MISS', 'HIT']) {
      const { json } = await call('/cache-test/request', userInput, { cookie });
      assert.equal(json.status, 200); assert.equal(json.headers['x-cache'], expected);
    }
    await call('/cache-test/logout', userInput, { cookie });
    assert.equal((await call('/cache-test/request', userInput, { cookie })).json.requiresLogin, true);
    console.log('PASS: UI cache bridge, real API keys, CSRF login, authenticated MISS/HIT and logout revocation');
  } finally {
    try {
      if (created) await call(`/domains/${domain}`, undefined, { method: 'DELETE' });
    } finally { await db.terminate(); }
  }
};
