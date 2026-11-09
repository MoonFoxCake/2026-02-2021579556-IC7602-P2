'use strict';

// P1 IpToCountryService: indexed predecessor lookup, then inclusive upper-bound check.
function ipv4Number(ip) {
  const parts = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(String(ip || ''));
  if (!parts) return null;
  const octets = parts.slice(1).map(Number);
  return octets.some((n) => n > 255) ? null : octets.reduce((n, octet) => n * 256 + octet, 0);
}

function validRange(row) {
  return row && Number.isInteger(row.ipFrom) && Number.isInteger(row.ipTo)
    && row.ipFrom >= 0 && row.ipFrom <= row.ipTo && row.ipTo <= 0xffffffff
    && /^[A-Z]{2}$/.test(row.countryCode);
}

async function countryForIp(ip, request = require('./country-database').countryDatabase) {
  const number = ipv4Number(ip);
  if (number === null) return null;
  let row;
  if (process.env.FIRESTORE_EMULATOR_HOST) {
    // The existing offline Compose demo has only a Firestore emulator, seeded with P1 fixtures.
    const result = await require('./firebase').db.collection('ipToCountry')
      .where('ipFrom', '<=', number).orderBy('ipFrom', 'desc').limit(1).get();
    row = result.docs[0]?.data();
  } else {
    const result = await request('/ipToCountry', { query: { orderBy: '"ipFrom"', endAt: number, limitToLast: 1 } });
    row = result && Object.values(result)[0];
  }
  return validRange(row) && row.countryCode !== 'ZZ' && number <= row.ipTo ? row.countryCode : null;
}

module.exports = { ipv4Number, validRange, countryForIp };
