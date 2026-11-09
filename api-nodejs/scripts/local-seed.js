'use strict';

// Seed only the explicitly selected emulator; never write demo data to hosted Firestore.
if (!process.env.FIRESTORE_EMULATOR_HOST || !process.env.FIREBASE_PROJECT_ID?.startsWith('demo-')) {
  throw new Error('Local seed requires FIRESTORE_EMULATOR_HOST and a demo- project ID');
}

const bcrypt = require('bcryptjs');
const { db } = require('../src/firebase');
const { normalizeEmail, userIdFor } = require('../src/auth-routes');

async function createIfMissing(collection, id, fields) {
  try {
    await db.collection(collection).doc(id).create(fields);
  } catch (error) {
    if (error.code !== 6) throw error;
  }
}

async function seed() {
  const email = normalizeEmail(process.env.LOCAL_DEMO_EMAIL);
  const password = process.env.LOCAL_DEMO_PASSWORD;
  if (!email || !password || password.length < 8 || Buffer.byteLength(password) > 72) {
    throw new Error('Set a valid LOCAL_DEMO_EMAIL and LOCAL_DEMO_PASSWORD (8 to 72 bytes)');
  }
  const ownerId = userIdFor(email);
  const createdAt = new Date().toISOString();
  for (const row of require('./import-ip-country').readRanges(require('./ip-country-p1-fixture.json'))) {
    await createIfMissing('ipToCountry', `ip-${String(row.ipFrom).padStart(10, '0')}`, row);
  }
  await createIfMissing('users', ownerId, {
    email, passwordHash: await bcrypt.hash(password, 10), createdAt,
  });
  await createIfMissing('domains', 'p2.test', {
    ownerId, verified: true, verifiedAt: createdAt, createdAt, txtToken: 'local-emulator-seed',
  });
  for (const rule of [
    { id: 'local-apache', pattern: '/*', origin: 'http://apache-web:8080', ext: 'html' },
    { id: 'local-java', pattern: '/api/*', origin: 'http://rest-api-java:8080', ext: 'json' },
  ]) {
    await createIfMissing('urls', rule.id, {
      ownerId, domain: 'p2.test', pattern: rule.pattern, origin: rule.origin,
      cacheSizeMB: 10, fileTypes: [{ ext: rule.ext, ttlSeconds: 30 }],
      replacementPolicy: 'LRU', authType: 'none', createdAt,
    });
  }
  console.log('Local emulator ready: demo account, p2.test, Apache and Java URL rules');
}

seed().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(() => db.terminate());
