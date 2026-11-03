'use strict';

/**
 * Pruebas de dominios y verificacion TXT. No tocan Firestore ni el DNS real: usan un almacen en memoria
 * y un resolvedor TXT falso.
 * Ejecutar:  node --test test/domains.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const { signToken, getJwtConfig } = require('../src/auth');
const { createDomainsRouter, normalizeDomain } = require('../src/domains-routes');

const env = { JWT_SECRET: 'a'.repeat(40), JWT_EXPIRES_IN: '3600' };
const tokenOf = (id) => signToken({ id, email: `${id}@ejemplo.com` }, getJwtConfig(env));
const ANA = tokenOf('ana');
const BETO = tokenOf('beto');

function memoryStore() {
  const rows = new Map();
  const cascaded = [];
  return {
    rows,
    cascaded,
    create: async (id, data) => { if (rows.has(id)) return false; rows.set(id, { ...data }); return true; },
    get: async (id) => (rows.has(id) ? { id, ...rows.get(id) } : null),
    listByOwner: async (ownerId) => [...rows].filter(([, v]) => v.ownerId === ownerId).map(([id, v]) => ({ id, ...v })),
    update: async (id, fields) => { Object.assign(rows.get(id), fields); },
    deleteCascade: async (id) => { cascaded.push(id); rows.delete(id); },
  };
}

async function start({ txt = {} } = {}) {
  const store = memoryStore();
  const queries = [];
  // txt: { 'nombre.consultado': [['valor']] | Error }
  const resolveTxt = async (name) => {
    queries.push(name);
    const r = txt[name];
    if (r instanceof Error) throw r;
    if (!r) { const e = new Error('no data'); e.code = 'ENODATA'; throw e; }
    return r;
  };
  const app = express();
  app.use(express.json());
  app.use('/api/domains', createDomainsRouter({ store, env, resolveTxt }));
  const server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}/api/domains`;
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
  return { call, store, queries, close: () => server.close() };
}

test('normalizeDomain: acepta dominios y comodines, rechaza basura', () => {
  assert.strictEqual(normalizeDomain(' Ejemplo.COM. ').domain, 'ejemplo.com');
  assert.deepStrictEqual(normalizeDomain('*.ejemplo.com'), { domain: '*.ejemplo.com', base: 'ejemplo.com', wildcard: true });
  for (const bad of ['', 'localhost', 'http://ejemplo.com', 'ejemplo.com/ruta', 'a b.com', '-malo.com', 'ejemplo..com', '1.2.3.4', '*.com', 42, null, 'a'.repeat(64) + '.com']) {
    assert.strictEqual(normalizeDomain(bad), null, String(bad));
  }
});

test('todas las rutas exigen token', async () => {
  const s = await start();
  assert.strictEqual((await s.call('/', { token: null })).status, 401);
  assert.strictEqual((await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' }, token: null })).status, 401);
  assert.strictEqual((await s.call('/ejemplo.com/verify', { method: 'POST', token: null })).status, 401);
  assert.strictEqual((await s.call('/ejemplo.com', { method: 'DELETE', token: null })).status, 401);
  s.close();
});

test('crear: devuelve el TXT a configurar y deja el dominio sin verificar', async () => {
  const s = await start();
  const r = await s.call('/', { method: 'POST', body: { domain: 'Ejemplo.com' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.json.domain, 'ejemplo.com');
  assert.strictEqual(r.json.verified, false);
  assert.strictEqual(r.json.txt.name, '_p2redes.ejemplo.com');
  assert.match(r.json.txt.value, /^p2redes-verify=[0-9a-f]{32}$/);
  assert.ok(r.json.instructions.includes(r.json.txt.value));
  assert.strictEqual(s.store.rows.get('ejemplo.com').ownerId, 'ana');
  s.close();
});

test('crear: dominio invalido da 400 y repetido da 409 (aunque lo intente otra persona)', async () => {
  const s = await start();
  assert.strictEqual((await s.call('/', { method: 'POST', body: { domain: 'no valido' } })).status, 400);
  assert.strictEqual((await s.call('/', { method: 'POST', body: {} })).status, 400);
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });
  assert.strictEqual((await s.call('/', { method: 'POST', body: { domain: 'EJEMPLO.com' } })).status, 409);
  assert.strictEqual((await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' }, token: BETO })).status, 409);
  s.close();
});

test('listar: cada persona ve solo sus dominios', async () => {
  const s = await start();
  await s.call('/', { method: 'POST', body: { domain: 'ana.com' } });
  await s.call('/', { method: 'POST', body: { domain: 'beto.com' }, token: BETO });
  const a = await s.call('/');
  assert.deepStrictEqual(a.json.domains.map((d) => d.domain), ['ana.com']);
  const b = await s.call('/', { token: BETO });
  assert.deepStrictEqual(b.json.domains.map((d) => d.domain), ['beto.com']);
  s.close();
});

test('verificar: con el TXT correcto marca verified y lo guarda; con un valor incorrecto no', async () => {
  const txt = { '_p2redes.ejemplo.com': [['otro registro'], ['p2redes-verify=valor-incorrecto']] };
  const s = await start({ txt });
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });

  const wrong = await s.call('/ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(wrong.status, 200);
  assert.strictEqual(wrong.json.verified, false);
  assert.strictEqual(s.store.rows.get('ejemplo.com').verified, false);

  // ahora el DNS (falso) publica el valor real que pide el API
  txt['_p2redes.ejemplo.com'].push([`p2redes-verify=${s.store.rows.get('ejemplo.com').txtToken}`]);
  const ok = await s.call('/ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(ok.status, 200);
  assert.strictEqual(ok.json.verified, true);
  assert.ok(ok.json.verifiedAt);
  assert.strictEqual(s.store.rows.get('ejemplo.com').verified, true);
  s.close();
});

test('verificar: el TXT puede venir partido en trozos', async () => {
  const txt = {};
  const s = await start({ txt });
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });
  const full = `p2redes-verify=${s.store.rows.get('ejemplo.com').txtToken}`;
  txt['_p2redes.ejemplo.com'] = [[full.slice(0, 10), full.slice(10)]];
  assert.strictEqual((await s.call('/ejemplo.com/verify', { method: 'POST' })).json.verified, true);
  s.close();
});

test('verificar: sin registro TXT responde verified=false con instrucciones (no es un error)', async () => {
  const s = await start();
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });
  const r = await s.call('/ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.json.verified, false);
  assert.ok(r.json.message);
  assert.strictEqual(r.json.txt.name, '_p2redes.ejemplo.com');
  s.close();
});

test('verificar: si el DNS falla (timeout, SERVFAIL) responde 502 y no marca nada', async () => {
  const err = Object.assign(new Error('timeout'), { code: 'ETIMEOUT' });
  const s = await start({ txt: { '_p2redes.ejemplo.com': err } });
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });
  const r = await s.call('/ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(r.status, 502);
  assert.strictEqual(s.store.rows.get('ejemplo.com').verified, false);
  s.close();
});

test('verificar: un comodin se verifica con el TXT del dominio base', async () => {
  const txt = {};
  const s = await start({ txt });
  const created = await s.call('/', { method: 'POST', body: { domain: '*.ejemplo.com' } });
  assert.strictEqual(created.status, 201);
  assert.strictEqual(created.json.txt.name, '_p2redes.ejemplo.com');
  txt['_p2redes.ejemplo.com'] = [[`p2redes-verify=${s.store.rows.get('*.ejemplo.com').txtToken}`]];
  const r = await s.call('/*.ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(r.json.verified, true);
  s.close();
});

test('verificar: ya verificado no vuelve a consultar el DNS', async () => {
  const txt = {};
  const s = await start({ txt });
  await s.call('/', { method: 'POST', body: { domain: 'ejemplo.com' } });
  txt['_p2redes.ejemplo.com'] = [[`p2redes-verify=${s.store.rows.get('ejemplo.com').txtToken}`]];
  await s.call('/ejemplo.com/verify', { method: 'POST' });
  const before = s.queries.length;
  const again = await s.call('/ejemplo.com/verify', { method: 'POST' });
  assert.strictEqual(again.json.verified, true);
  assert.strictEqual(s.queries.length, before);
  s.close();
});

test('autorizacion: otra persona recibe 404 al ver, verificar o borrar un dominio ajeno', async () => {
  const s = await start();
  await s.call('/', { method: 'POST', body: { domain: 'ana.com' } });
  assert.strictEqual((await s.call('/ana.com', { token: BETO })).status, 404);
  assert.strictEqual((await s.call('/ana.com/verify', { method: 'POST', token: BETO })).status, 404);
  assert.strictEqual((await s.call('/ana.com', { method: 'DELETE', token: BETO })).status, 404);
  assert.ok(s.store.rows.has('ana.com'));
  assert.strictEqual((await s.call('/no-existe.com')).status, 404); // misma respuesta que uno ajeno
  s.close();
});

test('borrar: elimina el dominio con sus datos asociados', async () => {
  const s = await start();
  await s.call('/', { method: 'POST', body: { domain: 'ana.com' } });
  const r = await s.call('/ana.com', { method: 'DELETE' });
  assert.strictEqual(r.status, 200);
  assert.deepStrictEqual(r.json, { deleted: true, domain: 'ana.com' });
  assert.deepStrictEqual(s.store.cascaded, ['ana.com']);
  assert.strictEqual((await s.call('/ana.com')).status, 404);
  s.close();
});