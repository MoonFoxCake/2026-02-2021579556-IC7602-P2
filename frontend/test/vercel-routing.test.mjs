import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'

process.env.API_PROXY_ORIGIN = 'https://api.example.test'
const { config } = await import('../vercel.mjs')
const fallback = config.rewrites.find((rule) => rule.destination === '/index.html')
const matchesFallback = new RegExp(`^${fallback.source}$`)

test('API calls use the Node API proxy before the SPA fallback, keeping session cookies on the UI origin', () => {
  const proxy = config.rewrites.find((rule) => rule.source === '/api/:path*')
  assert.equal(proxy?.destination, 'https://api.example.test/api/:path*')
  assert.ok(config.rewrites.indexOf(proxy) < config.rewrites.indexOf(fallback))
})

test('deployment rejects missing, insecure or ambiguous API origins', () => {
  for (const value of ['', 'http://api.example.test', 'https://user:pass@api.example.test', 'https://api.example.test/api', 'https://api.example.test?token=test', 'https://api.example.test#fragment']) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(new URL('../vercel.mjs', import.meta.url).href)})`], {
      env: { ...process.env, API_PROXY_ORIGIN: value }, encoding: 'utf8',
    })
    assert.notEqual(result.status, 0, value)
    assert.match(result.stderr, /API_PROXY_ORIGIN/)
  }
})

test('SPA routes still receive index.html', () => {
  for (const path of ['/', '/account', '/domains/example.com', '/cache-login']) assert.ok(matchesFallback.test(path), path)
})

test('API and Vercel telemetry paths never receive HTML from the SPA fallback', () => {
  for (const path of ['/api', '/api/health', '/_vercel/insights/script.js', '/_vercel/speed-insights/script.js']) {
    assert.equal(matchesFallback.test(path), false, path)
  }
})
