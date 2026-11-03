'use strict';

/**
 * Pruebas de URLs, API keys y usuarios de URL. No tocan Firestore: usan un almacen en memoria.
 * Incluye una prueba de integracion: lo que crea este modulo lo entiende src/cache-routes.js.
 * Ejecutar:  node --test test/urls.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const bcrypt = require('bcryptjs');
const { signToken, getJwtConfig } = require('../src/auth');
const { createUrlsRouter, validateUrlFields, sha256Hex } = require('../src/urls-routes');
const { buildCacheConfig, verifyCredentials } = require('../src/cache-routes');

const env = { JWT_SECRET: 'a'.repeat(40), JWT_EXPIRES_IN: '3600', BCRYPT_ROUNDS: '4', MAX_URLS_PER_DOMAIN: '3' };
const tokenOf = (id) => signToken({ id, email: `${id}@ejemplo.com` }, getJwtConfig(env));
const ANA = tokenOf('ana');
const BETO = tokenOf('beto');

function memoryStore() {
  const t = { domains: new Map(), urls: new Map(), apiKeys: new Map(), urlUsers: new Map() };
  let n = 0;
  const rows = (map, pred) => [...map].filter(([, v]) => pred(v)).map(([id, v]) => ({ id, ...v }));
  return {
    t,
    getDomain: async (id) => (t.domains.has(id) ? { id, ...t.domains.get(id) } : null),
    listUrls: async (domain) => rows(t.urls, (u) => u.domain === domain),
    getUrl: async (id) => (t.urls.has(id) ? { id, ...t.urls.get(id) } : null),
    createUrl: async (data) => { n += 1; t.urls.set(`u${n}`, { ...data }); return `u${n}`; },
    updateUrl: async (id, f) => { Object.assign(t.urls.get(id), f); },
    deleteUrlCascade: async (id) => {
      t.urls.delete(id);
      for (const m of [t.apiKeys, t.urlUsers]) for (const [k, v] of m) if (v.urlId === id) m.delete(k);
    },
    listApiKeys: async (urlId) => rows(t.apiKeys, (k) => k.urlId === urlId),
    createApiKey: async (data) => { n += 1; t.apiKeys.set(`k${n}`, { ...data }); return `k${n}`; },
    getApiKey: async (id) => (t.apiKeys.has(id) ? { id, ...t.apiKeys.get(id) } : null),
    deleteApiKey: async (id) => { t.apiKeys.delete(id); },
    listUsers: async (urlId) => rows(t.urlUsers, (u) => u.urlId === urlId),
    createUser: async (id, data) => { if (t.urlUsers.has(id)) return false; t.urlUsers.set(id, { ...data }); return true; },
    getUser: async (id) => (t.urlUsers.has(id) ? { id, ...t.urlUsers.get(id) } : null),
    updateUser: async (id, f) => { Object.assign(t.urlUsers.get(id), f); },
    deleteUser: async (id) => { t.urlUsers.delete(id); },
  };
}

async function start() {
  const store = memoryStore();
  store.t.domains.set('ana.com', { ownerId: 'ana', verified: true, txtToken: 'x' });
  store.t.domains.set('beto.com', { ownerId: 'beto', verified: true, txtToken: 'y' });
  const app = express();
  app.use(express.json());
  app.use('/api', createUrlsRouter({ store, env }));
  app.get('/api/otra-ruta', (req, res) => res.json({ ok: true })); // debe seguir accesible sin token
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api`;
  const call = async (path, { method = 'GET', body, token = ANA } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* sin cuerpo */ }
    return { status: res.status, json };
  };
  return { call, store, close: () => server.close() };
}

const goodUrl = {
  pattern: '/imagenes/*',
  origin: 'http://apache:80/',
  cacheSizeMB: 50,
  fileTypes: [{ ext: '.PNG', ttlSeconds: 3600 }, { ext: 'html', ttlSeconds: 60 }],
  replacementPolicy: 'lfu',
  authType: 'apikey',
};

async function newUrl(s, over = {}, token = ANA, domain = 'ana.com') {
  return s.call(`/domains/${domain}/urls`, { method: 'POST', body: { ...goodUrl, ...over }, token });
}

