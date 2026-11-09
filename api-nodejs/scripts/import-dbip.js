'use strict';

const fs = require('node:fs');
const crypto = require('node:crypto');
const { isIP } = require('node:net');
const { gunzipSync } = require('node:zlib');
const { ipv4Number } = require('../src/ip-country');
const { checkOverlap, importRanges } = require('./import-ip-country');

function parseDbip(csv) {
  const rows = [];
  let ipv6Skipped = 0;
  for (const line of csv.trim().split(/\r?\n/)) {
    // DB-IP Country CSV has exactly three scalar fields, none containing commas.
    const match = /^"?([^",]+)"?,"?([^",]+)"?,"?([A-Z]{2})"?$/.exec(line);
    if (!match) throw new Error('Invalid DB-IP CSV row; nothing imported');
    const [, startIp, endIp, countryCode] = match;
    const family = isIP(startIp);
    if (!family || family !== isIP(endIp)) throw new Error('Invalid DB-IP address range');
    if (family === 6) { ipv6Skipped++; continue; }
    const ipFrom = ipv4Number(startIp), ipTo = ipv4Number(endIp);
    if (ipFrom > ipTo) throw new Error('Reversed DB-IP range');
    rows.push({ startIp, endIp, ipFrom, ipTo, countryCode });
  }
  if (!rows.length) throw new Error('DB-IP file contains no IPv4 ranges');
  checkOverlap(rows);
  return { rows, ipv6Skipped };
}

async function main() {
  require('dotenv').config();
  const [file, expectedMd5, action] = process.argv.slice(2);
  const edition = /dbip-country-lite-(\d{4}-\d{2})\.csv(?:\.gz)?$/.exec(file || '')?.[1];
  if (!edition || !/^[a-f0-9]{32}$/i.test(expectedMd5 || '') || (action && action !== '--import')) {
    throw new Error('Usage: npm run ip-country:dbip -- dbip-country-lite-YYYY-MM.csv[.gz] <published-CSV-MD5> [--import]');
  }
  const archive = fs.readFileSync(file);
  const bytes = file.endsWith('.gz') ? gunzipSync(archive) : archive;
  if (crypto.createHash('md5').update(bytes).digest('hex') !== expectedMd5.toLowerCase()) throw new Error('DB-IP checksum mismatch; nothing imported');
  const { rows, ipv6Skipped } = parseDbip(bytes.toString('utf8'));
  const metadata = { provider: 'DB-IP', edition, ipv4Only: true, ipv6Skipped,
    license: 'CC BY 4.0', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
    attribution: 'IP Geolocation by DB-IP', sourceUrl: 'https://db-ip.com/db/download/ip-to-country-lite',
    sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  console.log(JSON.stringify({ ...metadata, ipv4Ranges: rows.length, mode: action ? 'import' : 'validation-only' }));
  if (action) await importRanges({ ipToCountry: rows, metadata });
  console.log(action ? 'IP-to-Country table and metadata imported atomically.' : 'Validated; add --import to replace the RTDB country table.');
}

if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; })
  .finally(async () => { const admin = require('firebase-admin'); await Promise.all(admin.apps.map((app) => app.delete())); });

module.exports = { parseDbip };
