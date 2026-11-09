'use strict';

// Creates one isolated public rule, exercises the deployed caches, then removes only that rule.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

async function main() {
  const { EXTERNAL_HTTP_API_URL, EXTERNAL_HTTP_ADMIN_TOKEN, EXTERNAL_HTTP_DOMAIN,
    EXTERNAL_HTTP_ORIGIN, EXTERNAL_HTTP_PATH } = process.env;
  assert.ok(EXTERNAL_HTTP_ADMIN_TOKEN, 'Set EXTERNAL_HTTP_ADMIN_TOKEN to your account JWT');
  assert.match(EXTERNAL_HTTP_DOMAIN || '', /^[a-z0-9.-]+$/);
  const api = new URL(EXTERNAL_HTTP_API_URL);
  const origin = new URL(EXTERNAL_HTTP_ORIGIN);
  assert.equal(api.protocol, 'https:');
  assert.equal(origin.protocol, 'http:', 'The origin must actually use plain HTTP');
  assert.ok(!api.username && !api.password && !origin.username && !origin.password);
  assert.equal(origin.pathname, '/');
  assert.ok(!origin.search && !origin.hash && !api.search && !api.hash);
  assert.match(EXTERNAL_HTTP_PATH || '', /^\/[A-Za-z0-9/_-]+\.([a-z0-9]{1,10})$/);
  const extension = EXTERNAL_HTTP_PATH.split('.').at(-1);
  const base = api.href.replace(/\/$/, '');
  async function call(route, method = 'GET', body) {
    const response = await fetch(base + route, { method, signal: AbortSignal.timeout(25000),
      headers: { Authorization: `Bearer ${EXTERNAL_HTTP_ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    assert.ok(response.ok, `${method} ${route}: HTTP ${response.status}`);
    return response.json();
  }
  const baseline = await fetch(new URL(EXTERNAL_HTTP_PATH, origin), {
    redirect: 'manual', signal: AbortSignal.timeout(20000),
  });
  assert.equal(baseline.status, 200, 'External HTTP origin must return content without an HTTPS redirect');
  const body = await baseline.text();
  assert.ok(body.length > 0 && Buffer.byteLength(body) < 65536, 'Use a nonempty test resource below the panel body limit');
  const digest = value => crypto.createHash('sha256').update(value).digest('hex');
  const { urls } = await call(`/domains/${EXTERNAL_HTTP_DOMAIN}/urls`);
  assert.ok(!urls.some(rule => rule.pattern === EXTERNAL_HTTP_PATH), 'Pattern already exists; refusing to alter an existing rule');
  const { enabled, zones } = await call('/cache-test/status');
  assert.ok(enabled && zones.length > 0);
  let created;
  try {
    created = await call(`/domains/${EXTERNAL_HTTP_DOMAIN}/urls`, 'POST', {
      pattern: EXTERNAL_HTTP_PATH, origin: origin.origin, cacheSizeMB: 1,
      fileTypes: [{ ext: extension, ttlSeconds: 3 }], replacementPolicy: 'LRU', authType: 'none',
    });
    console.log(`Created isolated external HTTP test rule ${created.id}; waiting for cache refresh.`);
    for (const zone of zones) {
      const input = { urlId: created.id, host: EXTERNAL_HTTP_DOMAIN, zone,
        path: `${EXTERNAL_HTTP_PATH}?external_http_probe=${crypto.randomUUID()}` };
      let first;
      const deadline = Date.now() + 90000;
      while (Date.now() < deadline) {
        first = await call('/cache-test/request', 'POST', input);
        if (first.status === 200) break;
        await delay(2000);
      }
      assert.equal(first?.status, 200, `${zone}: external HTTP resource never became available`);
      assert.equal(first.headers['x-cache'], 'MISS');
      assert.equal(first.headers['x-zc-zone'], zone);
      assert.equal(digest(first.body), digest(body), `${zone}: cached content differs from the plain HTTP origin`);
      const hit = await call('/cache-test/request', 'POST', input);
      assert.equal(hit.status, 200);
      assert.equal(hit.headers['x-cache'], 'HIT');
      assert.equal(digest(hit.body), digest(body));
      await delay(4000);
      const expired = await call('/cache-test/request', 'POST', input);
      assert.equal(expired.status, 200);
      assert.equal(expired.headers['x-cache'], 'MISS');
      console.log(`PASS ${zone}: real HTTP origin → HTTP 200 / MISS / HIT / TTL expiry; SHA-256 ${digest(body)}`);
    }
  } finally {
    if (created) {
      await call(`/urls/${created.id}`, 'DELETE');
      const remaining = await call(`/domains/${EXTERNAL_HTTP_DOMAIN}/urls`);
      assert.ok(!remaining.urls.some(rule => rule.id === created.id), 'Temporary rule was not removed');
      console.log('PASS cleanup: temporary rule deleted; existing rules preserved.');
    }
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
