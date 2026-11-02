'use strict';

/**
 * Dominios de la persona usuaria (los usa la UI). Todas las rutas exigen "Authorization: Bearer <JWT>".
 *
 *   GET    /api/domains                  -> 200 { domains: [...] }   solo los dominios de quien consulta
 *   POST   /api/domains                  { domain } -> 201            registra el dominio y devuelve el TXT a crear
 *   GET    /api/domains/:domain          -> 200 { domain, verified, txt? }
 *   POST   /api/domains/:domain/verify   -> 200 { verified }          consulta el DNS y busca el TXT
 *   DELETE /api/domains/:domain          -> 200 { deleted: true }     borra el dominio y sus URLs, claves y usuarios
 *
 * Verificacion de propiedad (requisito del enunciado): la persona crea un registro TXT
 *     <DOMAIN_TXT_LABEL>.<dominio>  =  <DOMAIN_TXT_PREFIX>=<txtToken>
 * (por defecto  _p2redes.ejemplo.com  =  p2redes-verify=<token>). Solo cuando el DNS devuelve ese valor
 * se marca verified=true, y recien entonces el dominio aparece en /api/cache/config y /api/records.
 *
 * - El ID del documento en "domains" es el nombre en minusculas: un dominio solo se puede registrar una vez.
 * - Autorizacion por propiedad: quien no es duenio recibe 404 (no se revela si el dominio existe).
 * - Se aceptan comodines "*.ejemplo.com" (lo que lee dns-routes.js); su TXT va en el dominio base.
 *
 * Variables de entorno (opcionales): DOMAIN_TXT_LABEL, DOMAIN_TXT_PREFIX, TXT_RESOLVERS ("8.8.8.8,1.1.1.1"),
 * TXT_TIMEOUT_MS.
 */

const crypto = require('crypto');
const dns = require('dns');
const express = require('express');
const { requireAuth } = require('./auth');

const LABEL_RE = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;
// Errores de DNS que significan "ese registro no existe" (no "el DNS fallo").
const NOT_FOUND_CODES = new Set(['ENODATA', 'ENOTFOUND', 'NXDOMAIN']);

/** "Ejemplo.com." -> { domain, base, wildcard }; null si no es un dominio valido. */
function normalizeDomain(input) {
  if (typeof input !== 'string') return null;
  const domain = input.trim().toLowerCase().replace(/\.$/, '');
  const wildcard = domain.startsWith('*.');
  const base = wildcard ? domain.slice(2) : domain;
  if (!base || base.length > 253) return null;
  const labels = base.split('.');
  if (labels.length < 2 || !labels.every((l) => LABEL_RE.test(l))) return null;
  if (/^\d+$/.test(labels[labels.length - 1])) return null; // evita direcciones IP
  return { domain, base, wildcard };
}

const baseOf = (id) => (id.startsWith('*.') ? id.slice(2) : id);

function txtFor(doc, env) {
  const label = env.DOMAIN_TXT_LABEL || '_p2redes';
  const prefix = env.DOMAIN_TXT_PREFIX || 'p2redes-verify';
  return { type: 'TXT', name: `${label}.${baseOf(doc.id)}`, value: `${prefix}=${doc.txtToken}` };
}

function view(doc, env) {
  const verified = doc.verified === true;
  return {
    domain: doc.id,
    verified,
    verifiedAt: doc.verifiedAt || null,
    createdAt: doc.createdAt || null,
    ...(verified ? {} : { txt: txtFor(doc, env) }),
  };
}

