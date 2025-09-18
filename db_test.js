require('dotenv').config({ path: __dirname + '/.env' });
const { Pool } = require('pg');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

(async () => {
  try {
    // 1) Zeig mir DB & Schema
    const info = await pool.query('SELECT current_database() AS db, current_schema() AS schema');
    console.log('DB-Info:', info.rows[0]); // <- sollte { db: 'pokerjoker', schema: 'public' } sein

    // 2) Liste alle Tabellen im Schema public
    const tables = await pool.query(`
      SELECT table_schema, table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      ORDER BY table_name;
    `);
    console.log('Tables:', tables.rows);

    // 3) Explizit im Schema public testen
    await pool.query('SET search_path TO public');
    const ins = await pool.query(
      'INSERT INTO public.users (email, password) VALUES ($1, $2) RETURNING id, email, created_at',
      ['test@example.com', 'nur_zum_testen']
    );
    console.log('INSERT OK:', ins.rows[0]);

    const sel = await pool.query('SELECT id, email, tokens, created_at FROM public.users ORDER BY id DESC LIMIT 3');
    console.log('SELECT OK:', sel.rows);

  } catch (e) {
    console.error('DB-Fehler:', e.message);
  } finally {
    await pool.end();
  }
})();
