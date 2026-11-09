'use strict';

const crypto = require('node:crypto');
const http = require('node:http');
const https = require('node:https');
const express = require('express');
const { requireAuth } = require('./auth');
const { firestoreUrlsStore } = require('./urls-routes');
const { normalizeDomain } = require('./domains-routes');
const { verifyCredentials } = require('./cache-routes');
const { createCacheTicket } = require('./cache-login-routes');
const { createLoginLimiter } = require('./auth-routes');

const LIMIT = 64 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;
const HEADERS = ['content-type', 'x-cache', 'x-zc-zone', 'x-zc-rule', 'x-zc-policy', 'x-zc-ttl', 'x-zc-domain-bytes'];

function cookieValue(lines, name) {
  const prefix = `${name}=`;
  return (lines || []).find((line) => line.startsWith(prefix))?.slice(prefix.length).split(';')[0] || '';
}

// Fixed infrastructure destination; user input can select a resource, never a server.
function cacheRequest(endpoint, host, path, { method = 'GET', headers = {}, body, tunnelKey } = {}) {
  return new Promise((resolve, reject) => {
    let timer;
    const request = (endpoint.protocol === 'https:' ? https : http).request(endpoint, {
      method, path, servername: endpoint.hostname, headers: { ...headers, host: tunnelKey ? endpoint.host : host,
        ...(tunnelKey ? { 'x-p2-cache-host': host, 'x-p2-cache-key': tunnelKey } : {}), ...(body === undefined ? {} : {
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

function configuredCaches(env) {
  const values = env.CACHE_TEST_URLS ? JSON.parse(env.CACHE_TEST_URLS)
    : env.CACHE_TEST_URL ? { cr: env.CACHE_TEST_URL } : {};
  if (!values || Array.isArray(values) || typeof values !== 'object') throw new Error('Invalid cache map');
  return new Map(Object.entries(values).map(([zone, value]) => {
    const url = new URL(value);
    if (!/^[a-z0-9-]{1,20}$/.test(zone) || !['http:', 'https:'].includes(url.protocol)
      || url.username || url.password || url.pathname !== '/' || url.search || url.hash
      || (env.CACHE_TEST_TUNNEL_KEY && url.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(url.hostname))) {
      throw new Error('Invalid cache endpoint');
    }
    return [zone, url];
  }));
}

function createCacheTestRouter({ store = firestoreUrlsStore(), env = process.env } = {}) {
  const router = express.Router();
  router.use(requireAuth({ env }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  const limiter = createLoginLimiter({ max: 5, windowMs: 300000 });
  const send = (context, path, options = {}) => cacheRequest(context.endpoint, context.host, path,
    { ...options, tunnelKey: env.CACHE_TEST_TUNNEL_KEY });

  router.get('/status', (req, res) => {
    try {
      const zones = [...configuredCaches(env).keys()];
      res.json({ enabled: zones.length > 0, zones });
    } catch { res.status(503).json({ error: 'Revisa la configuración de las cachés de prueba.' }); }
  });

  router.use(async (req, res, next) => {
    let endpoints;
    try { endpoints = configuredCaches(env); }
    catch { return res.status(503).json({ error: 'Revisa la configuración de las cachés de prueba.' }); }
    if (!endpoints.size) return res.status(503).json({ error: 'El entorno no tiene una caché de prueba configurada.' });
    const zone = req.body?.zone === undefined ? endpoints.keys().next().value : req.body.zone;
    const endpoint = endpoints.get(zone);
    if (!endpoint) return res.status(400).json({ error: 'Selecciona una zona de caché configurada.' });
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
      req.cacheTest = { endpoint, zone, rule, host: parsed.domain, path,
        cookieName: `p2_zc_${crypto.createHash('sha256').update(req.user.id).digest('hex').slice(0, 16)}_${urlId}_${zone}` };
      next();
    } catch (error) { next(error); }
    return undefined;
  });

  function session(req) {
    const value = cookieValue(String(req.get('cookie') || '').split(/;\s*/), req.cacheTest.cookieName);
    return TOKEN.test(value) ? `zc_session=${value}` : '';
  }
  const cookieOptions = () => ({ httpOnly: true, secure: env.CACHE_TEST_COOKIE_SECURE !== '0',
    sameSite: env.CACHE_TEST_COOKIE_SECURE === '0' ? 'strict' : 'lax', path: '/api/cache-test' });

  router.post('/request', async (req, res) => {
    const { endpoint, host, path } = req.cacheTest;
    const apiKey = req.body.apiKey || '';
    if (typeof apiKey !== 'string' || apiKey.length > 512 || /[\r\n]/.test(apiKey)) {
      return res.status(400).json({ error: 'API key inválida.' });
    }
    try {
      const started = performance.now();
      const result = await send(req.cacheTest, path, { headers: {
        ...(apiKey ? { 'x-api-key': apiKey } : {}), ...(session(req) ? { cookie: session(req) } : {}),
      } });
      return res.json({ status: result.status, elapsedMs: Math.round(performance.now() - started),
        headers: Object.fromEntries(HEADERS.filter((name) => result.headers[name] !== undefined)
          .map((name) => [name, result.headers[name]])), body: result.body, truncated: result.truncated,
        requiresLogin: result.status === 302 && ['/__zc/login', '/cache-login'].includes(new URL(result.headers.location || '/', endpoint).pathname),
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
    const limitKey = `${req.user.id}:${rule.id}:${username}`;
    const retry = limiter.retryAfterSeconds(limitKey);
    if (retry) return res.set('Retry-After', String(retry)).status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });
    try {
      const loginPath = `/__zc/login?return_to=${encodeURIComponent(path)}`;
      const form = await send(req.cacheTest, loginPath);
      let result;
      if (env.CACHE_TEST_LOGIN_MODE === 'ui') {
        if (!env.TICKET_SECRET || env.TICKET_SECRET.length < 32) return res.status(503).json({ error: 'El acceso externo no está configurado.' });
        if (form.status !== 302 || new URL(form.headers.location || '/', endpoint).pathname !== '/cache-login') {
          return res.status(502).json({ error: 'La caché aún no ofrece acceso externo para esta ruta. Revisa la regla y espera el refresco.' });
        }
        const valid = await verifyCredentials({
          getDomain: (domain) => store.getDomain(domain),
          findUrl: async () => rule,
          getUser: (urlId, name) => store.getUser(`${urlId}_${name}`),
        }, require('bcryptjs').compare, { domain: rule.domain, pattern: rule.pattern, username, password });
        if (!valid) {
          limiter.fail(limitKey);
          res.clearCookie(cookieName, cookieOptions());
          return res.json({ authenticated: false, status: 401, message: 'Usuario o contraseña incorrectos.' });
        }
        const ticket = createCacheTicket({ domain: host, pattern: rule.pattern, user: username }, env.TICKET_SECRET);
        const callback = `/__zc/callback?${new URLSearchParams({ ticket, return_to: path })}`;
        if (callback.length > 2000) return res.status(400).json({ error: 'La ruta de retorno es demasiado larga.' });
        result = await send(req.cacheTest, callback);
      } else {
        const csrf = cookieValue(form.headers['set-cookie'], 'zc_csrf');
        if (form.status !== 200 || !TOKEN.test(csrf)) {
          return res.status(502).json({ error: 'La caché no ofrece un formulario local para esta ruta. Revisa el modo de login.' });
        }
        result = await send(req.cacheTest, '/__zc/login', {
          method: 'POST', headers: { cookie: `zc_csrf=${csrf}` },
          body: new URLSearchParams({ csrf, username, password, return_to: path }).toString(),
        });
      }
      const token = cookieValue(result.headers['set-cookie'], 'zc_session');
      const authenticated = result.status === 302 && TOKEN.test(token);
      if (authenticated) limiter.reset(limitKey);
      else if (result.status === 401) limiter.fail(limitKey);
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
      await send(req.cacheTest, '/__zc/logout?return_to=%2F', { headers: { cookie: session(req) } });
      res.clearCookie(cookieName, cookieOptions());
      return res.json({ authenticated: false });
    } catch { return res.status(502).json({ error: 'No se pudo cerrar la sesión en la caché. Intenta de nuevo.' }); }
  });
  return router;
}

module.exports = { createCacheTestRouter };
