import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
const fallback = config.rewrites.find((rule) => rule.destination === '/index.html')
const matchesFallback = new RegExp(`^${fallback.source}$`)

test('SPA routes still receive index.html', () => {
  for (const path of ['/', '/account', '/domains/example.com', '/cache-login']) assert.ok(matchesFallback.test(path), path)
})

test('API and Vercel telemetry paths never receive HTML from the SPA fallback', () => {
  for (const path of ['/api', '/api/health', '/_vercel/insights/script.js', '/_vercel/speed-insights/script.js']) {
    assert.equal(matchesFallback.test(path), false, path)
  }
})
