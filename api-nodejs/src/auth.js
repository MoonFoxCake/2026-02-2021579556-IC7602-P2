'use strict';

/**
 * Autenticacion de la UI con JWT (HS256).
 *
 *   signToken(user, config)   -> string   firma un token de acceso
 *   requireAuth()             -> middleware Express; deja { id, email } en req.user
 *
 * Variables de entorno (nada quemado en el codigo):
 *   JWT_SECRET      secreto de firma, minimo 32 caracteres (si falta, el API responde 503: falla cerrado)
 *   JWT_EXPIRES_IN  vida del token en segundos (por defecto 3600)
 *
 * Este mecanismo es DISTINTO del SERVICE_KEY: el JWT identifica a una persona usuaria de la UI,
 * el SERVICE_KEY identifica a un componente de la infraestructura (caches e interceptor).
 */

const jwt = require('jsonwebtoken');

const MIN_SECRET_LENGTH = 32;

function getJwtConfig(env = process.env) {
  return {
    secret: env.JWT_SECRET || '',
    expiresIn: Math.max(60, Number(env.JWT_EXPIRES_IN) || 3600),
  };
}

/** null si la configuracion es valida; si no, el mensaje de error. */
function configProblem(cfg) {
  if (!cfg.secret) return 'JWT_SECRET no configurada';
  if (cfg.secret.length < MIN_SECRET_LENGTH) return `JWT_SECRET debe tener al menos ${MIN_SECRET_LENGTH} caracteres`;
  return null;
}

function signToken(user, cfg) {
  return jwt.sign({ email: user.email }, cfg.secret, {
    algorithm: 'HS256',
    subject: user.id,
    expiresIn: cfg.expiresIn,
  });
}

function requireAuth({ env = process.env } = {}) {
  return (req, res, next) => {
    const cfg = getJwtConfig(env);
    const problem = configProblem(cfg);
    if (problem) return res.status(503).json({ error: problem });

    const m = /^Bearer (.+)$/.exec(req.get('authorization') || '');
    if (!m) return res.status(401).json({ error: 'Falta el token (Authorization: Bearer <token>)' });

    try {
      // algorithms fijo: rechaza tokens "alg: none" o firmados con otro algoritmo.
      const payload = jwt.verify(m[1], cfg.secret, { algorithms: ['HS256'] });
      req.user = { id: payload.sub, email: payload.email };
      return next();
    } catch (err) {
      return res.status(401).json({ error: 'Token invalido o expirado' });
    }
  };
}

module.exports = { getJwtConfig, configProblem, signToken, requireAuth };