'use strict';

/**
 * Cuenta de la persona usuaria (la usa la UI).
 *
 *   POST /api/auth/register   { email, password }  -> 201 { id, email }
 *   POST /api/auth/login      { email, password }  -> 200 { token, expiresIn }
 *   GET  /api/auth/me         (Bearer JWT)         -> 200 { id, email }
 *
 * - Contrasenas con bcrypt (bcryptjs); nunca se guardan ni se devuelven en claro.
 * - El ID del documento en "users" es el SHA-256 del correo en minusculas: asi un correo solo puede
 *   registrarse una vez (create() es atomico) y el ID no depende de caracteres especiales del correo.
 * - Login con mensaje generico y comparacion bcrypt tambien cuando el usuario no existe, para no revelar
 *   si un correo esta registrado por el mensaje ni por el tiempo de respuesta.
 * - Limite de intentos fallidos por correo+IP (en memoria; ver README: en serverless es por instancia).
 *
 * Variables de entorno: BCRYPT_ROUNDS (por defecto 10), LOGIN_MAX_ATTEMPTS (5), LOGIN_WINDOW_SECONDS (900)
 * y las de src/auth.js (JWT_SECRET, JWT_EXPIRES_IN).
 */

const crypto = require('crypto');
const express = require('express');
const { getJwtConfig, configProblem, signToken, requireAuth } = require('./auth');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;
const MAX_PASSWORD_BYTES = 72; // limite real de bcrypt

function normalizeEmail(email) {
  if (typeof email !== 'string') return null;
  const e = email.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

function userIdFor(email) {
  return crypto.createHash('sha256').update(email).digest('hex');
}

function validPassword(pw) {
  return typeof pw === 'string' && pw.length >= MIN_PASSWORD && Buffer.byteLength(pw) <= MAX_PASSWORD_BYTES;
}

/** Contador de intentos fallidos en memoria: { retryAfterSeconds(key), fail(key), reset(key) }. */
function createLoginLimiter({ max = 5, windowMs = 15 * 60 * 1000 } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  const live = (key) => {
    const h = hits.get(key);
    if (h && h.resetAt <= Date.now()) { hits.delete(key); return null; }
    return h || null;
  };
  return {
    retryAfterSeconds(key) {
      const h = live(key);
      return h && h.count >= max ? Math.ceil((h.resetAt - Date.now()) / 1000) : 0;
    },
    fail(key) {
      if (hits.size > 10000) hits.clear(); // evita crecer sin limite
      const h = live(key) || { count: 0, resetAt: Date.now() + windowMs };
      h.count += 1;
      hits.set(key, h);
    },
    reset(key) { hits.delete(key); },
  };
}

/** Almacen sobre Firestore (coleccion "users"). La conexion se carga solo al primer uso. */
function firestoreUsersStore() {
  const col = () => require('./firebase').db.collection('users');
  return {
    // true si se creo; false si ya existia (create() falla con ALREADY_EXISTS, codigo gRPC 6).
    async create(id, data) {
      try {
        await col().doc(id).create(data);
        return true;
      } catch (err) {
        if (err && (err.code === 6 || /ALREADY_EXISTS/.test(String(err.message)))) return false;
        throw err;
      }
    },
    async get(id) {
      const s = await col().doc(id).get();
      return s.exists ? { id: s.id, ...s.data() } : null;
    },
  };
}

function createAuthRouter({ store = firestoreUsersStore(), env = process.env, limiter } = {}) {
  const router = express.Router();
  const bcrypt = () => require('bcryptjs');
  const rounds = () => Math.min(14, Math.max(4, Number(env.BCRYPT_ROUNDS) || 10));
  const loginLimiter = limiter || createLoginLimiter({
    max: Number(env.LOGIN_MAX_ATTEMPTS) || 5,
    windowMs: (Number(env.LOGIN_WINDOW_SECONDS) || 900) * 1000,
  });

  let dummyHash; // hash de relleno, se crea una vez
  const getDummyHash = () => {
    if (!dummyHash) dummyHash = bcrypt().hashSync(crypto.randomBytes(16).toString('hex'), rounds());
    return dummyHash;
  };

  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  router.post('/register', async (req, res, next) => {
    try {
      const { email, password } = req.body || {};
      const e = normalizeEmail(email);
      if (!e) return res.status(400).json({ error: 'El correo no es valido' });
      if (!validPassword(password)) {
        return res.status(400).json({ error: `La contrasena debe tener entre ${MIN_PASSWORD} y ${MAX_PASSWORD_BYTES} caracteres` });
      }
      const id = userIdFor(e);
      const passwordHash = await bcrypt().hash(password, rounds());
      const created = await store.create(id, { email: e, passwordHash, createdAt: new Date().toISOString() });
      if (!created) return res.status(409).json({ error: 'Ese correo ya esta registrado' });
      return res.status(201).json({ id, email: e });
    } catch (err) { return next(err); }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const problem = configProblem(getJwtConfig(env));
      if (problem) return res.status(503).json({ error: problem });

      const { email, password } = req.body || {};
      const e = normalizeEmail(email);
      if (!e || typeof password !== 'string' || !password) {
        return res.status(400).json({ error: 'correo y contrasena son obligatorios' });
      }

      const key = `${req.ip}|${e}`;
      const wait = loginLimiter.retryAfterSeconds(key);
      if (wait > 0) {
        res.set('Retry-After', String(wait));
        return res.status(429).json({ error: 'Demasiados intentos fallidos. Intenta mas tarde.' });
      }

      const user = await store.get(userIdFor(e));
      const ok = await bcrypt().compare(password, user && user.passwordHash ? user.passwordHash : getDummyHash());
      if (!user || !ok) {
        loginLimiter.fail(key);
        return res.status(401).json({ error: 'Credenciales invalidas' });
      }

      loginLimiter.reset(key);
      const cfg = getJwtConfig(env);
      return res.json({ token: signToken({ id: user.id, email: user.email }, cfg), expiresIn: cfg.expiresIn });
    } catch (err) { return next(err); }
  });

  router.get('/me', requireAuth({ env }), (req, res) => {
    res.json({ id: req.user.id, email: req.user.email });
  });

  return router;
}

module.exports = { createAuthRouter, createLoginLimiter, normalizeEmail, userIdFor, firestoreUsersStore };