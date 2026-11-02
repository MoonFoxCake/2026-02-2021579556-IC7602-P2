'use strict';

/**
 * Pruebas de registro, login, JWT y CORS. No tocan Firestore: usan un almacen en memoria.
 * Ejecutar:  node --test test/auth.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const jwt = require('jsonwebtoken');
const { createAuthRouter, createLoginLimiter } = require('../src/auth-routes');
const { cors } = require('../src/cors');

const SECRET = 'a'.repeat(40);
const baseEnv = { JWT_SECRET: SECRET, JWT_EXPIRES_IN: '3600', BCRYPT_ROUNDS: '4', LOGIN_MAX_ATTEMPTS: '3' };

function memoryStore() {
  const rows = new Map();
  return {
    rows,
    create: async (id, data) => { if (rows.has(id)) return false; rows.set(id, data); return true; },
    get: async (id) => (rows.has(id) ? { id, ...rows.get(id) } : null),
  };
}

async function start(env = baseEnv, store = memoryStore()) {
  const app = express();
  app.use(cors({ env }));
  app.use(express.json());
  app.use('/api/auth', createAuthRouter({ store, env }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/auth`;
  const call = async (path, { method = 'GET', body, headers = {} } = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: { 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* sin cuerpo */ }
    return { status: res.status, json, headers: res.headers };
  };
  return { call, store, close: () => server.close() };
}

const creds = { email: 'Ana@Ejemplo.com', password: 'clave-segura-123' };

test('registro: crea la cuenta, normaliza el correo y NO guarda la contrasena en claro', async () => {
  const s = await start();
  const r = await s.call('/register', { method: 'POST', body: creds });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.email, 'ana@ejemplo.com');
  assert.ok(r.json.id);
  const saved = [...s.store.rows.values()][0];
  assert.match(saved.passwordHash, /^\$2[aby]\$/);
  assert.ok(!JSON.stringify(saved).includes(creds.password));
  s.close();
});

test('registro: correo repetido (aunque cambie mayusculas) da 409', async () => {
  const s = await start();
  await s.call('/register', { method: 'POST', body: creds });
  const r = await s.call('/register', { method: 'POST', body: { ...creds, email: 'ANA@ejemplo.COM' } });
  assert.strictEqual(r.status, 409);
  s.close();
});

test('registro: valida correo y contrasena', async () => {
  const s = await start();
  for (const body of [
    { email: 'no-es-correo', password: 'clave-segura-123' },
    { email: 'a@b.com', password: 'corta' },
    { email: 'a@b.com', password: 'x'.repeat(73) },
    { email: 'a@b.com' },
    {},
  ]) {
    const r = await s.call('/register', { method: 'POST', body });
    assert.strictEqual(r.status, 400, JSON.stringify(body));
  }
  s.close();
});

