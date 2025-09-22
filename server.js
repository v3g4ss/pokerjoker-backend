// =========================== server.js (hardened clean) ===========================

const express = require('express');
const cors = require('cors');
require('dotenv').config();
const path = require('path');
const cookieParser = require('cookie-parser');
const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const http = require('http');

const { pool } = require('./db');
const requireAuth  = require('./middleware/requireAuth');
const requireAdmin = require('./middleware/requireAdmin');

// Router
const authRouter  = require('./routes/auth');
const adminMenuRoutes = require('./routes/admin-menu');
const chatRoutes      = require('./routes/chat');
const pay             = require('./routes/pay');      // { router, stripeWebhook }
const paypalRouter    = require('./routes/paypal');   // eigene PayPal-Route

const app = express();
app.set('trust proxy', 1); // wenn hinter Proxy/NGINX

/* =======================================================================
 * 1) STRIPE WEBHOOK — MUSS VOR express.json() (raw body!)
 * ======================================================================= */
app.post(
  '/api/pay/stripe/webhook',
  express.raw({ type: 'application/json' }),
  pay.stripeWebhook
);

/* =======================================================================
 * 2) Basis-Middleware
 * ======================================================================= */
app.use(cookieParser());
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: '1mb' })); // Body-Limit gegen Leaks/Crashes

// einfache Request-Timeouts (Antwort nach X ms abbrechen)
app.use((req, res, next) => {
  res.setTimeout(15000, () => {
    if (!res.headersSent) res.status(503).json({ ok: false, error: 'timeout' });
  });
  next();
});

/* =======================================================================
 * 3) Payments
 * ======================================================================= */
app.use('/api/pay', pay.router);   // Stripe Checkout etc.
app.use('/api/pay', paypalRouter); // PayPal Checkout

/* =======================================================================
 * 4) ADMIN API (Reihenfolge wichtig: prompt zuerst)
 * ======================================================================= */
app.use('/api/admin', require('./routes/admin-prompt'));   // Prompt Playground + Test
app.use('/api/admin', require('./routes/admin'));           // /stats, /users, /summary, ...
app.use('/api/admin', require('./routes/admin-bot'));       // /bot/config ...
app.use('/api/admin', require('./routes/admin-kb'));        // /kb/docs ...
app.use('/api/admin', require('./routes/admin-messages'));  // /messages ...
app.use('/api/admin', adminMenuRoutes);                     // /editor ... (admin-menu)

/* =======================================================================
 * 5) Öffentliche API (für eingeloggte User)
 * ======================================================================= */
app.use('/api', chatRoutes);                       // Chat
app.use('/api', require('./routes/menu'));         // Menüeinträge (public)
app.use('/api', require('./routes/messages'));     // Kontakt-/System-Messages
app.use('/api/tokens', require('./routes/tokens')); // Token-API

/* =======================================================================
 * 6) Auth (einmalig mounten mit Session-Helfer)
 * ======================================================================= */
app.use(
  '/api/auth',
  (req, res, next) => {
    req.setSessionCookie = (payload) => {
      const token = jwt.sign(payload, process.env.JWT_SECRET, { expiresIn: '7d' });
      res.cookie('session', token, {
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        path: '/',
        maxAge: 1000 * 60 * 60 * 24 * 7,
      });
    };
    next();
  },
  authRouter
);
app.use('/api/password', require('./routes/password'));

/* =======================================================================
 * 7) Static Files & Seiten
 * ======================================================================= */
app.use(express.static(path.join(__dirname, 'public')));
app.use('/app', express.static(path.join(__dirname, 'public', 'app')));

app.get('/', (req, res) => {
  res.redirect('/app');
});

app.get('/admin', requireAuth, requireAdmin, (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'admin.html'))
);
app.get('/app', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'app', 'index.html'))
);

/* =======================================================================
 * 8) Mail & Kontakt
 * ======================================================================= */
const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  tls: { rejectUnauthorized: false },
});

let smtpReady = false;
transporter.verify()
  .then(() => { smtpReady = true; console.log('✅ Mail-Transport bereit'); })
  .catch(err => { smtpReady = false; console.warn('⚠️ Mail-Transport NICHT bereit:', err.message); });

app.locals.transporter = transporter;

app.post('/contact', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ success: false, message: 'Bitte alle Felder ausfüllen.' });
    }

    await pool.query(
      `INSERT INTO public.messages(name,email,subject,message,created_at)
       VALUES ($1,$2,$3,$4,now())`,
      [name, email, subject, message]
    );

    if (smtpReady && process.env.CONTACT_RECEIVER) {
      try {
        await transporter.sendMail({
          from: `"${name}" <${email}>`,
          to: process.env.CONTACT_RECEIVER,
          subject,
          text: message,
        });
      } catch (e) {
        console.warn('⚠️ Mail konnte nicht gesendet werden:', e.message);
      }
    }

    res.json({ success: true, message: 'Nachricht erfolgreich gesendet!' });
  } catch (err) {
    console.error('Kontakt-Fehler:', err);
    res.status(500).json({ success: false, message: 'Senden fehlgeschlagen!' });
  }
});

/* =======================================================================
 * 9) Logout (zwei Endpunkte kompatibel halten)
 * ======================================================================= */
const doLogout = (req, res) => {
  const cookieOpts = {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  };
  res.clearCookie('session', cookieOpts);
  res.clearCookie('sid', cookieOpts);
  res.json({ ok: true });
};
app.post('/api/logout', doLogout);
app.post('/api/auth/logout', doLogout);

// 🔥 Fallback für alle /api-Routen, die nicht gefunden wurden
app.all('/api/*', (req, res) => {
  res.status(404).json({ ok: false, error: `API '${req.originalUrl}' nicht gefunden.` });
});

/* =======================================================================
 * 10) Error-Handler (ganz unten vor Start)
 * ======================================================================= */
app.use((err, _req, res, _next) => {
  console.error('UNCAUGHT ERROR:', (err && err.stack) || err);
  if (!res.headersSent) {
    res.status(err?.status || 500).json({ ok:false, error: err?.message || 'Serverfehler' });
  }
});

/* =======================================================================
 * 11) Start + Server-Timeouts + Graceful Shutdown
 * ======================================================================= */
const PORT = process.env.PORT || 5000;
const server = http.createServer(app);

// sinnvolle Defaults gegen hängende Verbindungen
server.keepAliveTimeout = 65000;   // > Heroku/NGINX idle
server.headersTimeout   = 70000;   // > keepAliveTimeout
server.requestTimeout   = 20000;   // 20s pro Request

server.listen(PORT, () => console.log(`🎯 Server läuft auf Port ${PORT}`));

// global handlers
process.on('unhandledRejection', err => console.error('UNHANDLED', err));
process.on('uncaughtException', err => console.error('UNCAUGHT', err));

const shutdown = async (sig) => {
  try {
    console.log(`\n🧹 ${sig}: Graceful shutdown…`);
    server.close(() => { /* no new connections */ });
    try { await pool.end(); } catch (e) { console.warn('pool.end() warn:', e?.message); }
    process.exit(0);
  } catch (e) {
    console.error('Shutdown error:', e);
    process.exit(1);
  }
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