test('validateUrlFields: normaliza lo valido y rechaza lo invalido', () => {
  const ok = validateUrlFields(goodUrl);
  assert.deepStrictEqual(ok.errors, []);
  assert.deepStrictEqual(ok.value.fileTypes, [{ ext: 'png', ttlSeconds: 3600 }, { ext: 'html', ttlSeconds: 60 }]);
  assert.strictEqual(ok.value.replacementPolicy, 'LFU');
  assert.strictEqual(ok.value.origin, 'http://apache:80');

  const bads = [
    { pattern: 'sin-barra' }, { pattern: '/con espacio' }, { pattern: 5 },
    { origin: 'ftp://x.com' }, { origin: 'no es url' }, { origin: 'http://user:pw@x.com' },
    { cacheSizeMB: 0 }, { cacheSizeMB: 1.5 }, { cacheSizeMB: '50' }, { cacheSizeMB: 999999 },
    { fileTypes: 'png' }, { fileTypes: [{ ext: 'png', ttlSeconds: -1 }] }, { fileTypes: [{ ext: 'p ng', ttlSeconds: 1 }] },
    { fileTypes: [{ ext: 'png', ttlSeconds: 1 }, { ext: 'PNG', ttlSeconds: 2 }] },
    { replacementPolicy: 'LIFO' }, { authType: 'oauth' },
  ];
  for (const bad of bads) assert.ok(validateUrlFields({ ...goodUrl, ...bad }).errors.length > 0, JSON.stringify(bad));
  assert.strictEqual(validateUrlFields({}).errors.length > 0, true);
  assert.deepStrictEqual(validateUrlFields({ cacheSizeMB: 10 }, { partial: true }).value, { cacheSizeMB: 10 });
});

test('todas las rutas exigen token, pero las rutas ajenas del mismo prefijo siguen libres', async () => {
  const s = await start();
  for (const [method, path] of [
    ['GET', '/domains/ana.com/urls'], ['POST', '/domains/ana.com/urls'], ['GET', '/urls/u1'], ['PUT', '/urls/u1'], ['DELETE', '/urls/u1'],
    ['GET', '/urls/u1/api-keys'], ['POST', '/urls/u1/api-keys'], ['DELETE', '/api-keys/k1'],
    ['GET', '/urls/u1/users'], ['POST', '/urls/u1/users'], ['PUT', '/urls/u1/users/x'], ['DELETE', '/urls/u1/users/x'],
  ]) {
    assert.strictEqual((await s.call(path, { method, token: null })).status, 401, `${method} ${path}`);
  }
  assert.strictEqual((await s.call('/otra-ruta', { token: null })).status, 200);
  s.close();
});

test('crear URL: guarda los campos normalizados con el duenio y devuelve 201', async () => {
  const s = await start();
  const r = await newUrl(s);
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.pattern, '/imagenes/*');
  assert.strictEqual(r.json.replacementPolicy, 'LFU');
  assert.strictEqual(r.json.fileTypes[0].ext, 'png');
  const saved = s.store.t.urls.get(r.json.id);
  assert.strictEqual(saved.ownerId, 'ana');
  assert.strictEqual(saved.domain, 'ana.com');
  s.close();
});

test('crear URL: valores por defecto, errores 400, patron repetido 409 y limite por dominio', async () => {
  const s = await start();
  const minimal = { pattern: '/a', origin: 'https://example.org', cacheSizeMB: 5, fileTypes: [] };
  const r = await s.call('/domains/ana.com/urls', { method: 'POST', body: minimal });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.replacementPolicy, 'LRU');
  assert.strictEqual(r.json.authType, 'none');

  assert.strictEqual((await newUrl(s, { pattern: 'mal' })).status, 400);
  assert.strictEqual((await newUrl(s, { pattern: '/a' })).status, 409);
  assert.strictEqual((await newUrl(s, { pattern: '/b' })).status, 201);
  assert.strictEqual((await newUrl(s, { pattern: '/c' })).status, 201);
  assert.strictEqual((await newUrl(s, { pattern: '/d' })).status, 409); // MAX_URLS_PER_DOMAIN = 3
  s.close();
});

test('autorizacion: no se puede ver, crear ni tocar URLs de dominios o URLs ajenos', async () => {
  const s = await start();
  const mine = await newUrl(s);
  assert.strictEqual((await s.call('/domains/ana.com/urls', { token: BETO })).status, 404);
  assert.strictEqual((await newUrl(s, {}, BETO, 'ana.com')).status, 404);
  for (const [method, path, body] of [
    ['GET', `/urls/${mine.json.id}`], ['PUT', `/urls/${mine.json.id}`, { cacheSizeMB: 9 }], ['DELETE', `/urls/${mine.json.id}`],
    ['GET', `/urls/${mine.json.id}/api-keys`], ['POST', `/urls/${mine.json.id}/api-keys`],
    ['GET', `/urls/${mine.json.id}/users`], ['POST', `/urls/${mine.json.id}/users`, { username: 'abc', password: 'clave-larga-1' }],
  ]) {
    assert.strictEqual((await s.call(path, { method, body, token: BETO })).status, 404, `${method} ${path}`);
  }
  assert.ok(s.store.t.urls.has(mine.json.id));
  assert.strictEqual((await s.call('/urls/no-existe')).status, 404);
  assert.strictEqual((await s.call('/urls/..')).status, 404);
  s.close();
});

