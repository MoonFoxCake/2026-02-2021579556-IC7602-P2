'use strict';

/**
 * Servidor local para desarrollo: npm start
 * En Vercel no se usa; alli la app se expone desde api/index.js.
 */

require('dotenv').config();

const app = require('./app');

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`API escuchando en http://localhost:${port}`);
});
