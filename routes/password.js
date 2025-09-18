// routes/password.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
const { pool } = require('../db');

// --- Helpers ---
const sha256 = s => crypto.createHash('sha256').update(s).digest('hex');

function makeTransport() {
  const secureByPort = String(process.env.SMTP_PORT) === '465';
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: (process.env.SMTP_SECURE === 'true') || secureByPort,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    tls: { rejectUnauthorized: false },
  });
}

// Optional – nur falls Tabelle fehlt (sonst No-Op)
async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      request_ip inet,
      request_ua text,
      request_email text
    );
    CREATE INDEX IF NOT EXISTS idx_password_resets_user_id ON public.password_resets(user_id);
    CREATE INDEX IF NOT EXISTS idx_password_resets_token_hash ON public.password_resets(token_hash);
  `);
}

// --- 1) Reset-Link anfordern (keine User-Enumeration) ---
router.post('/request', async (req, res) => {
  const client = await pool.connect();
  try {
    await ensureTables();
    const email = (req.body?.email || '').trim().toLowerCase();
    if (!email) return res.status(400).json({ ok: false, message: 'E-Mail fehlt' });

    const u = await pool.query(
      `SELECT id, email FROM public.users WHERE LOWER(email) = $1 LIMIT 1`,
      [email]
    );
    if (!u.rows[0]) {
      // Immer "ok", um Enumeration zu vermeiden
      return res.json({ ok: true, message: 'Wenn die E-Mail existiert, wurde ein Link verschickt.' });
    }

    const userId   = u.rows[0].id;
    const token    = crypto.randomBytes(24).toString('hex');
    const tokenHash= sha256(token);

    // --- Transaktion: offenen Reset löschen -> neuen anlegen ---
    await client.query('BEGIN');
    await client.query(
      `DELETE FROM public.password_resets
       WHERE user_id = $1 AND used_at IS NULL`,
      [userId]
    );
    await client.query(
      `INSERT INTO public.password_resets
         (user_id, token_hash, expires_at, request_ip, request_ua, request_email)
       VALUES
         ($1, $2, NOW() + INTERVAL '60 minutes', $3, $4, $5)`,
       [userId, tokenHash, req.ip, req.headers['user-agent'] || null, email]
    );
    await client.query('COMMIT');

    const base = `${req.protocol}://${req.get('host')}`;
    const link = `${base}/login/reset.html?token=${encodeURIComponent(token)}`;

    // Mail versenden (mit sauberem Return-Path)
    try {
      const t = makeTransport();
      await t.sendMail({
        from:    process.env.MAIL_FROM || process.env.SMTP_USER,    // Header-From
        to:      u.rows[0].email,
        replyTo: process.env.MAIL_FROM || process.env.SMTP_USER,
        envelope: { from: process.env.SMTP_USER, to: u.rows[0].email }, // Return-Path
        subject: 'Poker Joker – Passwort zurücksetzen',
        text:    `Hi! Hier ist dein Link (60 Min. gültig): ${link}`,
        html:    `<p>Hi!</p><p>Hier ist dein Link (60 Min. gültig):</p><p><a href="${link}">${link}</a></p>`
      });
      return res.json({ ok: true, message: 'Link verschickt.' });
    } catch (err) {
  console.error('SMTP error', err);
  // Dev-Fallback: Link nur im Development zurückgeben + loggen
  if (process.env.NODE_ENV === 'development') {
    console.log('DEV Reset-Link:', link);
    return res.json({ ok: true, message: 'Link erzeugt (Mail fehlgeschlagen).', link });
  }
  // In Prod keinen Link leaken
  return res.json({ ok: true, message: 'Link erzeugt.' });
}
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('POST /api/password/request', err);
    res.status(500).json({ ok: false, message: 'Serverfehler' });
  } finally {
    client.release();
  }
});

// --- 2) Token prüfen ---
router.get('/check', async (req, res) => {
  try {
    const token = (req.query?.token || '').trim();
    if (!token) return res.json({ ok: false, reason: 'missing' });

    const row = await pool
      .query(
        `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at, u.email
         FROM public.password_resets pr
         JOIN public.users u ON u.id = pr.user_id
         WHERE pr.token_hash = $1`,
        [sha256(token)]
      )
      .then(r => r.rows[0]);

    if (!row) return res.json({ ok: false, reason: 'notfound' });
    if (row.used_at) return res.json({ ok: false, reason: 'used' });
    if (new Date(row.expires_at).getTime() < Date.now())
      return res.json({ ok: false, reason: 'expired' });

    res.json({ ok: true, email: row.email });
  } catch (err) {
    console.error('GET /api/password/check', err);
    res.status(500).json({ ok: false, message: 'Serverfehler' });
  }
});

// --- 3) Passwort setzen ---
router.post('/reset', async (req, res) => {
  try {
    const token = (req.body?.token || '').trim();
    const password = (req.body?.password || '').trim();
    if (!token) return res.status(400).json({ ok: false, message: 'Token fehlt' });
    if (!password || password.length < 8)
      return res.status(400).json({ ok: false, message: 'Passwort zu kurz (min. 8 Zeichen).' });

    const pr = await pool
      .query(
        `SELECT id, user_id, expires_at, used_at
         FROM public.password_resets
         WHERE token_hash = $1`,
        [sha256(token)]
      )
      .then(r => r.rows[0]);

    if (!pr) return res.status(400).json({ ok: false, message: 'Ungültiger Link.' });
    if (pr.used_at) return res.status(400).json({ ok: false, message: 'Link bereits benutzt.' });
    if (new Date(pr.expires_at).getTime() < Date.now())
      return res.status(400).json({ ok: false, message: 'Link ist abgelaufen.' });

    const hash = await bcrypt.hash(password, 12);
    await pool.query(`UPDATE public.users SET password = $1 WHERE id = $2`, [hash, pr.user_id]);
    await pool.query(`UPDATE public.password_resets SET used_at = NOW() WHERE id = $1`, [pr.id]);

    res.json({ ok: true, message: 'Passwort geändert.' });
  } catch (err) {
    console.error('POST /api/password/reset', err);
    res.status(500).json({ ok: false, message: 'Serverfehler' });
  }
});

module.exports = router;
