'use strict';

/**
 * Endpoints que consume la Zonal Cache (Persona 3). Traducen el modelo de Firestore de API.md
 * (domains, urls, apiKeys, urlUsers) al formato que lee la caché (ver ZonalCache/docs/ejemplo-config.json).
 *
 *   GET  /api/cache/config?zone=cr       -> { domains: [...] }   (solo dominios verificados por TXT; si un dominio
 *                                           define "zones", solo se entrega a las cachés de esas zonas)
 *   POST /api/cache/verify-credentials   -> { valid } 200 | 401  (usuario/contraseña de una URL)
 *
 * Autenticación de servicio: "Authorization: Bearer <secreto>" o "x-service-key: <secreto>", comparada en
 * tiempo constante con la variable de entorno SERVICE_KEY (o CACHE_API_TOKEN). Sin variable => 503 (falla cerrado).
 * Las contraseñas se comparan con bcrypt (npm i bcryptjs). Nada se guarda ni se devuelve en claro.
 */

const crypto = require('crypto');
const express = require('express');

const MIB = 1024 * 1024;
const POLICIES = new Set(['LRU', 'LFU', 'FIFO', 'MRU', 'RANDOM']);
const AUTH_MODES = new Set(['none', 'apikey', 'userpass']);
// Hash bcrypt de relleno: se compara igual cuando el usuario no existe, para no revelarlo por tiempo de respuesta.
const DUMMY_HASH = '$2a$10$5wDE.EunI9wtGWlm5iJLNuBxrKEO0rlAa58yzAP9uLGC6Kk8GBa02';

function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Convierte documentos de Firestore al JSON de configuración de la caché. Función pura (fácil de probar). */
function buildCacheConfig({ domains, urls, apiKeys, zone }) {
  const z = zone ? String(zone).toLowerCase() : '';
  const keysByUrl = new Map();
  for (const k of apiKeys || []) {
    if (!k || !k.urlId || typeof k.keyHash !== 'string') continue;
    if (!keysByUrl.has(k.urlId)) keysByUrl.set(k.urlId, []);
    keysByUrl.get(k.urlId).push(k.keyHash.toLowerCase());
  }

  const out = [];
  for (const d of domains || []) {
    if (!d || !d.domain || d.verified !== true) continue; // solo dominios verificados
    // Zonas: por defecto TODAS las cachés sirven todos los dominios (un cliente de CR y uno de US pueden pedir el
    // mismo sitio). Si el dominio trae "zones" (opcional), solo se entrega a las cachés de esas zonas.
    if (z && Array.isArray(d.zones) && d.zones.length && !d.zones.map((x) => String(x).toLowerCase()).includes(z)) continue;
    const domainUrls = (urls || []).filter((u) => u && u.domain === d.domain && u.pattern);

    const rules = domainUrls.map((u) => {
      // Falla cerrado: un authType desconocido NO deja la URL abierta (queda como apikey sin llaves).
      const known = AUTH_MODES.has(u.authType);
      const mode = known ? u.authType : 'apikey';
      const policy = POLICIES.has(String(u.replacementPolicy).toUpperCase())
        ? String(u.replacementPolicy).toUpperCase()
        : 'LRU';
      const rule = {
        pattern: u.pattern,
        cacheBytes: Math.max(0, Math.round(Number(u.cacheSizeMB) || 0) * MIB),
        auth: { mode },
        fileTypes: (u.fileTypes || [])
          .filter((f) => f && f.ext)
          .map((f) => ({ ext: String(f.ext).replace(/^\./, '').toLowerCase(), ttl: Math.max(0, Number(f.ttlSeconds) || 0), policy })),
      };
      if (u.origin) rule.origin = u.origin;
      if (mode === 'apikey') rule.auth.apiKeyHashes = known ? keysByUrl.get(u.id) || [] : [];
      return rule;
    });

    const root = domainUrls.find((u) => u.pattern === '/*' && u.origin);
    out.push({
      domain: d.domain,
      ...(root ? { origin: root.origin } : {}),
      // La UI define el tamaño por URL; el límite del dominio es la suma de sus URLs.
      maxCacheBytes: rules.reduce((s, r) => s + r.cacheBytes, 0),
      urls: rules,
    });
  }
  return { domains: out };
}

/** true si las credenciales son válidas para ese dominio+patrón (URL con authType "userpass"). */
async function verifyCredentials(store, compare, { domain, pattern, username, password }) {
  const d = await store.getDomain(domain);
  const u = d && d.verified === true ? await store.findUrl(domain, pattern) : null;
  const eligible = u && u.authType === 'userpass';
  const user = eligible ? await store.getUser(u.id, username) : null;
  const ok = await compare(String(password), user && user.passwordHash ? user.passwordHash : DUMMY_HASH);
  return Boolean(eligible && user && ok);
}

/** Almacén sobre Firestore (colecciones de API.md). Se carga la conexión solo al primer uso. */
function firestoreStore() {
  const db = () => require('./firebase').db;
  const rows = async (q) => (await q.get()).docs.map((x) => ({ id: x.id, ...x.data() }));
  return {
    listDomains: async () => (await rows(db().collection('domains').where('verified', '==', true))).map((d) => ({ ...d, domain: d.id })),
    listUrls: () => rows(db().collection('urls')),
    listApiKeys: () => rows(db().collection('apiKeys')),
    getDomain: async (domain) => {
      const s = await db().collection('domains').doc(String(domain).toLowerCase()).get();
      return s.exists ? { id: s.id, domain: s.id, ...s.data() } : null;
    },
    findUrl: async (domain, pattern) => {
      const r = await rows(db().collection('urls').where('domain', '==', String(domain).toLowerCase()).where('pattern', '==', pattern).limit(1));
      return r[0] || null;
    },
    getUser: async (urlId, username) => {
      const s = await db().collection('urlUsers').doc(`${urlId}_${username}`).get();
      return s.exists ? s.data() : null;
    },
  };
}

function createCacheRouter({ store = firestoreStore(), compare, serviceKey } = {}) {
  const cmp = compare || ((pw, hash) => require('bcryptjs').compare(pw, hash));
  const router = express.Router();

  router.use((req, res, next) => {
    const secret = serviceKey !== undefined ? serviceKey : process.env.SERVICE_KEY || process.env.CACHE_API_TOKEN;
    if (!secret) return res.status(503).json({ error: 'SERVICE_KEY no configurada' });
    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    const given = m ? m[1] : req.get('x-service-key') || '';
    if (!given || !safeEqual(given, secret)) return res.status(401).json({ error: 'no autorizado' });
    next();
  });

  router.get('/config', async (req, res, next) => {
    try {
      const [domains, urls, apiKeys] = await Promise.all([store.listDomains(), store.listUrls(), store.listApiKeys()]);
      res.set('Cache-Control', 'no-store').json(buildCacheConfig({ domains, urls, apiKeys, zone: req.query.zone }));
    } catch (e) { next(e); }
  });

  router.post('/verify-credentials', express.json({ limit: '4kb' }), async (req, res, next) => {
    try {
      const { domain, pattern, username, password } = req.body || {};
      if ([domain, pattern, username, password].some((v) => typeof v !== 'string' || !v)) {
        return res.status(400).json({ error: 'domain, pattern, username y password son obligatorios' });
      }
      const valid = await verifyCredentials(store, cmp, { domain: domain.toLowerCase(), pattern, username, password });
      res.status(valid ? 200 : 401).json({ valid });
    } catch (e) { next(e); }
  });

  return router;
}

module.exports = { createCacheRouter, buildCacheConfig, verifyCredentials, firestoreStore };
