const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { pool } = require('../db');
const bcrypt = require('bcrypt');

const SALT_ROUNDS = 10;
const WELCOME_TOKENS = Number(process.env.WELCOME_TOKENS || 1000);

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

async function ensureTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password TEXT NOT NULL,
      is_admin BOOLEAN DEFAULT FALSE,
      tokens INTEGER DEFAULT 0,
      purchased INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT NOW()
    );

    ALTER TABLE public.users
      ADD COLUMN IF NOT EXISTS email_verified BOOLEAN DEFAULT false,
      ADD COLUMN IF NOT EXISTS verify_token TEXT;
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS public.password_resets (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
      token_hash TEXT NOT NULL UNIQUE,
      expires_at TIMESTAMPTZ NOT NULL,
      used BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      used_at TIMESTAMPTZ
    );

    ALTER TABLE public.password_resets
      ADD COLUMN IF NOT EXISTS request_ip inet,
      ADD COLUMN IF NOT EXISTS request_ua text,
      ADD COLUMN IF NOT EXISTS request_email text;

    CREATE INDEX IF NOT EXISTS ix_pwres_user_open
      ON public.password_resets(user_id)
      WHERE used = false AND used_at IS NULL;
  `);
}

function setSessionCookie(res, payload) {
  const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
  res.cookie('session', token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
    maxAge: 1000 * 60 * 60 * 24 * 7
  });
}

// === LOGIN ===
router.post('/login', async (req, res) => {
  try {
    await ensureTables();
    const email = (req.body?.email || '').trim().toLowerCase();
    const password = req.body?.password || '';

    if (!email || !password)
      return res.status(400).json({ ok: false, message: 'E-Mail und Passwort erforderlich' });

    const { rows } = await pool.query(
      `SELECT id, email, password, is_admin, email_verified
       FROM public.users
       WHERE lower(email) = $1
       LIMIT 1`, [email]
    );

    const user = rows[0];
    if (!user) return res.status(401).json({ ok: false, message: 'Login fehlgeschlagen' });

    if (!user.email_verified && !user.is_admin) {
  return res.status(403).json({ ok:false, message:'Bitte bestätige zuerst deine E-Mail-Adresse.' });
}

    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ ok: false, message: 'Login fehlgeschlagen' });

    setSessionCookie(res, { id: user.id, is_admin: !!user.is_admin });

    res.json({
      ok: true,
      user: { id: user.id, is_admin: !!user.is_admin },
      redirect: (user.is_admin ? '/admin' : '/app')
    });
  } catch (err) {
    console.error('POST /api/auth/login error', err);
    res.status(500).json({ ok: false, message: 'Serverfehler' });
  }
});

// === SIGNUP mit Double-Opt-In ===
router.post('/signup', async (req, res) => {
  const emailRaw = String(req.body?.email || '').trim().toLowerCase();
  const passRaw = String(req.body?.password || '');

  if (!emailRaw || passRaw.length < 6) {
    return res.status(400).json({ ok: false, message: 'email_or_password_invalid' });
  }

  try {
    const hash = await bcrypt.hash(passRaw, SALT_ROUNDS);
    const verifyToken = crypto.randomBytes(32).toString('hex');

    await pool.query(`
      INSERT INTO public.users (email, password, is_admin, tokens, purchased, created_at, email_verified, verify_token)
      VALUES ($1, $2, false, 0, 0, NOW(), false, $3)
    `, [emailRaw, hash, verifyToken]);

    const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const verifyUrl = `${base}/verify?token=${verifyToken}`;

    // Mail versenden
    if (process.env.SMTP_HOST && process.env.SMTP_USER) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT || 587),
        secure: false, // wichtig: KEIN true, sonst macht er SSL direkt!
        auth: {
          user: process.env.SMTP_USER,
          pass: process.env.SMTP_PASS
        },
        tls: {
          rejectUnauthorized: false // sonst zickt localhost rum
        }
      });

      await transporter.sendMail({
        from: process.env.MAIL_FROM || process.env.SMTP_USER,
        to: emailRaw,
        subject: 'Poker Joker – E-Mail bestätigen',
        text: `Hey! Bitte bestätige deine E-Mail-Adresse mit diesem Link:\n\n${verifyUrl}\n\nViel Spaß beim Zocken!\nDein Poker Joker 🤡🃏`
      }).then(() => {
        console.log('[VERIFY] Bestätigungsmail gesendet an:', emailRaw);
      }).catch(err => {
        console.error('[MAIL ERROR]', err.message || err);
      });
    }

    return res.json({ ok: true, message: 'verification_email_sent' });

  } catch (e) {
    if (e.code === '23505') {
      return res.status(409).json({ ok: false, message: 'E-Mail existiert bereits' });
    }
    console.error('Signup-Fehler:', e);
    return res.status(500).json({ ok: false, message: 'signup_failed' });
  }
});

// === FORGOT PASSWORD ===
router.post('/forgot', async (req, res) => {
  try {
    await ensureTables();
    const email = (req.body?.email || '').trim().toLowerCase();

    const ures = await pool.query(
      'SELECT id,email FROM public.users WHERE lower(email)=$1 LIMIT 1',
      [email]
    );
    if (!ures.rowCount) return res.json({ ok: true });

    const user = ures.rows[0];
    const raw = crypto.randomBytes(32).toString('hex');
    const tokenHash = sha256(raw);
    const expires = new Date(Date.now() + 60 * 60 * 1000);

    await pool.query(`
      UPDATE public.password_resets
         SET used = true,
             used_at = NOW()
       WHERE user_id = $1
         AND used = false
         AND used_at IS NULL
    `, [user.id]);

    const ipStr = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket.remoteAddress || '').trim();
    const ua = req.get('user-agent') || '';

    const ins = await pool.query(`
      INSERT INTO public.password_resets
         (user_id, token_hash, expires_at, used, created_at, request_ip, request_ua, request_email)
       VALUES ($1, $2, $3, false, NOW(), $4::inet, $5, $6)
       RETURNING id
    `, [user.id, tokenHash, expires, ipStr, ua, user.email]);

    const base = process.env.PUBLIC_BASE_URL || req.headers.origin || `${req.protocol}://${req.get('host')}`;
    const resetUrl = `${base}/login/reset.html?token=${raw}`;
    console.log(`[FORGOT] reset_id=${ins.rows[0].id} user=${user.email} ip=${ipStr} link=${resetUrl}`);

    try {
      if (process.env.SMTP_HOST && process.env.SMTP_USER) {
        const transporter = nodemailer.createTransport({
          host: process.env.SMTP_HOST,
          port: Number(process.env.SMTP_PORT || 587),
          secure: !!process.env.SMTP_SECURE,
          auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS
          },
          tls: {
            rejectUnauthorized: false
          }
        });

        await transporter.sendMail({
          from: process.env.MAIL_FROM || process.env.SMTP_USER,
          to: user.email,
          subject: 'Passwort-Zurücksetzen',
          text: `Link (60 Min gültig): ${resetUrl}`
        });
      }
    } catch (mailErr) {
      console.warn('[FORGOT] mail error:', mailErr.message);
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error('[FORGOT] error:', err);
    return res.status(500).json({ ok: false, message: 'Serverfehler' });
  }
});

