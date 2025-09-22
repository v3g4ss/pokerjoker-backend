// utils/tokenDb.js
const { pool } = require('../db');

// Aktuellen Stand liefern
async function getTokens(userId) {
  const { rows } = await pool.query(
    `SELECT COALESCE(tokens,0) AS balance,
            COALESCE(purchased,0) AS purchased
     FROM public.users WHERE id=$1`,
    [userId]
  );
  return rows[0] || { balance: 0, purchased: 0 };
}

// Buy-in: +amount, purchased = letzte Kaufmenge (nicht Summe)
async function buyTokens(userId, amount) {
  const amt = Math.trunc(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('buyTokens: amount > 0');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { rows:[u] } = await client.query(
      `UPDATE public.users
         SET tokens = COALESCE(tokens,0) + $2,
             purchased = $2,
             updated_at = now()
       WHERE id=$1
       RETURNING COALESCE(tokens,0) AS balance,
                 COALESCE(purchased,0) AS purchased`,
      [userId, amt]
    );

    await client.query(
      `INSERT INTO public.token_ledger (user_id, delta, reason)
       VALUES ($1, $2, 'buy')`,
      [userId, amt]
    );

    await client.query('COMMIT');
    return u;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

// Verbrauch: –amount (niemals <0 gehen, und kein delta=0 ins Ledger)
async function consumeTokens(userId, amount, reason = 'spend') {
  const amt = Math.trunc(Number(amount));
  if (!Number.isFinite(amt) || amt <= 0) throw new Error('consumeTokens: amount > 0');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // Zeile sperren, Bestand lesen
    const { rows:[r] } = await client.query(
      `SELECT COALESCE(tokens,0) AS tokens, COALESCE(purchased,0) AS purchased
       FROM public.users WHERE id=$1 FOR UPDATE`,
      [userId]
    );
    const available = r ? r.tokens : 0;
    const used = Math.min(available, amt);

    // Wenn nix zu verbrauchen -> kein Ledger-Insert (Constraint!)
    if (used === 0) {
      await client.query('COMMIT');
      return { balance: available, purchased: r ? r.purchased : 0 };
    }

    const { rows:[u] } = await client.query(
      `UPDATE public.users
         SET tokens = COALESCE(tokens,0) - $2,
             updated_at = now()
       WHERE id=$1
       RETURNING COALESCE(tokens,0) AS balance,
                 COALESCE(purchased,0) AS purchased`,
      [userId, used]
    );

    await client.query(
      `INSERT INTO public.token_ledger (user_id, delta, reason)
       VALUES ($1, $2, $3)`,
      [userId, -used, reason]
    );

    await client.query('COMMIT');
    return u;
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  getTokens,
  buyTokens,
  consumeTokens,
};
