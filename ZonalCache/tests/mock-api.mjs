// mock-api.mjs — imitación MÍNIMA del API Node.js (Persona 4) y del formulario del UI (Persona 5),
// solo para probar la Zonal Cache sin depender de Vercel/Firebase. Sin dependencias: `node tests/mock-api.mjs`.
//
// También funciona como CONTRATO EJECUTABLE: lo que este archivo responde es exactamente lo que la caché
// espera del API real. Variables: MOCK_PORT (9900), MOCK_TOKEN, MOCK_TICKET_SECRET.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.MOCK_PORT || 9900);
const TOKEN = process.env.MOCK_TOKEN || 'token-de-la-cache';
const TICKET_SECRET = process.env.MOCK_TICKET_SECRET || 'secreto-compartido-de-pruebas-0123456789';
const ORIGIN = process.env.MOCK_ORIGIN || 'http://origen-de-prueba:8080';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

// En Firestore la API key NUNCA se guarda en claro: solo su SHA-256. Aquí se calcula al arrancar.
const API_KEYS = ['clave-demo'];
// Usuarios por dominio+URL. En el API real: hash bcrypt/argon2 en Firestore.
const USERS = { 'ejemplo.com|/privado/*': { kevin: 's3creto' } };

const config = {
  domains: [{
    domain: 'ejemplo.com',
    origin: ORIGIN,
    maxCacheBytes: 2000,
    urls: [
      { pattern: '/*', auth: { mode: 'none' },
        fileTypes: [{ ext: 'html', ttl: 60, policy: 'LRU' }, { ext: '*', ttl: 30, policy: 'FIFO' }] },
      { pattern: '/api/*', auth: { mode: 'apikey', apiKeyHashes: API_KEYS.map(sha256) },
        fileTypes: [{ ext: '*', ttl: 20, policy: 'MRU' }] },
      { pattern: '/privado/*', cacheBytes: 600, auth: { mode: 'userpass' },
        fileTypes: [{ ext: '*', ttl: 120, policy: 'LFU' }] },
    ],
  }],
};

// Ticket = base64url(JSON) + "." + hex(HMAC-SHA256(secreto, base64url(JSON)))  — idéntico a zc_ticket_make
function makeTicket({ domain, pattern, user, ttlSecs = 60 }) {
  const payload = { domain, pattern, user, exp: Math.floor(Date.now() / 1000) + ttlSecs,
                    nonce: crypto.randomBytes(32).toString('hex') };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const mac = crypto.createHmac('sha256', TICKET_SECRET).update(b64).digest('hex');
  return `${b64}.${mac}`;
}

const bearerOk = (req) => {
  const got = Buffer.from(req.headers.authorization || '');
  const want = Buffer.from(`Bearer ${TOKEN}`);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
};
const readBody = (req) => new Promise((ok) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => ok(b)); });
const send = (res, code, obj, headers = {}) => {
  res.writeHead(code, { 'Content-Type': 'application/json', ...headers });
  res.end(obj === undefined ? '' : JSON.stringify(obj));
};

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // 1) Config para las cachés: GET /api/cache/config?zone=cr   (Authorization: Bearer <token de la caché>)
  if (req.method === 'GET' && url.pathname === '/api/cache/config') {
    if (!bearerOk(req)) return send(res, 401, { error: 'token inválido' });
    return send(res, 200, config);
  }

  // 2) Verificación de credenciales (modo local): POST /api/cache/verify-credentials
  if (req.method === 'POST' && url.pathname === '/api/cache/verify-credentials') {
    if (!bearerOk(req)) return send(res, 401, { error: 'token inválido' });
    let b; try { b = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'json' }); }
    const users = USERS[`${b.domain}|${b.pattern}`] || {};
    return users[b.username] && users[b.username] === b.password ? send(res, 200, { ok: true }) : send(res, 401, { ok: false });
  }

  // 3) Formulario de login del UI (modo ui). En el UI real es una página React; aquí, para curl,
  //    se aceptan ?user=&pass= directamente. Responde 302 al callback de la caché con el ticket.
  if (req.method === 'GET' && url.pathname === '/cache-login') {
    const q = Object.fromEntries(url.searchParams);
    // SEGURIDAD: el callback debe pertenecer al MISMO dominio pedido, si no se le regala el ticket a otro sitio.
    let cb;
    try { cb = new URL(q.callback); } catch { return send(res, 400, { error: 'callback inválido' }); }
    if (cb.hostname.toLowerCase() !== String(q.domain).toLowerCase() || cb.pathname !== '/__zc/callback')
      return send(res, 400, { error: 'callback no corresponde al dominio' });
    if (!q.user) return send(res, 200, { formulario: 'aquí iría la página de login del UI', ...q });
    const users = USERS[`${q.domain}|${q.pattern}`] || {};
    if (users[q.user] !== q.pass) return send(res, 401, { error: 'credenciales inválidas' });
    const ticket = makeTicket({ domain: q.domain, pattern: q.pattern, user: q.user });
    cb.searchParams.set('ticket', ticket);
    cb.searchParams.set('return_to', q.return_to || '/');
    res.writeHead(302, { Location: cb.toString() }); return res.end();
  }

  send(res, 404, { error: 'no existe' });
}).listen(PORT, () => console.log(`mock-api en http://127.0.0.1:${PORT}`));
