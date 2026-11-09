'use strict';

const crypto = require('crypto');
const express = require('express');
const { verifyCredentials } = require('./cache-routes');
const { findVerifiedDomain } = require('./dns-routes');
const { createLoginLimiter } = require('./auth-routes');

function loginContext(body, env) {
  const { domain, pattern, callback, returnTo } = body;
  if (typeof domain !== 'string' || domain.length > 253
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(domain)
    || typeof pattern !== 'string' || !pattern.startsWith('/') || pattern.length > 200
    || typeof callback !== 'string' || callback.length > 2048
    || typeof returnTo !== 'string' || returnTo.length > 2048) return null;
  try {
    const url = new URL(callback);
    const decoded = decodeURIComponent(returnTo);
    if ((url.protocol !== 'https:' && !(env.CACHE_LOGIN_ALLOW_HTTP === '1' && url.protocol === 'http:'))
      || url.hostname !== domain || url.port || url.username || url.password
      || url.pathname !== '/__zc/callback' || url.search || url.hash
      || !decoded.startsWith('/') || decoded.startsWith('//') || /[\\\x00-\x20\x7f]/.test(decoded)) return null;
    return { domain, pattern, callback: url, returnTo };
  } catch { return null; }
}

function createCacheLoginRouter({ store, env = process.env, compare = require('bcryptjs').compare,
  limiter = createLoginLimiter({ max: 5, windowMs: 300000 }) } = {}) {
  const router = express.Router();
  router.post('/', async (req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
    const context = loginContext(req.body || {}, env);
    const { username, password } = req.body || {};
    if (!context || typeof username !== 'string' || !/^[A-Za-z0-9._-]{1,64}$/.test(username)
      || typeof password !== 'string' || !password || Buffer.byteLength(password) > 72) {
      return res.status(400).json({ error: 'Solicitud de acceso no válida. Regresa al recurso e inténtalo de nuevo.' });
    }
    if (typeof env.TICKET_SECRET !== 'string' || env.TICKET_SECRET.length < 32) {
      return res.status(503).json({ error: 'El acceso externo no está configurado.' });
    }
    const key = `${req.ip}:${context.domain}:${username}`;
    const retry = limiter.retryAfterSeconds(key);
    if (retry) return res.set('Retry-After', String(retry)).status(429).json({ error: 'Demasiados intentos. Inténtalo más tarde.' });
    try {
      const domain = await findVerifiedDomain(store, context.domain);
      const valid = await verifyCredentials(store, compare, {
        domain: domain?.domain || domain?.id || context.domain,
        pattern: context.pattern, username, password,
      });
      if (!valid) {
        limiter.fail(key);
        return res.status(401).json({ error: 'Usuario o contraseña incorrectos para este recurso.' });
      }
      limiter.reset(key);
      // Matches ZonalCache/p3/zc_auth.c: base64url JSON + hex HMAC-SHA256.
      const payload = Buffer.from(JSON.stringify({ domain: context.domain, pattern: context.pattern,
        user: username, exp: Math.floor(Date.now() / 1000) + 60, nonce: crypto.randomBytes(32).toString('hex') })).toString('base64url');
      const ticket = `${payload}.${crypto.createHmac('sha256', env.TICKET_SECRET).update(payload).digest('hex')}`;
      context.callback.searchParams.set('ticket', ticket);
      context.callback.searchParams.set('return_to', context.returnTo);
      // shortcut: C accepts at most 2000 target bytes; use a shorter return query until that transport limit changes.
      if (context.callback.pathname.length + context.callback.search.length > 2000) return res.status(400).json({ error: 'La ruta de retorno es demasiado larga.' });
      res.json({ redirectUrl: context.callback.toString() });
    } catch (err) { next(err); }
  });
  return router;
}

module.exports = { createCacheLoginRouter, loginContext };
