'use strict';

/**
 * CORS para que la UI (otro origen, en Vercel) pueda llamar al API desde el navegador.
 *
 * CORS_ORIGINS = lista separada por comas de origenes permitidos, p. ej.
 *   CORS_ORIGINS=https://proyecto-redes-2.vercel.app,http://localhost:5173
 * Si no esta definida, no se agregan cabeceras CORS (el navegador solo permite el mismo origen).
 * Nunca se usa "*": solo se responde a origenes de la lista.
 */

function cors({ env = process.env } = {}) {
  return (req, res, next) => {
    const origin = req.get('origin');
    if (origin) res.vary('Origin');

    const allowed = String(env.CORS_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (origin && allowed.includes(origin)) {
      res.set('Access-Control-Allow-Origin', origin);
      res.set('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      res.set('Access-Control-Max-Age', '600');
      if (req.method === 'OPTIONS') return res.sendStatus(204);
    }
    return next();
  };
}

module.exports = { cors };