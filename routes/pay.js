// routes/pay.js
const express = require('express');
const router = express.Router();
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');

/**
 * Token-Pakete (Cent-Preise!)
 * Du kannst die Packs nach Bedarf anpassen.
 */
const PACKS = {
  t10k: { tokens: 10000, amount: 999,  name: '10.000 Tokens' },
  t25k: { tokens: 25000, amount: 1999, name: '25.000 Tokens' },
};

// === STRIPE CHECKOUT erzeugen ===
// POST /api/pay/stripe/checkout { pack_id: "t10k" }
router.post('/stripe/checkout', requireAuth, async (req, res) => {
  try {
    const packId = String(req.body?.pack_id || 't10k');
    const pack = PACKS[packId];
    if (!pack) return res.status(400).json({ ok:false, error:'unknown_pack' });

    const successUrl = `${process.env.APP_BASE_URL}/pay-success.html?session_id={CHECKOUT_SESSION_ID}`;
    const cancelUrl  = `${process.env.APP_BASE_URL}/pay-cancel.html`;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [{
        price_data: {
          currency: 'eur',
          product_data: { name: pack.name },
          unit_amount: pack.amount, // in Cent
        },
        quantity: 1,
      }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      metadata: {
        user_id: String(req.user.id),
        token_amount: String(pack.tokens),
        pack_id: packId,
      },
    });

    return res.json({ ok: true, url: session.url });
  } catch (err) {
    console.error('[STRIPE CHECKOUT]', err);
    return res.status(500).json({ ok:false, error:'stripe_error' });
  }
});

// === (optional) Erfolgseite kann Session prüfen ===
// GET /api/pay/stripe/session?session_id=...
router.get('/stripe/session', requireAuth, async (req, res) => {
  try {
    const sid = String(req.query.session_id || '');
    if (!sid) return res.status(400).json({ ok:false, error:'missing_session_id' });
    const session = await stripe.checkout.sessions.retrieve(sid);
    return res.json({ ok:true, session });
  } catch (e) {
    console.error('[STRIPE SESSION]', e);
    return res.status(500).json({ ok:false, error:'stripe_error' });
  }
});

/**
 * ============ WEBHOOK ============
 * Dieser Handler wird aus server.js mit express.raw() gemountet.
 * Export: module.exports.stripeWebhook
 */
async function stripeWebhook(req, res) {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(
      req.body,                       // raw body!
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.warn('[STRIPE WEBHOOK] signature fail:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;

      const userId = Number(session.metadata?.user_id || 0);
      const tokens = Number(session.metadata?.token_amount || 0);

      if (userId > 0 && tokens > 0) {
        // 1) Ledger-Eintrag
        await pool.query(`
          INSERT INTO public.token_ledger (user_id, delta, reason)
          VALUES ($1, $2, 'buy_tokens_stripe')
        `, [userId, tokens]);

        // 2) users.tokens + users.purchased erhöhen
        await pool.query(`
          UPDATE public.users
             SET tokens = tokens + $1,
                 purchased = purchased + $1
           WHERE id = $2
        `, [tokens, userId]);

        console.log(`[STRIPE WEBHOOK] +${tokens} Tokens für User ${userId} gutgeschrieben.`);
      } else {
        console.log('[STRIPE WEBHOOK] fehlendes metadata user_id/token_amount');
      }
    }

    // weitere Events bei Bedarf:
    // else if (event.type === 'payment_intent.payment_failed') { ... }

    return res.json({ received: true });
  } catch (err) {
    console.error('[STRIPE WEBHOOK] handler error:', err);
    return res.status(500).send('handler_error');
  }
}

module.exports = { router, stripeWebhook };
