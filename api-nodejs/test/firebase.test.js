'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(require.resolve('../src/firebase'), 'utf8');
function initialize(env, apps = []) {
  let options;
  let certificates = 0;
  const admin = {
    apps,
    credential: { cert: (value) => { certificates++; return value; } },
    initializeApp: (value) => { options = value; },
    firestore: () => ({}),
  };
  vm.runInNewContext(source, { require: () => admin, process: { env }, module: { exports: {} } });
  return { options: options && JSON.parse(JSON.stringify(options)), certificates };
}

test('emulator uses the demo project without a service account, even if old credentials exist', () => {
  const result = initialize({ FIRESTORE_EMULATOR_HOST: 'firestore-emulator:8080',
    FIREBASE_PROJECT_ID: 'demo-p2', FIREBASE_PRIVATE_KEY: 'not-a-real-key' });
  assert.deepEqual(result.options, { projectId: 'demo-p2' });
  assert.equal(result.certificates, 0);
});

test('emulator rejects real or missing project IDs and URL-form hosts', () => {
  for (const project of [undefined, 'real-project']) {
    assert.throws(() => initialize({ FIRESTORE_EMULATOR_HOST: 'localhost:8080',
      FIREBASE_PROJECT_ID: project }), /demo-/);
  }
  assert.throws(() => initialize({ FIRESTORE_EMULATOR_HOST: 'http:\/\/localhost:8080',
    FIREBASE_PROJECT_ID: 'demo-p2' }), /sin protocolo/);
});

test('hosted Firebase still requires credentials and normalizes PEM newlines', () => {
  assert.throws(() => initialize({}), /Faltan variables/);
  const result = initialize({ FIREBASE_PROJECT_ID: 'real-project', FIREBASE_CLIENT_EMAIL: 'a@b.test',
    FIREBASE_PRIVATE_KEY: '"first\\nsecond"' });
  assert.deepEqual(result.options.credential, {
    projectId: 'real-project', clientEmail: 'a@b.test', privateKey: 'first\nsecond',
  });
  assert.equal(result.certificates, 1);
});

test('an existing Firebase app is reused', () => {
  assert.equal(initialize({}, [{}]).options, undefined);
});
