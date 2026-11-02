'use strict';

/**
 * URLs de un dominio, sus API keys y sus usuarios (las usa la UI). Todas las rutas exigen
 * "Authorization: Bearer <JWT>" y solo permiten tocar lo que es de quien consulta.
 *
 * URLs (cada una define: patron, origen, tamano de cache, tipos de archivo con TTL, politica y autenticacion)
 *   GET    /api/domains/:domain/urls        lista las URLs del dominio
 *   POST   /api/domains/:domain/urls        crea una URL
 *   GET    /api/urls/:id                    ve una URL
 *   PUT    /api/urls/:id                    modifica campos de una URL
 *   DELETE /api/urls/:id                    borra la URL con sus claves y usuarios
 *
 * API keys (authType = "apikey")
 *   GET    /api/urls/:id/api-keys           lista (solo prefijo y fecha)
 *   POST   /api/urls/:id/api-keys           crea una clave y la devuelve UNA sola vez
 *   DELETE /api/api-keys/:id                elimina
 *
 * Usuarios (authType = "userpass")
 *   GET    /api/urls/:id/users              lista
 *   POST   /api/urls/:id/users              { username, password }
 *   PUT    /api/urls/:id/users/:username    { password } cambia la contrasena
 *   DELETE /api/urls/:id/users/:username    elimina
 *
 * - Las API keys son aleatorias y largas: se guardan como SHA-256 (hex). Nunca en claro.
 * - Las contrasenas de los usuarios se guardan con bcrypt.
 * - Estas rutas se montan en /api; cada una lleva su propio control de acceso, asi lo que no coincide
 *   sigue de largo hacia /api/cache, /api/records, etc.
 *
 * Variables de entorno (opcionales): MAX_CACHE_MB (1024), MAX_URLS_PER_DOMAIN (100), BCRYPT_ROUNDS (10).
 */

const crypto = require('crypto');
const express = require('express');
const { requireAuth } = require('./auth');
const { normalizeDomain } = require('./domains-routes');

