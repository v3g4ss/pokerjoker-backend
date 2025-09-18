// routes/tokens.js
const express = require('express');
const router = express.Router();
const requireAuth = require('../middleware/requireAuth');
const { pool } = require('../db');

// GET /api/tokens → exakt wie Admin (v_user_balances)
router.get('/', requireAuth, async (req, res) => {
  try {
    const uid = req.user?.id;

    const { rows } = await pool.query(`
      WITH bal AS (
  SELECT balance FROM public.v_user_balances_live WHERE user_id = $1
    ),
    pur AS (
      SELECT COALESCE(SUM(delta),0) AS total
      FROM public.token_ledger
      WHERE user_id = $1 AND delta > 0
    )
      SELECT
        COALESCE((SELECT balance FROM bal), 0)::int  AS balance,
        COALESCE((SELECT total   FROM pur), 0)::int  AS purchased
    `, [uid]);

    const out = rows[0] || { balance: 0, purchased: 0 };
    res.json({ ok: true, balance: out.balance, purchased: out.purchased });
  } catch (err) {
    console.error('GET /api/tokens:', err);
    res.json({ ok: false, error: 'DB-Fehler' });
  }
});

// DEBUG: zeigt DB/Port + View- und Ledger-Stand
router.get('/debug', requireAuth, async (req, res) => {
  const uid = req.user?.id;
  const dbinfo = await pool.query(
    `SELECT current_database() AS db, inet_server_addr()::text AS host, inet_server_port() AS port`
  );
  const v = await pool.query(
    `SELECT balance FROM public.v_user_balances WHERE user_id = $1`, [uid]
  );
  const last = await pool.query(`
    SELECT id, delta, reason, balance_after, created_at
    FROM public.token_ledger
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 5
  `, [uid]);

  res.json({ db: dbinfo.rows[0], view_balance: v.rows[0] || null, ledger_tail: last.rows });
});

module.exports = router;

router.get('/debug', requireAuth, async (req, res) => {
  const uid = req.user?.id;
  const dbinfo = await pool.query(`SELECT current_database() db, inet_server_addr()::text host, inet_server_port() port`);
  const v = await pool.query(`SELECT balance FROM public.v_user_balances WHERE user_id = $1`, [uid]);
  const last = await pool.query(`
    SELECT id, delta, reason, balance_after, created_at
    FROM public.token_ledger
    WHERE user_id = $1
    ORDER BY created_at DESC, id DESC
    LIMIT 5`, [uid]);
  res.json({ db: dbinfo.rows[0], view_balance: v.rows[0] || null, ledger_tail: last.rows });
});