/** Consulta TXT real. Devuelve string[][] (cada registro puede venir en trozos). */
function defaultResolveTxt(env) {
  return async (name) => {
    const resolver = new dns.promises.Resolver({ timeout: Number(env.TXT_TIMEOUT_MS) || 4000, tries: 2 });
    const servers = String(env.TXT_RESOLVERS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (servers.length) resolver.setServers(servers);
    return resolver.resolveTxt(name);
  };
}

/** Almacen sobre Firestore (coleccion "domains"). La conexion se carga solo al primer uso. */
function firestoreDomainsStore() {
  const db = () => require('./firebase').db;
  const col = () => db().collection('domains');
  return {
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
    async listByOwner(ownerId) {
      const snap = await col().where('ownerId', '==', ownerId).get();
      return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    },
    async update(id, fields) {
      await col().doc(id).update(fields);
    },
    // Borra las URLs del dominio, sus API keys y usuarios, y por ultimo el dominio (en lotes de 400).
    async deleteCascade(id) {
      const d = db();
      const refs = [];
      const urls = await d.collection('urls').where('domain', '==', id).get();
      for (const u of urls.docs) {
        refs.push(u.ref);
        for (const name of ['apiKeys', 'urlUsers']) {
          // eslint-disable-next-line no-await-in-loop
          const snap = await d.collection(name).where('urlId', '==', u.id).get();
          snap.docs.forEach((x) => refs.push(x.ref));
        }
      }
      refs.push(col().doc(id));
      for (let i = 0; i < refs.length; i += 400) {
        const batch = d.batch();
        refs.slice(i, i + 400).forEach((r) => batch.delete(r));
        // eslint-disable-next-line no-await-in-loop
        await batch.commit();
      }
    },
  };
}

function createDomainsRouter({ store = firestoreDomainsStore(), env = process.env, resolveTxt } = {}) {
  const router = express.Router();
  const lookup = resolveTxt || defaultResolveTxt(env);

  router.use(requireAuth({ env }));
  router.use((req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

  /** Carga el dominio del parametro si existe y es de quien consulta; si no, responde y devuelve null. */
  async function loadOwned(req, res) {
    const parsed = normalizeDomain(req.params.domain);
    if (!parsed) { res.status(400).json({ error: 'El dominio no es valido' }); return null; }
    const doc = await store.get(parsed.domain);
    if (!doc || doc.ownerId !== req.user.id) { res.status(404).json({ error: 'Dominio no encontrado' }); return null; }
    return doc;
  }

  router.get('/', async (req, res, next) => {
    try {
      const docs = await store.listByOwner(req.user.id);
      docs.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
      res.json({ domains: docs.map((d) => view(d, env)) });
    } catch (err) { next(err); }
  });

  router.post('/', async (req, res, next) => {
    try {
      const parsed = normalizeDomain(req.body && req.body.domain);
      if (!parsed) return res.status(400).json({ error: 'El dominio no es valido (ejemplo: ejemplo.com o *.ejemplo.com)' });

      const data = {
        ownerId: req.user.id,
        txtToken: crypto.randomBytes(16).toString('hex'),
        verified: false,
        createdAt: new Date().toISOString(),
      };
      const created = await store.create(parsed.domain, data);
      if (!created) return res.status(409).json({ error: 'Ese dominio ya esta registrado' });

      const body = view({ id: parsed.domain, ...data }, env);
      body.instructions = `Crea un registro TXT llamado ${body.txt.name} con el valor ${body.txt.value} y luego pide la verificacion (POST /api/domains/${parsed.domain}/verify).`;
      return res.status(201).json(body);
    } catch (err) { return next(err); }
  });

  router.get('/:domain', async (req, res, next) => {
    try {
      const doc = await loadOwned(req, res);
      if (doc) res.json(view(doc, env));
    } catch (err) { next(err); }
  });

  router.post('/:domain/verify', async (req, res, next) => {
    try {
      const doc = await loadOwned(req, res);
      if (!doc) return undefined;
      if (doc.verified === true) return res.json({ domain: doc.id, verified: true, verifiedAt: doc.verifiedAt || null });

      const txt = txtFor(doc, env);
      let records;
      try {
        records = await lookup(txt.name);
      } catch (err) {
        if (err && NOT_FOUND_CODES.has(err.code)) records = [];
        else return res.status(502).json({ error: 'No se pudo consultar el DNS. Intenta de nuevo en unos minutos.' });
      }

      const found = records.some((chunks) => (Array.isArray(chunks) ? chunks.join('') : String(chunks)).trim() === txt.value);
      if (!found) {
        return res.json({
          domain: doc.id,
          verified: false,
          message: 'No se encontro el registro TXT esperado. Los cambios de DNS pueden tardar en propagarse.',
          txt,
        });
      }

      const verifiedAt = new Date().toISOString();
      await store.update(doc.id, { verified: true, verifiedAt });
      return res.json({ domain: doc.id, verified: true, verifiedAt });
    } catch (err) { return next(err); }
  });

  router.delete('/:domain', async (req, res, next) => {
    try {
      const doc = await loadOwned(req, res);
      if (!doc) return;
      await store.deleteCascade(doc.id);
      res.json({ deleted: true, domain: doc.id });
    } catch (err) { next(err); }
  });

  return router;
}

module.exports = { createDomainsRouter, normalizeDomain, txtFor, firestoreDomainsStore };