const POLICIES = ['LRU', 'LFU', 'FIFO', 'MRU', 'RANDOM'];
const AUTH_TYPES = ['none', 'apikey', 'userpass'];
const PATTERN_RE = /^\/[A-Za-z0-9\-._~!$&'()*+,;=:@%/]*$/;
const EXT_RE = /^[a-z0-9]{1,10}$/;
const USERNAME_RE = /^[A-Za-z0-9._-]{3,32}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_FILE_TYPES = 50;
const MAX_KEYS_PER_URL = 20;
const MAX_TTL_SECONDS = 31536000; // 1 anio
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72; // limite real de bcrypt

const sha256Hex = (v) => crypto.createHash('sha256').update(String(v)).digest('hex');
const validPassword = (pw) => typeof pw === 'string' && pw.length >= MIN_PASSWORD && Buffer.byteLength(pw) <= MAX_PASSWORD_BYTES;

function normalizeOrigin(v) {
  if (typeof v !== 'string' || v.length > 300) return null;
  const s = v.trim();
  let u;
  try { u = new URL(s); } catch (e) { return null; }
  if (!['http:', 'https:'].includes(u.protocol) || !u.hostname || u.username || u.password) return null;
  return s.replace(/\/+$/, '');
}

/**
 * Valida los campos de una URL. partial=true (PUT): solo los que vienen. Devuelve { value, errors }.
 */
function validateUrlFields(body, { partial = false, env = process.env } = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const value = {};
  const errors = [];
  const present = (k) => b[k] !== undefined;
  const maxMb = Number(env.MAX_CACHE_MB) || 1024;

  if (present('pattern') || !partial) {
    if (typeof b.pattern === 'string' && b.pattern.length <= 200 && PATTERN_RE.test(b.pattern)) value.pattern = b.pattern;
    else errors.push('pattern debe empezar con "/" y puede llevar comodines (ejemplo: /imagenes/*)');
  }
  if (present('origin') || !partial) {
    const origin = normalizeOrigin(b.origin);
    if (origin) value.origin = origin;
    else errors.push('origin debe ser una URL http o https (ejemplo: http://apache:80)');
  }
  if (present('cacheSizeMB') || !partial) {
    if (Number.isInteger(b.cacheSizeMB) && b.cacheSizeMB >= 1 && b.cacheSizeMB <= maxMb) value.cacheSizeMB = b.cacheSizeMB;
    else errors.push(`cacheSizeMB debe ser un entero entre 1 y ${maxMb}`);
  }
  if (present('fileTypes') || !partial) {
    const list = b.fileTypes;
    const seen = new Set();
    const out = [];
    let ok = Array.isArray(list) && list.length <= MAX_FILE_TYPES;
    if (ok) {
      for (const f of list) {
        const ext = f && typeof f.ext === 'string' ? f.ext.trim().replace(/^\./, '').toLowerCase() : '';
        if (!EXT_RE.test(ext) || seen.has(ext) || !Number.isInteger(f.ttlSeconds) || f.ttlSeconds < 0 || f.ttlSeconds > MAX_TTL_SECONDS) { ok = false; break; }
        seen.add(ext);
        out.push({ ext, ttlSeconds: f.ttlSeconds });
      }
    }
    if (ok) value.fileTypes = out;
    else errors.push(`fileTypes debe ser una lista (maximo ${MAX_FILE_TYPES}) de { ext, ttlSeconds } sin extensiones repetidas`);
  }
  if (present('replacementPolicy') || !partial) {
    const p = String(b.replacementPolicy === undefined ? 'LRU' : b.replacementPolicy).toUpperCase();
    if (POLICIES.includes(p)) value.replacementPolicy = p;
    else errors.push(`replacementPolicy debe ser una de: ${POLICIES.join(', ')}`);
  }
  if (present('authType') || !partial) {
    const a = b.authType === undefined ? 'none' : b.authType;
    if (AUTH_TYPES.includes(a)) value.authType = a;
    else errors.push(`authType debe ser una de: ${AUTH_TYPES.join(', ')}`);
  }
  return { value, errors };
}

const urlView = (u) => ({
  id: u.id,
  domain: u.domain,
  pattern: u.pattern,
  origin: u.origin,
  cacheSizeMB: u.cacheSizeMB,
  fileTypes: u.fileTypes || [],
  replacementPolicy: u.replacementPolicy,
  authType: u.authType,
  createdAt: u.createdAt || null,
});

/** Almacen sobre Firestore (colecciones urls, apiKeys, urlUsers y domains). Conexion diferida. */
function firestoreUrlsStore() {
  const db = () => require('./firebase').db;
  const col = (name) => db().collection(name);
  const withId = (d) => ({ id: d.id, ...d.data() });
  const byUrl = async (name, urlId) => (await col(name).where('urlId', '==', urlId).get()).docs.map(withId);
  return {
    async getDomain(id) {
      const s = await col('domains').doc(id).get();
      return s.exists ? withId(s) : null;
    },
    async listUrls(domain) { return (await col('urls').where('domain', '==', domain).get()).docs.map(withId); },
    async getUrl(id) {
      const s = await col('urls').doc(id).get();
      return s.exists ? withId(s) : null;
    },
    async createUrl(data) { return (await col('urls').add(data)).id; },
    async updateUrl(id, fields) { await col('urls').doc(id).update(fields); },
    async deleteUrlCascade(id) {
      const refs = [col('urls').doc(id)];
      for (const name of ['apiKeys', 'urlUsers']) {
        // eslint-disable-next-line no-await-in-loop
        const snap = await col(name).where('urlId', '==', id).get();
        snap.docs.forEach((d) => refs.push(d.ref));
      }
      for (let i = 0; i < refs.length; i += 400) {
        const batch = db().batch();
        refs.slice(i, i + 400).forEach((r) => batch.delete(r));
        // eslint-disable-next-line no-await-in-loop
        await batch.commit();
      }
    },
    listApiKeys: (urlId) => byUrl('apiKeys', urlId),
    async createApiKey(data) { return (await col('apiKeys').add(data)).id; },
    async getApiKey(id) {
      const s = await col('apiKeys').doc(id).get();
      return s.exists ? withId(s) : null;
    },
    async deleteApiKey(id) { await col('apiKeys').doc(id).delete(); },
    listUsers: (urlId) => byUrl('urlUsers', urlId),
    async createUser(id, data) {
      try {
        await col('urlUsers').doc(id).create(data);
        return true;
      } catch (err) {
        if (err && (err.code === 6 || /ALREADY_EXISTS/.test(String(err.message)))) return false;
        throw err;
      }
    },
    async getUser(id) {
      const s = await col('urlUsers').doc(id).get();
      return s.exists ? withId(s) : null;
    },
    async updateUser(id, fields) { await col('urlUsers').doc(id).update(fields); },
    async deleteUser(id) { await col('urlUsers').doc(id).delete(); },
  };
}

function createUrlsRouter({ store = firestoreUrlsStore(), env = process.env } = {}) {
  const router = express.Router();
  const bcrypt = () => require('bcryptjs');
  const rounds = () => Math.min(14, Math.max(4, Number(env.BCRYPT_ROUNDS) || 10));
  const maxUrls = () => Number(env.MAX_URLS_PER_DOMAIN) || 100;
  const guard = [requireAuth({ env }), (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); }];

  /** Dominio del parametro si es de quien consulta; si no, responde 404/400 y devuelve null. */
  async function ownedDomain(req, res) {
    const parsed = normalizeDomain(req.params.domain);
    if (!parsed) { res.status(400).json({ error: 'El dominio no es valido' }); return null; }
    const doc = await store.getDomain(parsed.domain);
    if (!doc || doc.ownerId !== req.user.id) { res.status(404).json({ error: 'Dominio no encontrado' }); return null; }
    return doc;
  }

  /** URL del parametro :id si es de quien consulta; si no, responde 404 y devuelve null. */
  async function ownedUrl(req, res) {
    const id = req.params.id;
    const url = ID_RE.test(id) ? await store.getUrl(id) : null;
    if (!url || url.ownerId !== req.user.id) { res.status(404).json({ error: 'URL no encontrada' }); return null; }
    return url;
  }

  const patternTaken = async (domain, pattern, exceptId) => (await store.listUrls(domain)).some((u) => u.pattern === pattern && u.id !== exceptId);

  // ---------------------------------------------------------------- URLs
  router.get('/domains/:domain/urls', guard, async (req, res, next) => {
    try {
      const domain = await ownedDomain(req, res);
      if (!domain) return;
      const urls = await store.listUrls(domain.id);
      urls.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      res.json({ urls: urls.map(urlView) });
    } catch (err) { next(err); }
  });

  router.post('/domains/:domain/urls', guard, async (req, res, next) => {
    try {
      const domain = await ownedDomain(req, res);
      if (!domain) return;
      const { value, errors } = validateUrlFields(req.body, { env });
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      const existing = await store.listUrls(domain.id);
      if (existing.length >= maxUrls()) return res.status(409).json({ error: `Un dominio admite hasta ${maxUrls()} URLs` });
      if (existing.some((u) => u.pattern === value.pattern)) return res.status(409).json({ error: 'Ya existe una URL con ese patron en el dominio' });

      const data = { ownerId: req.user.id, domain: domain.id, ...value, createdAt: new Date().toISOString() };
      const id = await store.createUrl(data);
      return res.status(201).json(urlView({ id, ...data }));
    } catch (err) { return next(err); }
  });

  router.get('/urls/:id', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (url) res.json(urlView(url));
    } catch (err) { next(err); }
  });

  router.put('/urls/:id', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return undefined;
      const { value, errors } = validateUrlFields(req.body, { partial: true, env });
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });
      if (Object.keys(value).length === 0) return res.status(400).json({ error: 'No hay campos para modificar' });
      if (value.pattern && value.pattern !== url.pattern && (await patternTaken(url.domain, value.pattern, url.id))) {
        return res.status(409).json({ error: 'Ya existe una URL con ese patron en el dominio' });
      }
      await store.updateUrl(url.id, value);
      return res.json(urlView({ ...url, ...value }));
    } catch (err) { return next(err); }
  });

  router.delete('/urls/:id', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return;
      await store.deleteUrlCascade(url.id);
      res.json({ deleted: true, id: url.id });
    } catch (err) { next(err); }
  });

  // ------------------------------------------------------------ API keys
  router.get('/urls/:id/api-keys', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return;
      const keys = await store.listApiKeys(url.id);
      keys.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      res.json({ apiKeys: keys.map((k) => ({ id: k.id, prefix: k.prefix, createdAt: k.createdAt || null })) });
    } catch (err) { next(err); }
  });

  router.post('/urls/:id/api-keys', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return undefined;
      if (url.authType !== 'apikey') return res.status(400).json({ error: 'Esta URL no usa API key (authType debe ser "apikey")' });
      if ((await store.listApiKeys(url.id)).length >= MAX_KEYS_PER_URL) {
        return res.status(409).json({ error: `Una URL admite hasta ${MAX_KEYS_PER_URL} API keys` });
      }

      const apiKey = crypto.randomBytes(24).toString('base64url'); // 32 caracteres, 192 bits
      const data = { urlId: url.id, ownerId: req.user.id, keyHash: sha256Hex(apiKey), prefix: apiKey.slice(0, 6), createdAt: new Date().toISOString() };
      const id = await store.createApiKey(data);
      // La clave completa solo se muestra ahora; despues solo queda su hash.
      return res.status(201).json({ id, apiKey, prefix: data.prefix, createdAt: data.createdAt });
    } catch (err) { return next(err); }
  });

  router.delete('/api-keys/:id', guard, async (req, res, next) => {
    try {
      const key = ID_RE.test(req.params.id) ? await store.getApiKey(req.params.id) : null;
      const url = key ? await store.getUrl(key.urlId) : null;
      if (!key || !url || url.ownerId !== req.user.id) return res.status(404).json({ error: 'API key no encontrada' });
      await store.deleteApiKey(key.id);
      return res.json({ deleted: true, id: key.id });
    } catch (err) { return next(err); }
  });

  // ------------------------------------------------------------- Usuarios
  const userDocId = (urlId, username) => `${urlId}_${username}`;

  router.get('/urls/:id/users', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return;
      const users = await store.listUsers(url.id);
      users.sort((a, b) => String(a.username).localeCompare(String(b.username)));
      res.json({ users: users.map((u) => ({ username: u.username, createdAt: u.createdAt || null })) });
    } catch (err) { next(err); }
  });

  router.post('/urls/:id/users', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return undefined;
      if (url.authType !== 'userpass') return res.status(400).json({ error: 'Esta URL no usa usuario y contrasena (authType debe ser "userpass")' });
      const { username, password } = req.body || {};
      if (typeof username !== 'string' || !USERNAME_RE.test(username)) {
        return res.status(400).json({ error: 'username debe tener de 3 a 32 caracteres: letras, numeros, punto, guion o guion bajo' });
      }
      if (!validPassword(password)) return res.status(400).json({ error: `La contrasena debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD_BYTES} caracteres` });

      const data = {
        urlId: url.id,
        ownerId: req.user.id,
        username,
        passwordHash: await bcrypt().hash(password, rounds()),
        createdAt: new Date().toISOString(),
      };
      const created = await store.createUser(userDocId(url.id, username), data);
      if (!created) return res.status(409).json({ error: 'Ese usuario ya existe en la URL' });
      return res.status(201).json({ username, createdAt: data.createdAt });
    } catch (err) { return next(err); }
  });

  /** Usuario de la URL (de quien consulta); si no existe, responde 404 y devuelve null. */
  async function loadUser(req, res, url) {
    const username = String(req.params.username);
    const user = USERNAME_RE.test(username) ? await store.getUser(userDocId(url.id, username)) : null;
    if (!user) { res.status(404).json({ error: 'Usuario no encontrado' }); return null; }
    return user;
  }

  router.put('/urls/:id/users/:username', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return undefined;
      const user = await loadUser(req, res, url);
      if (!user) return undefined;
      const { password } = req.body || {};
      if (!validPassword(password)) return res.status(400).json({ error: `La contrasena debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD_BYTES} caracteres` });
      await store.updateUser(userDocId(url.id, user.username), { passwordHash: await bcrypt().hash(password, rounds()) });
      return res.json({ username: user.username, updated: true });
    } catch (err) { return next(err); }
  });

  router.delete('/urls/:id/users/:username', guard, async (req, res, next) => {
    try {
      const url = await ownedUrl(req, res);
      if (!url) return undefined;
      const user = await loadUser(req, res, url);
      if (!user) return undefined;
      await store.deleteUser(userDocId(url.id, user.username));
      return res.json({ deleted: true, username: user.username });
    } catch (err) { return next(err); }
  });

  return router;
}

module.exports = { createUrlsRouter, validateUrlFields, normalizeOrigin, firestoreUrlsStore, sha256Hex };