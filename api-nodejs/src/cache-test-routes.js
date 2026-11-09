'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const { requireAuth } = require('./auth');
const { firestoreUrlsStore } = require('./urls-routes');
const { normalizeDomain } = require('./domains-routes');

const LIMIT = 64 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const HEADERS = ['content-type', 'x-cache', 'x-zc-zone', 'x-zc-rule', 'x-zc-policy', 'x-zc-ttl', 'x-zc-domain-bytes'];

function cookieValue(lines, name) {
  const prefix = `${name}=`;
  return (lines || []).find((line) => line.startsWith(prefix))?.slice(prefix.length).split(';')[0] || '';
}

// Fixed infrastructure destination; user input can select a resource, never a server.
function cacheRequest(endpoint, host, path, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
      method, path, headers: { ...headers, host, ...(body === undefined ? {} : {
        'content-type': 'application/x-www-form-urlencoded', 'content-length': Buffer.byteLength(body),
      }) },
    }, (response) => {
      const chunks = [];
      let size = 0;
      let finished = false;
      const finish = (truncated) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve({ status: response.statusCode, headers: response.headers,
          body: Buffer.concat(chunks).toString('utf8'), truncated });
      };
      response.on('data', (chunk) => {
        const remaining = LIMIT - size;
        chunks.push(chunk.subarray(0, remaining));
        size += Math.min(chunk.length, remaining);
        if (chunk.length > remaining) { finish(true); response.destroy(); }
      });
      response.on('end', () => finish(false));
      response.on('error', (error) => { clearTimeout(timer); reject(error); });
    });
    timer = setTimeout(() => request.destroy(new Error('Cache timeout')), 8000);
    request.on('error', (error) => { clearTimeout(timer); reject(error); });
    request.end(body);
  });
}

