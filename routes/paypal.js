// routes/paypal.js
const express = require('express');
const router  = express.Router();
const paypal  = require('@paypal/checkout-server-sdk');
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');

// === PayPal SDK-Client ===
function client() {
  const env =
    String(process.env.PAYPAL_ENV || 'sandbox').toLowerCase() === 'live'
      ? new paypal.core.LiveEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        )
      : new paypal.core.SandboxEnvironment(
          process.env.PAYPAL_CLIENT_ID,
          process.env.PAYPAL_CLIENT_SECRET
        );

  return new paypal.core.PayPalHttpClient(env);
}

// === Produkt / Paket ===
// (Betrag als String mit Dezimalpunkt, Währung als ISO)
const PRODUCT = {
  name: 'Poker Joker – 10.000 Tokens',
  token_delta: 10000,
  price: '35.00',           // EUR
  currency: 'EUR',
};

// === 1) Order erstellen ===
// POST /api/pay/paypal/create
router.post('/paypal/create', requireAuth, async (req, res) => {
  try {
    const base = process.env.APP_BASE_URL || 'http://localhost:5000';

    const request = new paypal.orders.OrdersCreateRequest();
    request.requestBody({
      intent: 'CAPTURE',
      purchase_units: [
        {
          amount: { currency_code: PRODUCT.currency, value: PRODUCT.price },
          description: PRODUCT.name,
          // ⚠️ Metadaten sicher an die Order hängen (statt uid in URL)
          custom_id: JSON.stringify({
            user_id: req.user.id,
            tokens: PRODUCT.token_delta,
          }),
        },
      ],
      application_context: {
        brand_name: 'Poker Joker',
        landing_page: 'NO_PREFERENCE',
        user_action: 'PAY_NOW',
        // PayPal hängt ?token=<ORDER_ID> & PayerID=... automatisch an
        return_url: `${base}/api/pay/paypal/capture`,
        cancel_url: `${base}/app/pay-cancel.html`,
      },
    });

    const order = await client().execute(request);

    // Link zum Approve finden
    const approve = order.result.links?.find((l) => l.rel === 'approve')?.href;

    res.json({ ok: true, id: order.result.id, approve_url: approve, links: order.result.links });
  } catch (err) {
    console.error('PayPal create error:', err);
    res.status(500).json({ ok: false, error: err.message || 'paypal_create_failed' });
  }
});

// === 2) Capture-Route ===
// GET /api/pay/paypal/capture?token=<ORDER_ID>&PayerID=...
router.get('/paypal/capture', requireAuth, async (req, res) => {
  // PayPal liefert ORDER_ID in "token"
  const orderId = String(req.query?.token || '');
  if (!orderId) return res.status(400).send('Invalid capture params');

  try {
    const request = new paypal.orders.OrdersCaptureRequest(orderId);
    request.requestBody({}); // leer lassen

    const captureRes = await client().execute(request);
    const status = captureRes.result?.status;

    if (status !== 'COMPLETED') {
      console.warn('PayPal capture not completed:', status);
      return res.redirect('/app/pay-cancel.html');
    }

    // ❶ custom_id wieder auslesen (wir haben user_id & tokens dort abgelegt)
    let meta = null;
    try {
      // Je nach PayPal-Response kann custom_id an zwei Stellen auftauchen:
      meta =
        captureRes.result?.purchase_units?.[0]?.payments?.captures?.[0]?.custom_id ||
        captureRes.result?.purchase_units?.[0]?.custom_id ||
        null;
      if (meta) meta = JSON.parse(meta);
    } catch {
      meta = null;
    }

    // Fallback: wenn keine Meta geliefert wurde, nehmen wir eingeloggten User
    const userId = Number(meta?.user_id || req.user.id || 0);
    const delta  = Number(meta?.tokens  || PRODUCT.token_delta || 0);

    if (!(userId > 0 && delta > 0)) {
      console.warn('[PayPal] capture ohne valide Meta – keine Gutschrift:', { userId, delta });
      return res.redirect('/app/pay-success.html'); // kein harter Abbruch – Zahlung war ja ok
    }

    // ❷ Idempotenz: schon verbucht?
    const reason = `buy_paypal:${orderId}`;
    const check = await pool.query(
      'SELECT 1 FROM public.token_ledger WHERE user_id=$1 AND reason=$2 LIMIT 1',
      [userId, reason]
    );
    if (check.rowCount > 0) {
      console.log('⚠️ Zahlung bereits verbucht:', orderId);
      return res.redirect('/app/pay-success.html');
    }

    // ❸ Ledger schreiben
    await pool.query(
      `INSERT INTO public.token_ledger (user_id, delta, reason, created_at)
       VALUES ($1, $2, $3, now())`,
      [userId, delta, reason]
    );

    // ❹ users.tokens & users.purchased erhöhen
    await pool.query(
      `UPDATE public.users
         SET tokens = tokens + $1,
             purchased = purchased + $1
       WHERE id = $2`,
      [delta, userId]
    );

    // ❺ (Optional) balance_after neu berechnen – wie in deinem Code
    await pool.query(
      `
      WITH s1 AS (
        SELECT id, user_id, created_at, delta,
               SUM(delta) OVER (PARTITION BY user_id ORDER BY created_at, id) AS run_sum
        FROM public.token_ledger
        WHERE user_id = $1
      ),
      s2 AS (
        SELECT id, run_sum, MIN(run_sum) OVER (PARTITION BY user_id) AS min_run
        FROM s1
      ),
      upd AS ( SELECT id, (run_sum - LEAST(0, min_run))::int AS bal FROM s2 )
      UPDATE public.token_ledger t
         SET balance_after = u.bal
        FROM upd u
       WHERE t.id = u.id AND t.user_id = $1;
      `,
      [userId]
    );

    console.log(`[PAYPAL] +${delta} Tokens für User ${userId} gutgeschrieben (Order ${orderId}).`);
    return res.redirect('/app/pay-success.html');
  } catch (err) {
    console.error('PayPal capture error:', err);
    return res.redirect('/app/pay-cancel.html');
  }
});

module.exports = router;