// === LOGOUT ===
router.post('/logout', (req, res) => {
  res.clearCookie('session', { path: '/' });
  res.json({ ok: true });
});

// === GET /me ===
const requireAuth = require('../middleware/requireAuth');
router.get('/me', requireAuth, (req, res) => {
  res.json({ id: req.user.id });
});

// === PASSWORD ÄNDERN ===
router.post('/password', requireAuth, async (req, res) => {
  try {
    const uid = req.user.id;
    const { current_password, new_password } = req.body || {};
    if (!current_password || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ ok: false, message: 'Passwort zu kurz oder fehlt' });
    }

    const q = await pool.query('SELECT password FROM public.users WHERE id=$1', [uid]);
    const hash = q.rows?.[0]?.password || '';
    const ok = await bcrypt.compare(String(current_password), String(hash));
    if (!ok) return res.status(400).json({ ok: false, message: 'Aktuelles Passwort ist falsch' });

    const newHash = await bcrypt.hash(String(new_password), SALT_ROUNDS);
    await pool.query('UPDATE public.users SET password=$1, updated_at=NOW() WHERE id=$2', [newHash, uid]);

    res.clearCookie('session', { path: '/', httpOnly: true, sameSite: 'lax' });
    res.json({ ok: true, message: 'Passwort geändert. Bitte neu einloggen.' });
  } catch (e) {
    console.error('POST /api/auth/password', e);
    res.status(500).json({ ok: false, message: 'password_change_failed' });
  }
});

// === VERIFY ===
router.get('/verify', async (req, res) => {
  const token = req.query.token;
  if (!token) return res.status(400).send('Token fehlt');

  try {
    const q = await pool.query(`
  UPDATE public.users
     SET email_verified = true,
         verify_token = NULL
   WHERE verify_token = $1
     AND email_verified = false
  RETURNING id
`, [token]);

if (!q.rowCount) {
  return res.send('<h1>Link ungültig oder bereits verwendet</h1>');
}

const userId = q.rows[0].id;

// Willkommensbonus gutschreiben
await pool.query(`
  INSERT INTO token_ledger (user_id, delta, reason)
  VALUES ($1, $2, 'welcome_bonus')
`, [userId, WELCOME_TOKENS]);

await pool.query(`
  UPDATE users SET tokens = tokens + $1 WHERE id = $2
`, [WELCOME_TOKENS, userId]);

    console.log(`[VERIFY] Account bestätigt & ${WELCOME_TOKENS} Tokens gutgeschrieben (User ID ${userId})`);
    res.send('<h2 style="font-family:sans-serif;color:green;">✅ E-Mail bestätigt! Du kannst dich jetzt einloggen.</h2><a href="/login">Zum Login</a>');
  } catch (err) {
    console.error('[VERIFY ERROR]', err);
    res.status(500).send('Fehler bei der Verifizierung');
  }
});

module.exports = router;
