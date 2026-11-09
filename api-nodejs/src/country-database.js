'use strict';

// P1 uses the authenticated RTDB REST API; tokens stay in headers, never URLs or logs.
async function countryDatabase(path, { query = {}, method = 'GET', body, timeout = 5000 } = {}) {
  const base = process.env.FIREBASE_DATABASE_URL;
  if (!base || !base.startsWith('https://')) throw new Error('FIREBASE_DATABASE_URL must be an HTTPS Realtime Database URL');
  const { admin } = require('./firebase');
  const token = await admin.app().options.credential.getAccessToken();
  const url = new URL(`${path}.json`, base);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, String(value));
  const response = await fetch(url, { method, signal: AbortSignal.timeout(timeout),
    headers: { Authorization: `Bearer ${token.access_token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(`IP-to-Country database HTTP ${response.status}: ${String(detail.error || 'request failed').slice(0, 300)}`);
  }
  return response.status === 204 ? null : response.json();
}

module.exports = { countryDatabase };
