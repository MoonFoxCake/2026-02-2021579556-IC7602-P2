'use strict';
// Almacén en memoria con el mismo modelo de Firestore de API.md. Solo para pruebas (sin credenciales de Firebase).
const bcrypt = require('bcryptjs');
const sha256 = (s) => require('crypto').createHash('sha256').update(s).digest('hex');

function seed({ webOrigin = 'http://origen-web:80', javaOrigin = 'http://rest-api-java:8080' } = {}) {
  const domains = [
    { id: 'ejemplo.com', domain: 'ejemplo.com', verified: true },
    { id: 'pendiente.com', domain: 'pendiente.com', verified: false },
  ];
  const urls = [
    { id: 'u1', domain: 'ejemplo.com', pattern: '/*', origin: webOrigin, cacheSizeMB: 1, replacementPolicy: 'LRU', authType: 'none',
      fileTypes: [{ ext: 'html', ttlSeconds: 60 }, { ext: '.PNG', ttlSeconds: 3600 }] },
    { id: 'u2', domain: 'ejemplo.com', pattern: '/api/*', origin: javaOrigin, cacheSizeMB: 2, replacementPolicy: 'mru', authType: 'apikey',
      fileTypes: [{ ext: 'json', ttlSeconds: 20 }] },
    { id: 'u3', domain: 'ejemplo.com', pattern: '/privado/*', origin: webOrigin, cacheSizeMB: 1, replacementPolicy: 'LFU', authType: 'userpass',
      fileTypes: [{ ext: '*', ttlSeconds: 120 }] },
    { id: 'u4', domain: 'ejemplo.com', pattern: '/raro/*', origin: webOrigin, cacheSizeMB: 1, replacementPolicy: 'ARC', authType: 'magia', fileTypes: [] },
    { id: 'u5', domain: 'pendiente.com', pattern: '/*', origin: 'http://x', cacheSizeMB: 1, replacementPolicy: 'LRU', authType: 'none', fileTypes: [] },
  ];
  const apiKeys = [{ id: 'k1', urlId: 'u2', keyHash: sha256('clave-demo').toUpperCase(), prefix: 'clave-' }];
  const urlUsers = { 'u3_kevin': { urlId: 'u3', username: 'kevin', passwordHash: bcrypt.hashSync('s3creto', 4) } };
  return {
    listDomains: async () => domains.filter((d) => d.verified),
    listUrls: async () => urls,
    listApiKeys: async () => apiKeys,
    getDomain: async (d) => domains.find((x) => x.domain === d) || null,
    findUrl: async (d, p) => urls.find((u) => u.domain === d && u.pattern === p) || null,
    getUser: async (urlId, name) => urlUsers[`${urlId}_${name}`] || null,
  };
}
module.exports = { seed, sha256 };