test('login: devuelve un JWT HS256 valido con sub=id y expiracion', async () => {
  const s = await start();
  const reg = await s.call('/register', { method: 'POST', body: creds });
  const r = await s.call('/login', { method: 'POST', body: { email: 'ana@ejemplo.com', password: creds.password } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.expiresIn, 3600);
  const payload = jwt.verify(r.json.token, SECRET, { algorithms: ['HS256'] });
  assert.strictEqual(payload.sub, reg.json.id);
  assert.strictEqual(payload.email, 'ana@ejemplo.com');
  assert.ok(payload.exp - payload.iat === 3600);
  s.close();
});

test('login: contrasena incorrecta y usuario inexistente dan el MISMO 401', async () => {
  const s = await start();
  await s.call('/register', { method: 'POST', body: creds });
  const a = await s.call('/login', { method: 'POST', body: { email: creds.email, password: 'incorrecta-123' } });
  const b = await s.call('/login', { method: 'POST', body: { email: 'nadie@ejemplo.com', password: 'incorrecta-123' } });
  assert.strictEqual(a.status, 401);
  assert.strictEqual(b.status, 401);
  assert.deepStrictEqual(a.json, b.json);
  s.close();
});

test('login: tras demasiados intentos fallidos responde 429 con Retry-After', async () => {
  const s = await start();
  await s.call('/register', { method: 'POST', body: creds });
  const bad = { email: creds.email, password: 'incorrecta-123' };
  for (let i = 0; i < 3; i += 1) assert.strictEqual((await s.call('/login', { method: 'POST', body: bad })).status, 401);
  const blocked = await s.call('/login', { method: 'POST', body: bad });
  assert.strictEqual(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  // Ni siquiera la contrasena correcta entra mientras dure el bloqueo.
  assert.strictEqual((await s.call('/login', { method: 'POST', body: { email: creds.email, password: creds.password } })).status, 429);
  s.close();
});

test('login: un acierto reinicia el contador de fallos', async () => {
  const s = await start();
  await s.call('/register', { method: 'POST', body: creds });
  const bad = { email: creds.email, password: 'incorrecta-123' };
  await s.call('/login', { method: 'POST', body: bad });
  await s.call('/login', { method: 'POST', body: bad });
  assert.strictEqual((await s.call('/login', { method: 'POST', body: creds })).status, 200);
  for (let i = 0; i < 3; i += 1) assert.strictEqual((await s.call('/login', { method: 'POST', body: bad })).status, 401);
  s.close();
});

test('limiter: la ventana expira y libera el bloqueo', async () => {
  const l = createLoginLimiter({ max: 1, windowMs: 30 });
  l.fail('k');
  assert.ok(l.retryAfterSeconds('k') > 0);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(l.retryAfterSeconds('k'), 0);
});

test('/me: con token valido devuelve la cuenta; sin token o manipulado da 401', async () => {
  const s = await start();
  const reg = await s.call('/register', { method: 'POST', body: creds });
  const { json } = await s.call('/login', { method: 'POST', body: creds });
  const ok = await s.call('/me', { headers: { authorization: `Bearer ${json.token}` } });
  assert.strictEqual(ok.status, 200);
  assert.deepStrictEqual(ok.json, { id: reg.json.id, email: 'ana@ejemplo.com' });

  assert.strictEqual((await s.call('/me')).status, 401);
  assert.strictEqual((await s.call('/me', { headers: { authorization: 'Bearer abc.def.ghi' } })).status, 401);
  assert.strictEqual((await s.call('/me', { headers: { authorization: `Bearer ${json.token}x` } })).status, 401);
  s.close();
});

test('/me: rechaza token expirado, firmado con otro secreto y con alg "none"', async () => {
  const s = await start();
  const expired = jwt.sign({ email: 'a@b.com' }, SECRET, { subject: 'u1', expiresIn: -10 });
  const otherSecret = jwt.sign({ email: 'a@b.com' }, 'b'.repeat(40), { subject: 'u1', expiresIn: 60 });
  const none = `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u1","email":"a@b.com"}').toString('base64url')}.`;
  for (const token of [expired, otherSecret, none]) {
    assert.strictEqual((await s.call('/me', { headers: { authorization: `Bearer ${token}` } })).status, 401);
  }
  s.close();
});

test('sin JWT_SECRET (o demasiado corto) el login y /me fallan cerrado con 503', async () => {
  for (const JWT_SECRET of [undefined, 'corto']) {
    const s = await start({ ...baseEnv, JWT_SECRET });
    assert.strictEqual((await s.call('/login', { method: 'POST', body: creds })).status, 503);
    assert.strictEqual((await s.call('/me', { headers: { authorization: 'Bearer x' } })).status, 503);
    s.close();
  }
});

test('CORS: responde solo a los origenes de CORS_ORIGINS y contesta el preflight', async () => {
  const env = { ...baseEnv, CORS_ORIGINS: 'https://ui.example.com, http://localhost:5173' };
  const s = await start(env);
  const allowed = await s.call('/me', { method: 'OPTIONS', headers: { origin: 'https://ui.example.com' } });
  assert.strictEqual(allowed.status, 204);
  assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://ui.example.com');
  assert.match(allowed.headers.get('access-control-allow-headers'), /Authorization/);

  const denied = await s.call('/me', { method: 'OPTIONS', headers: { origin: 'https://malo.example.com' } });
  assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);

  const none = await start(baseEnv); // sin CORS_ORIGINS
  const r = await none.call('/me', { headers: { origin: 'https://ui.example.com' } });
  assert.strictEqual(r.headers.get('access-control-allow-origin'), null);
  s.close();
  none.close();
});