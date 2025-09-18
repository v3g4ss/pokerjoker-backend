// db.js
const { Pool } = require('pg');

// Lokal (localhost/127.0.0.1) => KEIN SSL, sonst (Prod/Cloud) => SSL erlauben
const isLocal = /(localhost|127\.0\.0\.1)/i.test(process.env.DATABASE_URL || process.env.PGHOST || '');
const useSSL  = !isLocal && (process.env.PGSSL === 'true' || process.env.NODE_ENV === 'production');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSSL ? { rejectUnauthorized: false } : false, // <— entscheidend
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

module.exports = { pool };
