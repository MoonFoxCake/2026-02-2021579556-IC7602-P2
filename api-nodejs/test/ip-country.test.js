'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { countryForIp, ipv4Number } = require('../src/ip-country');
const { readRanges, checkOverlap, importRanges } = require('../scripts/import-ip-country');
const { parseDbip } = require('../scripts/import-dbip');
const fixture = require('../scripts/ip-country-p1-fixture.json');

function database(rows) {
  return async (path, { query }) => {
    assert.equal(path, '/ipToCountry');
    assert.equal(query.orderBy, '"ipFrom"'); assert.equal(query.limitToLast, 1);
    const row = rows.filter((r) => r.ipFrom <= query.endAt).sort((a, b) => b.ipFrom - a.ipFrom)[0];
    return row ? { range: row } : null;
  };
}

test('P1 indexed inclusive ranges: both boundaries, gaps, mapped IPv4 and invalid inputs', async () => {
  const db = database(readRanges(fixture));
  for (const ip of ['8.8.8.0', '8.8.8.8', '8.8.8.255', '::ffff:8.8.8.8']) assert.equal(await countryForIp(ip, db), 'US');
  for (const ip of ['10.0.0.0', '10.255.255.255', '192.168.49.2']) assert.equal(await countryForIp(ip, db), 'CR');
  for (const ip of ['0.0.0.0', '8.8.7.255', '8.8.9.0', '255.255.255.255', '256.1.1.1', '::1', '1.2.3', 'garbage']) assert.equal(await countryForIp(ip, db), null);
  assert.equal(ipv4Number('255.255.255.255'), 4294967295);
});

test('import supports P1 flat exports, validates before writes and rejects overlaps', () => {
  const row = { startIp: '8.8.8.0', endIp: '8.8.8.255', countryCode: 'us' };
  assert.deepEqual(readRanges({ 'ipToCountry/test': row, 'metadata/test': {} }), [{ ...row, ipFrom: 134744064, ipTo: 134744319, countryCode: 'US' }]);
  assert.throws(() => readRanges({ bad: { ipFrom: -1, ipTo: 3, countryCode: 'US' } }));
  assert.throws(() => readRanges({}));
  assert.throws(() => checkOverlap([{ ipFrom: 1, ipTo: 3 }, { ipFrom: 3, ipTo: 5 }]));
  checkOverlap(readRanges(fixture));
});

test('lookup propagates database failures and rejects malformed stored ranges', async () => {
  await assert.rejects(countryForIp('8.8.8.8', async () => { throw new Error('offline'); }), /offline/);
  assert.equal(await countryForIp('8.8.8.8', database([{ ipFrom: 0, ipTo: 4294967295, countryCode: 'invalid' }])), null);
});

test('DB-IP CSV imports only valid IPv4 ranges and treats ZZ as unknown', async () => {
  const parsed = parseDbip('0.0.0.0,0.255.255.255,ZZ\n"8.8.8.0","8.8.8.255","US"\n2001:db8::,2001:db8::ffff,US\n');
  assert.equal(parsed.rows.length, 2); assert.equal(parsed.ipv6Skipped, 1);
  assert.equal(await countryForIp('0.0.0.1', database(parsed.rows)), null);
  for (const csv of ['bad,data,US', '8.8.8.9,8.8.8.0,US', '8.8.8.0,8.8.8.255,US\n8.8.8.5,8.8.9.0,CR']) assert.throws(() => parseDbip(csv));
});

test('import validates before writing and atomically replaces only the table and metadata', async () => {
  let called = false;
  await assert.rejects(importRanges({ bad: {} }, async () => { called = true; }));
  assert.equal(called, false);
  await importRanges(fixture, async (path, options) => {
    assert.equal(path, '/'); assert.equal(options.method, 'PATCH');
    assert.deepEqual(Object.keys(options.body).sort(), ['ipToCountry', 'metadata/ipToCountryDataset']);
    assert.equal(Object.keys(options.body.ipToCountry).length, 5);
    assert.equal(options.body.ipToCountry['ip-0134744064'].startIp, '8.8.8.0');
    assert.equal(options.body['metadata/ipToCountryDataset'].recordCount, 5);
  });
});
