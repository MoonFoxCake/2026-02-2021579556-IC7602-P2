'use strict';

const { ipv4Number, validRange } = require('../src/ip-country');

function readRanges(input) {
  const table = input.ipToCountry || input;
  const flat = Object.keys(table).some((key) => key.startsWith('ipToCountry/'));
  const rows = Object.entries(table).filter(([key]) => !flat || key.startsWith('ipToCountry/')).map(([, value]) => {
    const row = { ...value, ipFrom: value.ipFrom ?? ipv4Number(value.startIp),
      ipTo: value.ipTo ?? ipv4Number(value.endIp), countryCode: String(value.countryCode || '').toUpperCase() };
    if (!validRange(row)) throw new Error('Invalid IPv4 range or country code; nothing imported');
    return row;
  });
  if (!rows.length) throw new Error('Empty IP-to-Country table; nothing imported');
  return rows;
}

function checkOverlap(rows) {
  const sorted = [...rows].sort((a, b) => a.ipFrom - b.ipFrom);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].ipFrom <= sorted[i - 1].ipTo) throw new Error('Overlapping IP ranges; nothing imported');
  }
}

async function importRanges(input, request = require('../src/country-database').countryDatabase) {
  const rows = readRanges(input);
  checkOverlap(rows);
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  const dotted = (n) => [24, 16, 8, 0].map((bits) => (n >>> bits) & 255).join('.');
  const table = Object.fromEntries(rows.map((row) => [`ip-${String(row.ipFrom).padStart(10, '0')}`, {
    ...row, startIp: row.startIp || dotted(row.ipFrom), endIp: row.endIp || dotted(row.ipTo),
    countryName: row.countryName || names.of(row.countryCode),
  }]));
  // A single atomic REST PATCH replaces only the derived table and its metadata.
  const body = {
    ipToCountry: table,
    'metadata/ipToCountryDataset': {
      ...(input.metadata?.ipToCountryDataset || input.metadata || input['metadata/ipToCountryDataset'] || {}),
      recordCount: rows.length, importedAt: new Date().toISOString(), schema: 'P1-inclusive-ipv4-ranges',
    },
  };
  if (Buffer.byteLength(JSON.stringify(body)) > 256 * 1024 * 1024) throw new Error('Import exceeds the RTDB REST payload limit');
  // A full monthly table exceeds RTDB's default estimated write-time limit; override only this explicit import.
  await request('/', { method: 'PATCH', timeout: 300000, query: { print: 'silent', writeSizeLimit: 'unlimited' }, body });
  return rows.length;
}

if (require.main === module) {
  require('dotenv').config();
  const file = process.argv[2];
  if (!file) throw new Error('Usage: npm run ip-country:import -- path/to/p1-export.json');
  Promise.resolve().then(() => importRanges(JSON.parse(require('fs').readFileSync(file, 'utf8'))))
    .then((count) => console.log(`Imported ${count} IP-to-Country ranges into ${process.env.FIREBASE_PROJECT_ID}`))
    .catch((error) => { console.error(error.message); process.exitCode = 1; })
    .finally(async () => { const { admin } = require('../src/firebase'); await Promise.all(admin.apps.map((app) => app.delete())); });
}

module.exports = { readRanges, checkOverlap, importRanges };