function createCacheTestRouter({ store = firestoreUrlsStore(), env = process.env } = {}) {
  const router = express.Router();
  router.use(requireAuth({ env }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.get('/status', (req, res) => res.json({ enabled: Boolean(env.CACHE_TEST_URL) }));

  router.use(async (req, res, next) => {
    if (!env.CACHE_TEST_URL) return res.status(503).json({ error: 'El entorno no tiene una caché de prueba configurada.' });
    let endpoint;
    try { endpoint = new URL(env.CACHE_TEST_URL); } catch { /* invalid server configuration */ }
    if (!endpoint || !['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password
        || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) {
      return res.status(503).json({ error: 'CACHE_TEST_URL debe ser un origen HTTP/HTTPS sin ruta ni credenciales.' });
    }
    const { urlId, host, path } = req.body || {};
    if (typeof urlId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(urlId)) {
      return res.status(400).json({ error: 'Selecciona una regla de caché.' });
    }
    try {
      const rule = await store.getUrl(urlId);
      if (!rule || rule.ownerId !== req.user.id) return res.status(404).json({ error: 'Regla no encontrada.' });
      const domain = await store.getDomain(rule.domain);
      if (!domain || domain.ownerId !== req.user.id || domain.verified !== true) {
        return res.status(409).json({ error: 'El dominio debe estar verificado y pertenecer a tu cuenta.' });
      }
      const parsed = normalizeDomain(host || rule.domain);
      if (!parsed || parsed.wildcard || (domain.id.startsWith('*.')
        ? !parsed.domain.endsWith(`.${domain.id.slice(2)}`) : parsed.domain !== domain.id)) {
        return res.status(400).json({ error: 'El host debe pertenecer al dominio de la regla.' });
      }
      let decoded;
      try { decoded = decodeURIComponent(path); } catch { /* invalid resource path */ }
      if (typeof path !== 'string' || path.length > 1800 || !decoded?.startsWith('/')
          || decoded.startsWith('//') || /[\x00-\x20\x7f\\#]/.test(decoded)
          || decoded.split(/[/?]/).some((part) => part === '.' || part === '..')
          || decoded.startsWith('/__zc/')) {
        return res.status(400).json({ error: 'Usa una ruta local, por ejemplo /index.html; las rutas /__zc/ están reservadas.' });
      }
      req.cacheTest = { endpoint, rule, host: parsed.domain, path,
        cookieName: `p2_zc_${crypto.createHash('sha256').update(req.user.id).digest('hex').slice(0, 16)}_${urlId}` };
      next();
    } catch (error) { next(error); }
    return undefined;
  });

  function session(req) {
    const value = cookieValue(String(req.get('cookie') || '').split(/;\s*/), req.cacheTest.cookieName);
    return TOKEN.test(value) ? `zc_session=${value}` : '';
  }
  const cookieOptions = () => ({ httpOnly: true, secure: env.CACHE_TEST_COOKIE_SECURE !== '0',
    sameSite: env.CACHE_TEST_COOKIE_SECURE === '0' ? 'strict' : 'none', path: '/api/cache-test' });

  router.post('/request', async (req, res) => {
    const { endpoint, host, path } = req.cacheTest;
    const apiKey = req.body.apiKey || '';
    if (typeof apiKey !== 'string' || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
      return res.status(400).json({ error: 'API key inválida.' });
    }
    try {
      const started = performance.now();
      const result = await cacheRequest(endpoint, host, path, { headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}), ...(session(req) ? { cookie: session(req) } : {}),
      } });
      return res.json({ status: result.status, elapsedMs: Math.round(performance.now() - started),
        headers: Object.fromEntries(HEADERS.filter((name) => result.headers[name] !== undefined)
          .map((name) => [name, result.headers[name]])), body: result.body, truncated: result.truncated,
        requiresLogin: result.status === 302 && String(result.headers.location || '').startsWith('/__zc/login'),
      });
    } catch { return res.status(502).json({ error: 'No se pudo consultar la caché. Comprueba su conexión y estado.' }); }
  });

  router.post('/login', async (req, res) => {
    const { endpoint, rule, host, path, cookieName } = req.cacheTest;
    const { username, password } = req.body;
    if (rule.authType !== 'userpass' || typeof username !== 'string' || !username || username.length > 255
        || typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: 'Selecciona una regla con usuario/contraseña e ingresa credenciales válidas.' });
    }
    try {
      const loginPath = `/__zc/login?return_to=${encodeURIComponent(path)}`;
      const form = await cacheRequest(endpoint, host, loginPath);
      const csrf = cookieValue(form.headers['set-cookie'], 'zc_csrf');
      if (form.status !== 200 || !TOKEN.test(csrf)) {
        return res.status(502).json({ error: 'La caché no ofrece un formulario local para esta ruta. Espera el refresco y revisa la regla y el modo de login.' });
      }
      const result = await cacheRequest(endpoint, host, '/__zc/login', {
        method: 'POST', headers: { cookie: `zc_csrf=${csrf}` },
        body: new URLSearchParams({ csrf, username, password, return_to: path }).toString(),
      });
      const token = cookieValue(result.headers['set-cookie'], 'zc_session');
      const authenticated = result.status === 302 && TOKEN.test(token);
      if (authenticated) res.cookie(cookieName, token, cookieOptions());
      else res.clearCookie(cookieName, cookieOptions());
      return res.json({ authenticated, status: result.status,
        message: authenticated ? 'Sesión de caché iniciada.' : result.status === 429
          ? 'Demasiados intentos. Espera unos minutos.' : result.status === 401
            ? 'Usuario o contraseña incorrectos.' : 'La caché no pudo completar el inicio de sesión.' });
    } catch { return res.status(502).json({ error: 'El servicio de autenticación de la caché no está disponible.' }); }
  });

  router.post('/logout', async (req, res) => {
    const { endpoint, host, cookieName } = req.cacheTest;
    try {
      await cacheRequest(endpoint, host, '/__zc/logout?return_to=%2F', { headers: { cookie: session(req) } });
      res.clearCookie(cookieName, cookieOptions());
      return res.json({ authenticated: false });
    } catch { return res.status(502).json({ error: 'No se pudo cerrar la sesión en la caché. Intenta de nuevo.' }); }
  });
  return router;
}

module.exports = { createCacheTestRouter };