test('listar y ver: cada persona ve solo lo suyo', async () => {
  const s = await start();
  await newUrl(s, { pattern: '/uno' });
  await newUrl(s, { pattern: '/dos' }, BETO, 'beto.com');
  const a = await s.call('/domains/ana.com/urls');
  assert.deepStrictEqual(a.json.urls.map((u) => u.pattern), ['/uno']);
  const one = await s.call(`/urls/${a.json.urls[0].id}`);
  assert.strictEqual(one.json.pattern, '/uno');
  s.close();
});

test('modificar: cambia solo lo enviado, valida y no deja repetir patrones', async () => {
  const s = await start();
  const a = await newUrl(s, { pattern: '/a' });
  const b = await newUrl(s, { pattern: '/b' });
  const r = await s.call(`/urls/${a.json.id}`, { method: 'PUT', body: { cacheSizeMB: 99, replacementPolicy: 'fifo' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.cacheSizeMB, 99);
  assert.strictEqual(r.json.replacementPolicy, 'FIFO');
  assert.strictEqual(r.json.pattern, '/a');
  assert.strictEqual(s.store.t.urls.get(a.json.id).cacheSizeMB, 99);
  assert.strictEqual((await s.call(`/urls/${a.json.id}`, { method: 'PUT', body: { cacheSizeMB: 0 } })).status, 400);
  assert.strictEqual((await s.call(`/urls/${a.json.id}`, { method: 'PUT', body: {} })).status, 400);
  assert.strictEqual((await s.call(`/urls/${a.json.id}`, { method: 'PUT', body: { pattern: '/b' } })).status, 409);
  assert.strictEqual((await s.call(`/urls/${b.json.id}`, { method: 'PUT', body: { pattern: '/b' } })).status, 200); // mismo patron propio
  s.close();
});

test('borrar URL: elimina tambien sus claves y usuarios', async () => {
  const s = await start();
  const u = await newUrl(s, { authType: 'apikey' });
  await s.call(`/urls/${u.json.id}/api-keys`, { method: 'POST' });
  const del = await s.call(`/urls/${u.json.id}`, { method: 'DELETE' });
  assert.deepStrictEqual(del.json, { deleted: true, id: u.json.id });
  assert.strictEqual(s.store.t.urls.size, 0);
  assert.strictEqual(s.store.t.apiKeys.size, 0);
  s.close();
});

test('API keys: la clave se muestra una vez y solo se guarda su hash SHA-256', async () => {
  const s = await start();
  const u = await newUrl(s, { authType: 'apikey' });
  const k = await s.call(`/urls/${u.json.id}/api-keys`, { method: 'POST' });
  assert.strictEqual(k.status, 201);
  assert.ok(k.json.apiKey.length >= 32);
  assert.strictEqual(k.json.prefix, k.json.apiKey.slice(0, 6));
  const saved = s.store.t.apiKeys.get(k.json.id);
  assert.strictEqual(saved.keyHash, sha256Hex(k.json.apiKey));
  assert.ok(!JSON.stringify(saved).includes(k.json.apiKey));

  const list = await s.call(`/urls/${u.json.id}/api-keys`);
  assert.strictEqual(list.json.apiKeys.length, 1);
  assert.ok(!JSON.stringify(list.json).includes(k.json.apiKey));
  assert.deepStrictEqual(Object.keys(list.json.apiKeys[0]).sort(), ['createdAt', 'id', 'prefix']);

  assert.strictEqual((await s.call(`/api-keys/${k.json.id}`, { method: 'DELETE', token: BETO })).status, 404);
  assert.strictEqual((await s.call(`/api-keys/${k.json.id}`, { method: 'DELETE' })).status, 200);
  assert.strictEqual(s.store.t.apiKeys.size, 0);
  assert.strictEqual((await s.call(`/api-keys/${k.json.id}`, { method: 'DELETE' })).status, 404);
  s.close();
});

test('API keys: solo para URLs con authType apikey y con maximo por URL', async () => {
  const s = await start();
  const none = await newUrl(s, { pattern: '/n', authType: 'none' });
  assert.strictEqual((await s.call(`/urls/${none.json.id}/api-keys`, { method: 'POST' })).status, 400);
  const u = await newUrl(s, { pattern: '/k', authType: 'apikey' });
  for (let i = 0; i < 20; i += 1) assert.strictEqual((await s.call(`/urls/${u.json.id}/api-keys`, { method: 'POST' })).status, 201);
  assert.strictEqual((await s.call(`/urls/${u.json.id}/api-keys`, { method: 'POST' })).status, 409);
  s.close();
});

test('usuarios: se crean con bcrypt, no se repiten, se cambian y se borran', async () => {
  const s = await start();
  const u = await newUrl(s, { authType: 'userpass' });
  const p = `/urls/${u.json.id}/users`;

  const created = await s.call(p, { method: 'POST', body: { username: 'maria', password: 'clave-larga-1' } });
  assert.strictEqual(created.status, 201);
  assert.deepStrictEqual(Object.keys(created.json).sort(), ['createdAt', 'username']);
  const saved = s.store.t.urlUsers.get(`${u.json.id}_maria`);
  assert.match(saved.passwordHash, /^\$2[aby]\$/);
  assert.ok(await bcrypt.compare('clave-larga-1', saved.passwordHash));

  assert.strictEqual((await s.call(p, { method: 'POST', body: { username: 'maria', password: 'otra-clave-1' } })).status, 409);
  assert.strictEqual((await s.call(p, { method: 'POST', body: { username: 'a', password: 'clave-larga-1' } })).status, 400);
  assert.strictEqual((await s.call(p, { method: 'POST', body: { username: 'bien', password: 'corta' } })).status, 400);

  const list = await s.call(p);
  assert.deepStrictEqual(list.json.users.map((x) => x.username), ['maria']);
  assert.ok(!JSON.stringify(list.json).includes('passwordHash'));

  assert.strictEqual((await s.call(`${p}/maria`, { method: 'PUT', body: { password: 'nueva-clave-9' } })).status, 200);
  assert.ok(await bcrypt.compare('nueva-clave-9', s.store.t.urlUsers.get(`${u.json.id}_maria`).passwordHash));
  assert.strictEqual((await s.call(`${p}/maria`, { method: 'PUT', body: { password: 'x' } })).status, 400);
  assert.strictEqual((await s.call(`${p}/nadie`, { method: 'PUT', body: { password: 'nueva-clave-9' } })).status, 404);

  assert.strictEqual((await s.call(`${p}/maria`, { method: 'DELETE' })).status, 200);
  assert.strictEqual(s.store.t.urlUsers.size, 0);
  assert.strictEqual((await s.call(`${p}/maria`, { method: 'DELETE' })).status, 404);
  s.close();
});

test('usuarios: solo en URLs con authType userpass', async () => {
  const s = await start();
  const u = await newUrl(s, { authType: 'apikey' });
  assert.strictEqual((await s.call(`/urls/${u.json.id}/users`, { method: 'POST', body: { username: 'maria', password: 'clave-larga-1' } })).status, 400);
  s.close();
});

test('integracion: lo creado aqui lo entienden las rutas de la cache (config y verify-credentials)', async () => {
  const s = await start();
  const k = await newUrl(s, { pattern: '/api/*', authType: 'apikey' });
  const key = (await s.call(`/urls/${k.json.id}/api-keys`, { method: 'POST' })).json.apiKey;
  const p = await newUrl(s, { pattern: '/privado/*', authType: 'userpass' });
  await s.call(`/urls/${p.json.id}/users`, { method: 'POST', body: { username: 'maria', password: 'clave-larga-1' } });

  const cfg = buildCacheConfig({
    domains: [{ id: 'ana.com', domain: 'ana.com', ...s.store.t.domains.get('ana.com') }],
    urls: [...s.store.t.urls].map(([id, v]) => ({ id, ...v })),
    apiKeys: [...s.store.t.apiKeys].map(([id, v]) => ({ id, ...v })),
  });
  const rules = Object.fromEntries(cfg.domains[0].urls.map((r) => [r.pattern, r]));
  assert.strictEqual(rules['/api/*'].auth.mode, 'apikey');
  assert.deepStrictEqual(rules['/api/*'].auth.apiKeyHashes, [sha256Hex(key)]);
  assert.strictEqual(rules['/privado/*'].auth.mode, 'userpass');
  assert.strictEqual(rules['/api/*'].cacheBytes, 50 * 1024 * 1024);

  const cacheStore = {
    getDomain: async (d) => ({ id: d, domain: d, ...s.store.t.domains.get(d) }),
    findUrl: async (d, pattern) => [...s.store.t.urls].map(([id, v]) => ({ id, ...v })).find((u) => u.domain === d && u.pattern === pattern) || null,
    getUser: async (urlId, username) => s.store.t.urlUsers.get(`${urlId}_${username}`) || null,
  };
  const args = { domain: 'ana.com', pattern: '/privado/*', username: 'maria', password: 'clave-larga-1' };
  assert.strictEqual(await verifyCredentials(cacheStore, bcrypt.compare, args), true);
  assert.strictEqual(await verifyCredentials(cacheStore, bcrypt.compare, { ...args, password: 'mala-clave-1' }), false);
  s.close();
});