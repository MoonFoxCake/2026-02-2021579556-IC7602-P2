'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createCacheTestRouter } = require('../src/cache-test-routes');
const { cors } = require('../src/cors');

const secret = 'test-only-admin-secret-with-at-least-32-characters';
const csrf = 'a'.repeat(64);
const session = 'b'.repeat(64);

async function start(t, overrides = {}) {
  const seen = [];
  let activeSession = false;
  const cache = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    seen.push({ path: req.url, headers: req.headers, body });
    if (req.url.startsWith('/__zc/login')) {
      if (req.method === 'GET') {
        res.setHeader('Set-Cookie', `zc_csrf=${csrf}; HttpOnly`);
        return res.end(`<input name="csrf" value="${csrf}">`);
      }
      const fields = new URLSearchParams(body);
      assert.equal(fields.get('csrf'), csrf);
      assert.equal(req.headers.cookie, `zc_csrf=${csrf}`);
      if (fields.get('password') !== 'correct-password') { res.statusCode = 401; return res.end('wrong'); }
      activeSession = true;
      res.statusCode = 302; res.setHeader('Location', '/private/index.html');
      res.setHeader('Set-Cookie', `zc_session=${session}; HttpOnly`);
      return res.end();
    }
    if (req.url.startsWith('/__zc/logout')) { activeSession = false; res.statusCode = 302; return res.end(); }
    if (req.url.startsWith('/private') && (!activeSession || req.headers.cookie !== `zc_session=${session}`)) {
      res.statusCode = 302; res.setHeader('Location', '/__zc/login?return_to=x'); return res.end();
    }
    if (req.url.startsWith('/key') && req.headers['x-api-key'] !== 'valid-key') { res.statusCode = 401; return res.end('denied'); }
    if (req.url.startsWith('/redirect')) { res.statusCode = 302; res.setHeader('Location', 'http://external.invalid/'); return res.end(); }
    res.setHeader('X-Cache', seen.filter((r) => r.path === req.url).length > 1 ? 'HIT' : 'MISS');
    res.setHeader('X-ZC-Zone', 'cr'); res.setHeader('Set-Cookie', 'origin_secret=never-expose');
    return res.end(req.url === '/large' ? 'x'.repeat(100000) : 'cached content');
  });
  await new Promise((resolve) => cache.listen(0, '127.0.0.1', resolve));
  const env = { JWT_SECRET: secret, CACHE_TEST_URL: `http://127.0.0.1:${cache.address().port}`,
    CACHE_TEST_COOKIE_SECURE: '0', CORS_ORIGINS: 'http://ui.test', ...overrides };
  const store = {
    getUrl: async (id) => id === 'missing' ? null : ({ id, ownerId: id === 'foreign' ? 'other' : 'owner',
      domain: id === 'wildcard' ? '*.demo.test' : 'demo.test', authType: 'userpass', pattern: '/*' }),
    getDomain: async (id) => ({ id, ownerId: 'owner', verified: id !== 'unverified.test' }),
  };
  const app = express(); app.use(cors({ env })); app.use(express.json());
  app.use('/api/cache-test', createCacheTestRouter({ env, store }));
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); cache.closeAllConnections(); server.close(); cache.close(); });
  const token = jwt.sign({}, secret, { subject: 'owner' });
  const call = async (path, body = {}, headers = {}, method = 'POST') => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/cache-test${path}`, {
      method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      ...(method === 'GET' ? {} : { body: JSON.stringify({ urlId: 'own', host: 'demo.test', path: '/index.html', ...body }) }),
      redirect: 'manual',
    });
    return { response, json: await response.json() };
  };
  return { call, seen };
}

test('requires admin authentication, ownership and an explicitly configured fixed cache', async (t) => {
  const s = await start(t);
  assert.equal((await s.call('/request', {}, { authorization: '' })).response.status, 401);
  for (const urlId of ['foreign', 'missing']) assert.equal((await s.call('/request', { urlId })).response.status, 404);
  const disabled = await start(t, { CACHE_TEST_URL: '' });
  assert.equal((await disabled.call('/status', {}, {}, 'GET')).json.enabled, false);
  assert.equal((await disabled.call('/request')).response.status, 503);
  assert.equal(s.seen.length, 0);
});

test('rejects host injection, absolute URLs, traversal and reserved authentication paths', async (t) => {
  const s = await start(t);
  for (const path of ['http://example.com/', '//example.com/', '/%2e%2e/secret', '/__zc/login', '/a%0d%0aX:evil', '/\\evil', '/bad%']) {
    assert.equal((await s.call('/request', { path })).response.status, 400, path);
  }
  assert.equal((await s.call('/request', { host: 'other.test' })).response.status, 400);
  assert.equal((await s.call('/request', { apiKey: 'bad\r\nheader' })).response.status, 400);
  assert.equal(s.seen.length, 0);
  assert.equal((await s.call('/request', { urlId: 'wildcard', host: 'app.demo.test' })).response.status, 200);
});

test('reports real cache responses without forwarding admin tokens or origin cookies', async (t) => {
  const s = await start(t);
  const first = await s.call('/request');
  assert.equal(first.json.headers['x-cache'], 'MISS');
  assert.equal(first.json.body, 'cached content');
  assert.equal(first.json.headers['set-cookie'], undefined);
  assert.equal(first.response.headers.get('set-cookie'), null);
  assert.equal(s.seen[0].headers.host, 'demo.test');
  assert.equal(s.seen[0].headers.authorization, undefined);
  assert.equal((await s.call('/request')).json.headers['x-cache'], 'HIT');
  const redirect = await s.call('/request', { path: '/redirect' });
  assert.equal(redirect.json.status, 302);
  assert.equal(s.seen.length, 3);
  const large = await s.call('/request', { path: '/large' });
  assert.equal(large.json.truncated, true);
  assert.equal(large.json.body.length, 64 * 1024);
});

test('supports API key rejection and success without treating resource 401 as admin logout', async (t) => {
  const s = await start(t);
  const denied = await s.call('/request', { path: '/key/index.html' });
  assert.equal(denied.response.status, 200);
  assert.equal(denied.json.status, 401);
  assert.equal((await s.call('/request', { path: '/key/index.html', apiKey: 'valid-key' })).json.status, 200);
});

test('reuses native CSRF login, isolates the session in HttpOnly cookies and revokes on logout', async (t) => {
  const s = await start(t);
  const input = { path: '/private/index.html', username: 'reader', password: 'wrong-password' };
  assert.equal((await s.call('/request', input)).json.requiresLogin, true);
  const wrong = await s.call('/login', input);
  assert.equal(wrong.response.status, 200);
  assert.equal(wrong.json.authenticated, false);
  const login = await s.call('/login', { ...input, password: 'correct-password' });
  assert.equal(login.json.authenticated, true);
  assert.ok(!JSON.stringify(login.json).includes(session));
  const setCookie = login.response.headers.get('set-cookie');
  assert.match(setCookie, /HttpOnly/); assert.match(setCookie, /Path=\/api\/cache-test/);
  assert.match(setCookie, /SameSite=Strict/);
  const cookie = setCookie.split(';')[0];
  assert.equal((await s.call('/request', input, { cookie })).json.status, 200);
  assert.equal((await s.call('/logout', input, { cookie })).json.authenticated, false);
  assert.equal((await s.call('/request', input, { cookie })).json.requiresLogin, true);
});

test('cross-origin credentials are allowed only for configured UI origins', async (t) => {
  const s = await start(t);
  const allowed = await s.call('/status', {}, { origin: 'http://ui.test' }, 'GET');
  assert.equal(allowed.response.headers.get('access-control-allow-credentials'), 'true');
  const denied = await s.call('/status', {}, { origin: 'http://other.test' }, 'GET');
  assert.equal(denied.response.headers.get('access-control-allow-origin'), null);
});
