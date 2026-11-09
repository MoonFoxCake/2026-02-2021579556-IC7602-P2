'use strict';

/**
 * Endpoint que consume el DNS Interceptor (dns.c) para elegir la CACHÉ ZONAL de cada cliente.
 *
 *   GET /api/records/:hostname?sourceIp=<ip del cliente>
 *
 * - Si el dominio (o un comodín "*.padre") está registrado y VERIFICADO por TXT, responde un record "geo"
 *   cuyos targets son las cachés zonales. dns.c ya sabe elegir el target cuyo "country" coincide con
 *   client.countryCode, así que no hay que cambiar el interceptor.
 * - Si no está registrado: 404 -> el interceptor reenvía la consulta al resolver normal.
 *
 * Todo sale de variables de entorno (nada quemado):
 *   ZONE_CACHES        "cr=10.0.0.11,us=10.0.0.12"          zona -> IP pública (LoadBalancer) de su caché
 *   COUNTRY_ZONES      "CR=cr,PA=cr,NI=cr,*=us"             país (ISO-2) -> zona; "*" = zona por defecto
 *   ipToCountry (Realtime Database) usa los rangos numéricos inclusivos del P1.
 *   DNS_RECORD_TTL     60                                   TTL de la respuesta A
 * País desconocido: COUNTRY_ZONES['*']. Un fallo de la base responde 503.
 */

const express = require('express');
const { countryForIp } = require('./ip-country');

function parsePairs(s, { upperKey = false, lowerVal = false } = {}) {
  const out = new Map();
  for (const part of String(s || '').split(',')) {
    const i = part.indexOf('=');
    if (i <= 0) continue;
    let k = part.slice(0, i).trim();
    let v = part.slice(i + 1).trim();
    if (!k || !v) continue;
    if (upperKey) k = k.toUpperCase();
    if (lowerVal) v = v.toLowerCase();
    out.set(k, v);
  }
  return out;
}

function loadDnsOptions(env = process.env) {
  return {
    caches: parsePairs(env.ZONE_CACHES, { lowerVal: false }),           // zona -> IP
    countryZones: parsePairs(env.COUNTRY_ZONES, { upperKey: true, lowerVal: true }),
    ttl: Math.max(1, Number(env.DNS_RECORD_TTL) || 60),
  };
}

/** Busca el dominio verificado: exacto y luego comodines "*.padre" (de más específico a menos). */
async function findVerifiedDomain(store, hostname) {
  const h = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (!h || h.length > 253) return null;
  const candidates = [h];
  const labels = h.split('.');
  for (let i = 1; i < labels.length - 1; i++) candidates.push(`*.${labels.slice(i).join('.')}`);
  for (const c of candidates) {
    const d = await store.getDomain(c);
    if (d && d.verified === true) return d;
  }
  return null;
}

/** Arma la respuesta "geo" que entiende dns.c. Función pura (fácil de probar). */
function buildGeoRecord({ domain, hostname, sourceIp, country, opts }) {
  // Si el dominio limita sus zonas (campo opcional "zones" en Firestore), solo esas cachés.
  const allowed = Array.isArray(domain.zones) && domain.zones.length ? new Set(domain.zones.map((z) => String(z).toLowerCase())) : null;
  const targets = [...opts.caches]
    .filter(([zone]) => !allowed || allowed.has(zone.toLowerCase()))
    .map(([zone, address]) => ({ id: zone, address, healthy: true, country: zone.toUpperCase() }));
  let zone = (country && opts.countryZones.get(country)) || opts.countryZones.get('*') || null;
  if (zone && !targets.some((t) => t.id.toLowerCase() === zone)) zone = null;     // zona sin caché disponible
  if (!zone && targets.length) zone = targets[0].id.toLowerCase();                 // determinista: la primera
  return {
    found: true,
    hostname,
    recordId: domain.domain || domain.id,
    type: 'geo',
    ttl: opts.ttl,
    attribution: 'IP Geolocation by DB-IP (https://db-ip.com), CC BY 4.0',
    client: { ip: sourceIp || null, country: country || null, countryCode: zone ? zone.toUpperCase() : null },
    targets,
  };
}

function createDnsRouter({ store, env = process.env, lookupCountry = countryForIp } = {}) {
  const router = express.Router();
  router.get('/records/:hostname', async (req, res, next) => {
    try {
      const opts = loadDnsOptions(env);
      const hostname = String(req.params.hostname).toLowerCase().replace(/\.$/, '');
      const domain = await findVerifiedDomain(store, hostname);
      if (!domain) return res.status(404).json({ found: false, hostname });
      if (opts.caches.size === 0) return res.status(503).json({ error: 'ZONE_CACHES no configurada' });
      const sourceIp = typeof req.query.sourceIp === 'string' ? req.query.sourceIp : '';
      let country;
      try { country = await lookupCountry(sourceIp); }
      catch { return res.status(503).json({ error: 'IP-to-Country no disponible' }); }
      const rec = buildGeoRecord({ domain, hostname, sourceIp, country, opts });
      if (!rec.targets.length) return res.status(503).json({ error: 'el dominio no tiene cachés en ninguna zona configurada' });
      res.set('Cache-Control', 'no-store').json(rec);
    } catch (e) { next(e); }
  });
  return router;
}

module.exports = { createDnsRouter, buildGeoRecord, findVerifiedDomain, loadDnsOptions };
