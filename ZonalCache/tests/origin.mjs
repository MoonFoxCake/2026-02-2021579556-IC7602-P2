// origin.mjs — ORIGEN de prueba para la Zonal Cache (hace el papel del REST API / Apache / sitio externo).
// Sin dependencias: `node tests/origin.mjs`. Solo se usa en las pruebas automáticas (make e2e*).
//
// Variables: ORIGIN_PORT (9800), ORIGIN_NAME ("web"), ORIGIN_TLS_CERT / ORIGIN_TLS_KEY (si se dan, sirve HTTPS).
//
//   GET  /<cualquier>.<ext>      contenido según extensión (html, json, png, css, js, txt); cuenta las visitas
//   GET  /fixed/<n>?size=N       cuerpo de exactamente N bytes (pruebas de políticas de reemplazo)
//   GET  /echo/headers           devuelve en JSON los encabezados que le llegaron (¿se filtró x-api-key?)
//   GET  /redirect               302 con Location ABSOLUTA al propio origen (la caché debe volverla relativa)
//   GET  /gzip.txt               responde comprimido con gzip si el cliente lo acepta
//   GET  /status/<code>          responde ese código
//   GET  /stats                  visitas por ruta (para saber si la caché fue al origen o no)
//   POST|PUT|PATCH|DELETE /*     eco JSON del método y el cuerpo (nunca se cachea)
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import zlib from 'node:zlib';

const PORT = Number(process.env.ORIGIN_PORT || 9800);
const NAME = process.env.ORIGIN_NAME || 'web';
const CERT = process.env.ORIGIN_TLS_CERT;
const KEY = process.env.ORIGIN_TLS_KEY;
const hits = {};

const TYPES = { html: 'text/html; charset=utf-8', json: 'application/json', css: 'text/css', js: 'text/javascript',
  txt: 'text/plain; charset=utf-8', png: 'image/png' };
// PNG 1x1 real (para comprobar que los binarios llegan intactos desde disco).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function body(req) {
  return new Promise((ok) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); });
}

async function handler(req, res) {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;
  hits[p] = (hits[p] || 0) + 1;
  res.setHeader('X-Origin', NAME);
  res.setHeader('X-Origin-Hits', String(hits[p]));

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const b = await body(req);
    res.writeHead(req.method === 'POST' ? 201 : 200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ origin: NAME, method: req.method, path: p, body: b.toString('utf8') }));
  }
  if (p === '/stats') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(hits)); }
  if (p.endsWith('/echo/headers')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(req.headers)); }
  if (p === '/redirect') {
    const proto = CERT ? 'https' : 'http';
    res.writeHead(302, { Location: `${proto}://${req.headers.host}/index.html` }); return res.end();
  }
  if (p === '/gzip.txt') {
    const plain = Buffer.from(`texto comprimido desde ${NAME}\n`.repeat(20));
    if (/gzip/.test(req.headers['accept-encoding'] || '')) {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Encoding': 'gzip' });
      return res.end(zlib.gzipSync(plain));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end(plain);
  }
  const st = /^\/status\/(\d{3})(\.[a-z]+)?$/.exec(p);
  if (st) { res.writeHead(Number(st[1]), { 'Content-Type': 'text/plain' }); return res.end(`status ${st[1]}\n`); }
  if (p.startsWith('/fixed/')) {
    const n = Math.max(0, Number(url.searchParams.get('size') || 100));
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' }); return res.end(Buffer.alloc(n, 'x'));
  }
  const ext = (p.match(/\.([a-z0-9]+)$/i) || [])[1]?.toLowerCase() || 'html';
  if (ext === 'png') { res.writeHead(200, { 'Content-Type': TYPES.png }); return res.end(PNG); }
  const text = ext === 'json'
    ? JSON.stringify({ origin: NAME, path: p, visita: hits[p] })
    : `origen=${NAME} ruta=${p} visita=${hits[p]}\n`;
  res.writeHead(200, { 'Content-Type': TYPES[ext] || 'application/octet-stream', 'Set-Cookie': 'origen=1; Path=/' });
  res.end(req.method === 'HEAD' ? undefined : text);
}

const srv = CERT ? https.createServer({ cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY) }, handler)
                 : http.createServer(handler);
srv.listen(PORT, '127.0.0.1', () => console.log(`origen ${NAME} en ${CERT ? 'https' : 'http'}://127.0.0.1:${PORT}`));
