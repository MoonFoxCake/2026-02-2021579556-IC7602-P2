'use strict';

require('dotenv').config();
const assert = require('node:assert/strict');
const https = require('node:https');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const env = process.env;
for (const key of ['HANDOFF_API_URL', 'HANDOFF_CACHE_URL', 'HANDOFF_USERNAME', 'HANDOFF_PASSWORD']) {
  assert.ok(env[key], `Set ${key}`);
}
const resource = new URL(env.HANDOFF_CACHE_URL);
assert.equal(resource.protocol, 'https:', 'Use an HTTPS cache resource');
resource.searchParams.set('probe', crypto.randomUUID());
let checks = 0;
function passed(name) { console.log(`PASS ${++checks}: ${name}`); }

function cacheRequest(url, cookie) {
  assert.equal(url.origin, resource.origin, 'Callback must stay on the requested cache domain');
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      rejectUnauthorized: env.HANDOFF_ALLOW_SELF_SIGNED !== '1',
      ...(env.HANDOFF_CACHE_IP ? { lookup: (_, options, done) => done(null, options.all ? [{ address: env.HANDOFF_CACHE_IP, family: 4 }] : env.HANDOFF_CACHE_IP, 4) } : {}),
      headers: cookie ? { Cookie: cookie } : {},
    }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; if (body.length > 2 * 1024 * 1024) req.destroy(new Error('Test response too large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.setTimeout(15000, () => req.destroy(new Error('Cache request timed out')));
  });
}

async function main() {
  const first = await cacheRequest(resource);
  assert.equal(first.status, 302, 'Protected resource must redirect before authentication');
  const ui = new URL(first.headers.location);
  assert.equal(ui.protocol, 'https:'); assert.equal(ui.pathname, '/cache-login');
  passed('Kubernetes cache redirects to the external UI');
  const input = { domain: ui.searchParams.get('domain'), pattern: ui.searchParams.get('pattern'),
    callback: ui.searchParams.get('callback'), returnTo: ui.searchParams.get('return_to'),
    username: env.HANDOFF_USERNAME, password: env.HANDOFF_PASSWORD };
  const post = (body) => fetch(`${env.HANDOFF_API_URL.replace(/\/$/, '')}/api/cache-login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ui.origin },
    body: JSON.stringify(body), signal: AbortSignal.timeout(20000),
  });
  assert.equal((await post({ ...input, password: 'intentionally-wrong-test-password' })).status, 401);
  passed('Firestore resource credentials reject the wrong password');
  assert.equal((await post({ ...input, callback: 'https://unrelated.test/__zc/callback' })).status, 400);
  passed('API rejects an external callback host');
  const issue = async () => {
    const response = await post(input);
    assert.equal(response.status, 200, 'Resource user must authenticate without an account JWT');
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), ui.origin);
    return new URL((await response.json()).redirectUrl);
  };
  const callback = await issue();
  passed('Vercel issues a ticket with CORS and no-store headers');
  const expiredCandidate = env.HANDOFF_TEST_EXPIRY === '1' ? await issue() : null;
  const tampered = new URL(callback);
  const ticket = tampered.searchParams.get('ticket');
  tampered.searchParams.set('ticket', ticket.slice(0, -1) + (ticket.endsWith('0') ? '1' : '0'));
  assert.equal((await cacheRequest(tampered)).status, 401);
  passed('C cache rejects a tampered ticket');
  const accepted = await cacheRequest(callback);
  assert.equal(accepted.status, 302);
  const session = accepted.headers['set-cookie']?.find((cookie) => cookie.startsWith('zc_session='));
  assert.ok(session && /HttpOnly/i.test(session) && /Secure/i.test(session) && /SameSite=Lax/i.test(session), 'Session cookie must be secure and HttpOnly');
  assert.equal(accepted.headers['referrer-policy'], 'no-referrer');
  assert.equal(accepted.headers['cache-control'], 'no-store');
  passed('C cache accepts the API ticket and sets a secure session');
  assert.equal((await cacheRequest(callback)).status, 401);
  passed('Ticket replay is rejected by the receiving zone');
  const cookie = session.split(';')[0];
  const miss = await cacheRequest(resource, cookie);
  assert.equal(miss.status, 200); assert.match(miss.body, /Apache de prueba/);
  assert.equal(miss.headers['x-cache'], 'MISS');
  passed('Authenticated request reaches the Kubernetes Apache origin: MISS');
  const hit = await cacheRequest(resource, cookie);
  assert.equal(hit.status, 200); assert.equal(hit.headers['x-cache'], 'HIT');
  passed('Subsequent authenticated request reuses the session and disk cache: HIT');
  assert.equal((await cacheRequest(resource)).status, 302);
  passed('Cached content still requires authentication');
  const logout = new URL('/__zc/logout?return_to=/index.html', resource);
  assert.equal((await cacheRequest(logout, cookie)).status, 302);
  assert.equal((await cacheRequest(resource, cookie)).status, 302);
  passed('Logout revokes the cache session');
  if (expiredCandidate) {
    console.log('Waiting for the unredeemed 60-second ticket to expire...');
    await delay(61000);
    assert.equal((await cacheRequest(expiredCandidate)).status, 401);
    passed('An expired, previously unused API ticket is rejected');
  }
  console.log(`${checks} handoff checks passed.`);
}
main().catch((error) => { console.error(error.message); process.exitCode = 1; });
