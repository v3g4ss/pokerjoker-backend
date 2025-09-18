const express  = require('express');
const router   = module.exports = express.Router();
const { pool } = require('../db');
const tokenDb = require('../utils/tokenDb');
const env = require('../utils/env');
const { getBotConfig, setBotConfig } = require('../utils/botConfig');

// ganz oben in admin.js einfügen, nach den require-Zeilen:
const toInt = (v) => {
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? null : n;
};

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: env.OPENAI_API_KEY });

const nodemailer = require('nodemailer');
const mailer = nodemailer.createTransport({
  host: env.SMTP_HOST, port: env.SMTP_PORT, secure: env.SMTP_SECURE,
  auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
});

const path = require('path');
const fs   = require('fs');
const fsp  = require('fs/promises');
const multer = require('multer');
const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { ingestOne } = require('../utils/knowledge');   // <-- nur einmal!
const bcrypt = require('bcrypt');  
const SALT_ROUNDS = 10;

// temp-dir + disk storage
const tmpDir = path.join(__dirname, '..', 'uploads_tmp');
try { fs.mkdirSync(tmpDir, { recursive: true }); } catch {}
const storage = multer.diskStorage({
  destination: (_req,_file,cb)=>cb(null, tmpDir),
  filename: (_req,file,cb)=>cb(null, Date.now()+'-'+(file.originalname||'file').replace(/[^\w.\-]+/g,'_')),
});
const okExts  = new Set([
  '.md','.mdx','.txt','.json','.jsonl','.csv','.pdf','.docx','.html','.srt','.vtt','.xlsx',
  '.js','.ts','.jsx','.tsx'          // <— erlauben
]);

const okMimes = new Set([
  'text/plain','text/markdown','text/csv','text/html','application/json',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/msword','application/vnd.ms-excel',
  'text/javascript','application/javascript','application/x-javascript' // <— JS
]);

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 10 },
  fileFilter: (_req, file, cb) => {
    const ext = (path.extname(file.originalname || '').toLowerCase() || '');
    const mime = (file.mimetype || '').toLowerCase();

    // erlauben, wenn Ext passt ODER MIME passt ODER generisch text/*
    const allowed =
      okExts.has(ext) ||
      okMimes.has(mime) ||
      mime.startsWith('text/');

    if (!allowed) {
      console.warn('[upload] blockiert:', file.originalname, { ext, mime });
      return cb(new Error('Dateityp nicht erlaubt'));
    }
    cb(null, true);
  }
});

/* ──────────────────────────────────────────────────────────────
   Helpers
   ────────────────────────────────────────────────────────────── */
async function sendMailOptional(app, to, subject, text) {
  const transporter = app?.locals?.transporter || mailer; // <-- nutze globales mailer
  if (!transporter) return false;
  await transporter.sendMail({
    from: env.MAIL_FROM || env.SMTP_USER || 'no-reply@localhost',
    to, subject, text,
  });
  return true;
}

// optionaler Mailtransport
async function sendMailOptional(app, { to, subject, text }) {
  // 1) bevorzugt app.locals.transporter
  const t = app?.locals?.transporter;
  if (t && typeof t.sendMail === 'function') {
    await t.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, text
    });
    return true;
  }

  // 2) Fallback per ENV
  if (process.env.SMTP_HOST && process.env.SMTP_USER) {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: !!process.env.SMTP_SECURE,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
    });
    await transporter.sendMail({
      from: process.env.MAIL_FROM || process.env.SMTP_USER,
      to, subject, text
    });
    return true;
  }

  // kein Versand konfiguriert -> still ok
  return false;
}

// ============================================================
// KPIs / Stats
// ============================================================
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query(`
      SELECT
        -- Kunden = alle ohne Admin
        (SELECT COUNT(*) FROM public.users WHERE NOT is_admin) AS customers,
        -- Admins separat
        (SELECT COUNT(*) FROM public.users WHERE is_admin) AS admins,

        -- E-Mails
        (SELECT COUNT(*) FROM public.messages) AS messages_total,
        (SELECT COUNT(*) FROM public.messages m
           WHERE NOT EXISTS (
             SELECT 1 FROM public.message_replies r
             WHERE r.message_id = m.id
           )
        ) AS messages_new,

        -- Tokens gekauft (Buy-Ins)
        COALESCE((
          SELECT SUM(delta)::bigint
          FROM public.token_ledger
          WHERE delta > 0 AND LOWER(COALESCE(reason, '')) LIKE 'buy%'
        ), 0) AS purchased,

        -- Admin vergeben (+)
        COALESCE((
          SELECT SUM(delta)::bigint
          FROM public.token_ledger
          WHERE delta > 0 AND LOWER(COALESCE(reason, '')) LIKE 'admin%'
        ), 0) AS admin_granted,

        -- Tokens im Umlauf (Summe user.tokens)
        (SELECT COALESCE(SUM(tokens),0) FROM public.users) AS tokens_in_circulation
    `);

    res.json({ ok: true, ...rows[0] });
  } catch (e) {
    console.error('GET /admin/stats error:', e);
    res.status(500).json({ ok:false, message:'stats_failed' });
  }
});

// Admin setzt Passwort eines Users
// POST /api/admin/users/:id/password  { new_password }
router.post('/users/:id/password', requireAuth, requireAdmin, async (req, res) => {
  try {
    const uid = Number(req.params.id);
    const { new_password } = req.body || {};
    if (!Number.isInteger(uid) || !new_password || String(new_password).length < 6) {
      return res.status(400).json({ ok:false, message:'Ungültige Eingaben' });
    }
    const hash = await bcrypt.hash(String(new_password), SALT_ROUNDS);
    const r = await pool.query(
      'UPDATE public.users SET password=$1, updated_at=NOW() WHERE id=$2 RETURNING id',
      [hash, uid]
    );
    if (!r.rowCount) return res.status(404).json({ ok:false, message:'User nicht gefunden' });
    res.json({ ok:true, user_id: r.rows[0].id });
  } catch (e) {
    console.error('POST /api/admin/users/:id/password', e);
    res.status(500).json({ ok:false, message:'admin_reset_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   USERS – Liste / Suche / Admin-Flag / Tokens
   ────────────────────────────────────────────────────────────── */
// GET /api/admin/users
router.get('/users', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 100);
    const q     = (req.query.q || '').trim();
    const off   = (page - 1) * limit;

    let where = '', params = [];
    if (q) { where = 'WHERE u.email ILIKE $1'; params.push(`%${q}%`); }

    const itemsSql = `
  SELECT
    u.id,
    u.email,
    COALESCE(u.is_admin,false)  AS is_admin,
    COALESCE(u.is_locked,false) AS is_locked,
    COALESCE((
      SELECT tl.balance_after
      FROM public.token_ledger tl
      WHERE tl.user_id = u.id
      ORDER BY tl.id DESC
      LIMIT 1
    ), 0) AS tokens,
    COALESCE((
      SELECT SUM(CASE
        WHEN tl2.delta > 0 AND LOWER(COALESCE(tl2.reason,'')) LIKE '%buy%'
        THEN tl2.delta ELSE 0 END)
      FROM public.token_ledger tl2
      WHERE tl2.user_id = u.id
    ), 0) AS purchased
  FROM public.users u
  ${where ? where + ' AND ' : 'WHERE '} u.deleted_at IS NULL
  ORDER BY u.id ASC
  LIMIT ${limit} OFFSET ${off};
`;

const countSql = `
  SELECT COUNT(*)::int AS count
  FROM public.users u
  ${where ? where + ' AND ' : 'WHERE '} u.deleted_at IS NULL;
`;

    const [items, cnt] = await Promise.all([
      pool.query(itemsSql, params),
      pool.query(countSql, params),
    ]);

    return res.json({
      ok: true,
      page, limit,
      total: cnt.rows[0]?.count || 0,
      items: items.rows || [],
    });
  } catch (e) {
    console.error('GET /api/admin/users', e);
    return res.status(500).json({ ok:false, message: 'Fehler bei users' });
  }
});

// POST /api/admin/users/:id/admin   { is_admin }
router.post('/users/:id/admin', async (req, res) => {
  try {
    const id = toInt(req.params.id);
    const is_admin = !!req.body?.is_admin;
    await pool.query('UPDATE public.users SET is_admin=$1 WHERE id=$2', [is_admin, id]);
    res.json({ ok:true });
  } catch (e) {
    console.error('POST /api/admin/users/:id/admin', e);
    res.json({ ok:false });
  }
});

// POST /api/admin/users  → neuen User anlegen
router.post('/users', requireAuth, requireAdmin, async (req, res) => {
  try {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const is_admin = !!req.body?.is_admin;

    if (!email || !password) {
      return res.status(400).json({ ok:false, message:'email & password erforderlich' });
    }

    const hash = await bcrypt.hash(password, SALT_ROUNDS);

    const ins = await pool.query(
      `INSERT INTO public.users (email, password, is_admin, is_locked, tokens, purchased, created_at, updated_at)
       VALUES ($1,$2,$3,false,0,0,NOW(),NOW())
       RETURNING id, email, is_admin, is_locked`,
      [email, hash, is_admin]
    );

    res.json({ ok:true, user: ins.rows[0] });
  } catch (e) {
    console.error('POST /api/admin/users', e);
    if (String(e.message||'').includes('duplicate key')) {
      return res.status(409).json({ ok:false, message:'E-Mail bereits vorhanden' });
    }
    res.status(500).json({ ok:false, message:'create_failed' });
  }
});

// POST /api/admin/users/:id/lock
router.post('/users/:id/lock', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const locked = !!req.body?.locked;
    await pool.query('UPDATE public.users SET is_locked=$1 WHERE id=$2', [locked, id]);
    res.json({ ok:true });
  } catch (e) {
    console.error('POST /api/admin/users/:id/lock', e);
    res.status(500).json({ ok:false, message:'lock_failed' });
  }
});

// DELETE /api/admin/users/:id  (soft delete)
router.delete('/users/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    const suffix = `.deleted.${Date.now()}_${id}@example.invalid`;
    await pool.query(`
      UPDATE public.users
         SET is_locked = true,
             deleted_at = NOW(),
             email = CONCAT('deleted_user_', id, '${suffix}')
       WHERE id = $1
    `, [id]);
    res.json({ ok:true });
  } catch (e) {
    console.error('DELETE /api/admin/users/:id', e);
    res.status(500).json({ ok:false, message:'delete_failed' });
  }
});

/* ──────────────────────────────────────────────────────────────
   TOKENS – Adjust + Balance + Ledger + Summary
   ────────────────────────────────────────────────────────────── */
// POST /api/admin/tokens/adjust  { userId, delta, reason }
router.post('/tokens/adjust', async (req, res) => {
  try {
    const userId = toInt(req.body?.userId);
    const delta  = toInt(req.body?.delta);
    const reason = String(req.body?.reason || '').slice(0,200) || 'admin-adjust';
    if (!Number.isInteger(userId) || !Number.isInteger(delta))
      return res.status(400).json({ ok:false, message:'userId & delta müssen Integer sein' });

    if (delta === 0) {
      const cur = await tokenDb.getTokens(userId);
      return res.json({ ok:true, userId, balance: cur.balance ?? 0 });
    }
    if (delta > 0) await tokenDb.buyTokens(userId, delta, reason);
    else await tokenDb.consumeTokens(userId, Math.abs(delta), reason);

    const after = await tokenDb.getTokens(userId);
    res.json({ ok:true, userId, balance: after.balance ?? 0 });
  } catch (e) {
    console.error('POST /api/admin/tokens/adjust', e);
    res.status(500).json({ ok:false, message:'Adjust fehlgeschlagen' });
  }
});

// GET /api/admin/users/:id/balance
router.get('/users/:id/balance', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ ok:false, message:'Ungültige ID' });

    try {
      const cur = await tokenDb.getTokens(userId);
      return res.json({ ok:true, balance: cur.balance ?? 0 });
    } catch {}

    const { rows } = await pool.query(
      `SELECT balance_after
         FROM public.token_ledger
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT 1`,
      [userId]
    );
    res.json({ ok:true, balance: rows[0]?.balance_after ?? 0 });
  } catch (e) {
    console.error('GET /api/admin/users/:id/balance', e);
    res.status(500).json({ ok:false, message:'Fehler beim Laden der Balance' });
  }
});

// GET /api/admin/ledger/user/:id
router.get('/ledger/user/:id', async (req, res) => {
  try {
    const userId = toInt(req.params.id);
    if (!Number.isInteger(userId)) return res.status(400).json({ ok:false, message:'Ungültige ID' });

    const { rows } = await pool.query(
      `SELECT id, user_id, delta, reason, balance_after, created_at
         FROM public.token_ledger
        WHERE user_id = $1
        ORDER BY id DESC
        LIMIT 200`,
      [userId]
    );
    res.json(rows || []);
  } catch (e) {
    console.error('GET /api/admin/ledger/user/:id', e);
    res.status(500).json({ ok:false, message:'Fehler beim Laden des Ledgers' });
  }
});

// GET /api/admin/ledger/last200
router.get('/ledger/last200', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT id, user_id, delta, reason, balance_after, created_at
         FROM public.token_ledger
        ORDER BY id DESC
        LIMIT 200`
    );
    res.json(rows || []);
  } catch (e) {
    console.error('GET /api/admin/ledger/last200', e);
    res.status(500).json({ ok:false, message:'Fehler beim Laden der letzten Einträge' });
  }
});

// GET /api/admin/summary
router.get('/summary', async (_req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT
         tl.user_id,
         SUM(CASE WHEN tl.delta > 0 THEN tl.delta ELSE 0 END)  AS in_sum,
         SUM(CASE WHEN tl.delta < 0 THEN -tl.delta ELSE 0 END) AS out_sum,
         SUM(CASE WHEN LOWER(COALESCE(tl.reason,'')) LIKE '%buy%' THEN tl.delta ELSE 0 END) AS purchased,
         MAX(tl.balance_after) AS balance
       FROM public.token_ledger tl
       GROUP BY tl.user_id
       ORDER BY tl.user_id ASC`
    );
    res.json(rows || []);
  } catch (e) {
    console.error('GET /api/admin/summary', e);
    res.status(500).json({ ok:false, message:'Fehler beim Laden der Summary' });
  }
});

// Live-Konfig holen
router.get('/bot/config', async (req, res) => {
  const cfg = await getBotConfig();
  res.json({ ok:true, cfg });
});

// Live-Konfig setzen (erzieht den Bot!)
router.post('/bot/config', async (req, res) => {
  const { system_prompt='', temperature=0.3, model='gpt-4o-mini' } = req.body || {};
  if (!system_prompt.trim()) return res.status(400).json({ ok:false, message:'Prompt fehlt' });
  await setBotConfig({
    system_prompt: String(system_prompt).slice(0, 20000),
    temperature: Number(temperature),
    model: String(model)
  }, req.user?.id || null);
  const cfg = await getBotConfig();
  res.json({ ok:true, cfg });
});

// Optional: Rollback auf Version X
router.post('/bot/rollback', async (req, res) => {
  const ver = Number(req.body?.version);
  if (!Number.isInteger(ver)) return res.status(400).json({ ok:false, message:'Version fehlt' });
  const { rows } = await pool.query('SELECT * FROM bot_settings_history WHERE version=$1', [ver]);
  const h = rows[0]; if (!h) return res.status(404).json({ ok:false, message:'Version nicht gefunden' });
  await setBotConfig({ system_prompt:h.system_prompt, temperature:h.temperature, model:h.model }, req.user?.id || null);
  res.json({ ok:true });
});

/* ──────────────────────────────────────────────────────────────
   MESSAGES – Liste / Detail / Reply / Replies
   ────────────────────────────────────────────────────────────── */
// GET /api/admin/messages?page=&limit=&q=
router.get('/messages', async (req, res) => {
  try {
    const page  = Math.max(parseInt(req.query.page || '1', 10), 1);
    const limit = Math.min(Math.max(parseInt(req.query.limit || '10', 10), 1), 200);
    const off   = (page - 1) * limit;
    const q     = (req.query.q || '').trim();

    const where = [];
    const params = [];

    if (q) {
      params.push(`%${q}%`);
      // Suche über Betreff/Name/Email
      where.push(`(m.subject ILIKE $${params.length} OR m.name ILIKE $${params.length} OR m.email ILIKE $${params.length})`);
    }
    const W = where.length ? `WHERE ${where.join(' AND ')}` : '';

    // Anzahl
    const total = await pool.query(`SELECT COUNT(*)::int AS n FROM public.messages m ${W}`, params);

    // Paging-Parameter anhängen
    params.push(limit, off);

    // Liste: user_id via LEFT JOIN auf users.email, + letztes Antwort-Datum
    const items = await pool.query(`
      SELECT
        m.id,
        u.id AS user_id,                 -- aus users ermittelt
        m.name,
        m.email,
        m.subject,
        m.message,
        m.created_at,
        (SELECT MAX(r.sent_at)
           FROM public.message_replies r
          WHERE r.message_id = m.id) AS last_reply_at
      FROM public.messages m
      LEFT JOIN public.users u
        ON lower(u.email) = lower(m.email)
      ${W}
      ORDER BY m.created_at DESC
      LIMIT $${params.length - 1} OFFSET $${params.length}
    `, params);

    res.json({ ok: true, total: total.rows[0]?.n || 0, items: items.rows || [] });
  } catch (err) {
    console.error('GET /api/admin/messages', err);
    res.status(500).json({ ok: false, message: 'Serverfehler' });
  }
});

// GET /api/admin/messages/:id
router.get('/messages/:id', async (req,res)=>{
  try{
    const { rows } = await pool.query(`
      SELECT id, name, email, subject, message, created_at
      FROM public.messages WHERE id = $1
    `,[req.params.id]);
    if (!rows[0]) return res.status(404).json({ ok:false, message:'Not found' });
    res.json({ ok:true, item: rows[0] });
  }catch(e){
    console.error(e); res.status(500).json({ ok:false, message:'Serverfehler' });
  }
});

// POST /api/admin/messages/:id/reply  { body }
router.post('/messages/:id/reply', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) {
      return res.status(400).json({ ok:false, message:'Ungültige ID' });
    }

    const body = (req.body?.body || '').toString().trim();
    if (!body) {
      return res.status(400).json({ ok:false, message:'Antworttext fehlt' });
    }

    // ursprüngliche Nachricht holen (für Empfänger/Betreff)
    const msg = await pool.query(
      'SELECT email, subject FROM public.messages WHERE id = $1 LIMIT 1',
      [id]
    );
    if (!msg.rows[0]) {
      return res.status(404).json({ ok:false, message:'Nachricht nicht gefunden' });
    }
    const to = msg.rows[0].email;
    const subject = 'Re: ' + (msg.rows[0].subject || '');

    // Replies-Tabelle sicherstellen
    await pool.query(`
      CREATE TABLE IF NOT EXISTS public.message_replies (
        id SERIAL PRIMARY KEY,
        message_id INT NOT NULL REFERENCES public.messages(id) ON DELETE CASCADE,
        to_email TEXT,
        subject  TEXT,
        body     TEXT,
        sent_at  TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // optional Mail senden (nicht fatal, wenn es fehlschlägt)
    try {
      await req.app?.locals?.transporter?.sendMail({
        from: process.env.SMTP_USER || 'no-reply@localhost',
        to, subject, text: body
      });
    } catch (mailErr) {
      console.warn('[reply] sendMail failed:', mailErr.message);
    }

    // Reply speichern
    const ins = await pool.query(
      `INSERT INTO public.message_replies (message_id, to_email, subject, body)
       VALUES ($1,$2,$3,$4) RETURNING id, sent_at`,
      [id, to, subject, body]
    );

    return res.json({ ok:true, reply_id: ins.rows[0].id, sent_at: ins.rows[0].sent_at });
  } catch (e) {
    console.error('POST /api/admin/messages/:id/reply', e);
    return res.status(500).json({ ok:false, message:'reply failed' });
  }
});

// GET /api/admin/messages/:id/replies
router.get('/messages/:id/replies', async (req, res) => {
  try {
    const id = Number.parseInt(req.params.id, 10);
    if (!Number.isInteger(id)) return res.status(400).json({ ok:false, message:'Ungültige ID' });
    const { rows } = await pool.query(
      `SELECT id, to_email, subject, body, sent_at
         FROM public.message_replies
        WHERE message_id=$1
        ORDER BY COALESCE(sent_at, '1970-01-01'::timestamp) ASC, id ASC`,
      [id]
    );
    res.json({ ok:true, items: rows || [] });
  } catch (e) {
    console.error('GET /api/admin/messages/:id/replies', e);
    res.status(500).json({ ok:false });
  }
});

// ...
router.post('/prompt/test', async (req, res) => {
  try {
    const system_prompt = String(req.body?.system_prompt || '').slice(0, 20000);
    const temperature   = Number(req.body?.temperature ?? 0.3);
    const model         = String(req.body?.model || 'gpt-4o-mini');
    const userMsg       = String(req.body?.user || 'Test: Sag kurz Hallo.');

    if (!system_prompt.trim()) return res.status(400).json({ ok:false, message:'Prompt fehlt' });

    const completion = await openai.chat.completions.create({
      model,
      temperature,
      messages: [
        { role: 'system', content: system_prompt },
        { role: 'user', content: userMsg }
      ],
      max_tokens: 500
    });

    const reply = completion.choices?.[0]?.message?.content || '';
    return res.json({ ok:true, reply });
  } catch (e) {
    console.error('POST /api/admin/prompt/test', e);
    return res.status(500).json({ ok:false, message:'LLM-Fehler' });
  }
});

// Live-Konfig holen
router.get('/bot/config', async (req, res) => {
  const cfg = await getBotConfig();
  res.json({ ok:true, cfg });
});

// Live-Konfig setzen
router.post('/bot/config', async (req, res) => {
  const { system_prompt='', temperature=0.3, model='gpt-4o-mini' } = req.body || {};
  if (!system_prompt.trim()) return res.status(400).json({ ok:false, message:'Prompt fehlt' });
  await setBotConfig({
    system_prompt: String(system_prompt).slice(0, 20000),
    temperature: Number(temperature),
    model: String(model)
  }, req.user?.id || null);
  const cfg = await getBotConfig();
  res.json({ ok:true, cfg });
});

// (Optional) Rollback
router.post('/bot/rollback', async (req, res) => {
  const ver = Number(req.body?.version);
  if (!Number.isInteger(ver)) return res.status(400).json({ ok:false, message:'Version fehlt' });
  const { rows } = await pool.query('SELECT * FROM bot_settings_history WHERE version=$1', [ver]);
  const h = rows[0]; if (!h) return res.status(404).json({ ok:false, message:'Version nicht gefunden' });
  await setBotConfig({ system_prompt:h.system_prompt, temperature:h.temperature, model:h.model }, req.user?.id || null);
  res.json({ ok:true });
});

// === Knowledge: Upload (multi), Liste, Preview, Delete, Reindex, Toggle ===

// Upload: multipart form (files[]), plus title, category, tags (kommagetrennt)
router.post('/knowledge/upload', upload.array('files', 10), async (req, res) => {
  try {
    const category = (req.body?.category || '').trim() || null;
    const tags = (req.body?.tags || '').split(',').map(s => s.trim()).filter(Boolean);
    const title = (req.body?.title || '').slice(0, 200);

    const results = [];
    for (const f of (req.files || [])) {
      try {
        const buf = await fsp.readFile(f.path);
        const r = await ingestOne({
          buffer: buf,
          filename: f.originalname,
          mime: f.mimetype,
          category,
          tags,
          title: title || f.originalname
        });
        results.push({ file: f.originalname, ...r });
      } catch (e) {
        results.push({ file: f.originalname, error: e.message || 'Fehler' });
      } finally {
        try { await fsp.unlink(f.path); } catch {}
      }
    }

    const added = results.filter(x => !x.error && !x.skipped).length;
    res.json({ ok: true, added, items: results });
  } catch (e) {
    console.error('POST /api/admin/knowledge/upload', e);
    res.status(400).json({ ok:false, message: e.message || 'Upload fehlgeschlagen' });
  }
});

// Liste / Suche / Filter
// GET /api/admin/knowledge/list?q=&cat=
// LISTE: Knowledge-Dokumente (Suche + optional Kategorie)
router.get('/knowledge/list', async (req, res) => {
  try {
    const qRaw  = String(req.query.q || '').trim();
    const cat   = String(req.query.cat || '').trim();
    const likeQ = qRaw ? `%${qRaw}%` : '';

    const params = [];
    let where = '1=1';

    if (qRaw) {
      params.push(likeQ);
      const i = params.length;
      // Titel / Dateiname / Kategorie / Tags (tags ist text[]!)
      where += ` AND (
        kd.title    ILIKE $${i} OR
        kd.filename ILIKE $${i} OR
        kd.category ILIKE $${i} OR
        EXISTS (SELECT 1 FROM unnest(kd.tags) t WHERE t ILIKE $${i})
      )`;
    }

    if (cat) {
      params.push(cat);
      where += ` AND kd.category = $${params.length}`;
    }

    const sql = `
      SELECT kd.id, kd.title, kd.filename, kd.category, kd.tags, kd.enabled, kd.priority
      FROM knowledge_docs kd
      WHERE ${where}
      ORDER BY kd.id DESC
      LIMIT 500;
    `;

    const { rows } = await pool.query(sql, params);
    res.json({ ok: true, items: rows });
  } catch (e) {
    console.error('GET /knowledge/list error:', e);
    res.status(500).json({ ok:false, message:'List-Fehler' });
  }
});

// PREVIEW
router.get('/knowledge/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query('SELECT title, content FROM knowledge_docs WHERE id=$1', [id]);
    const preview = rows[0]?.content?.slice(0, 2000) || '';
    res.json({ ok:true, preview });
  } catch (e) {
    console.error('GET /knowledge/:id', e);
    res.status(500).json({ ok:false, message:'Preview-Fehler' });
  }
});

// ENABLE / DISABLE
router.post('/knowledge/:id/enable', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    // Body kann "true/false" oder "0/1" sein — robust casten:
    const enabled = !!(req.body?.enabled ?? true);
    const { rows } = await pool.query(
      'UPDATE knowledge_docs SET enabled=$1 WHERE id=$2 RETURNING id, enabled',
      [enabled, id]
    );
    if (!rows[0]) return res.status(404).json({ ok:false, message:'Nicht gefunden' });
    res.json({ ok:true, item: rows[0] });
  } catch (e) {
    console.error('POST /knowledge/:id/enable', e);
    res.status(500).json({ ok:false, message:'Enable-Fehler' });
  }
});

// DELETE
router.delete('/knowledge/:id', async (req, res) => {
  const client = await pool.connect();
  try {
    const id = parseInt(req.params.id, 10);
    await client.query('BEGIN');
    await client.query('DELETE FROM knowledge_chunks WHERE doc_id=$1', [id]);
    await client.query('DELETE FROM knowledge_docs   WHERE id=$1', [id]);
    await client.query('COMMIT');
    res.json({ ok:true });
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('DELETE /knowledge/:id', e);
    res.status(500).json({ ok:false, message:'Delete-Fehler' });
  } finally {
    client.release();
  }
});

// REINDEX: Suchindex neu aufbauen
router.post('/knowledge/reindex', async (_req, res) => {
  try {
    // TS Vector in allen Chunks neu berechnen – mit der Textkonfiguration 'simple'
    await pool.query(`
      UPDATE knowledge_chunks
      SET tsv = to_tsvector('simple', coalesce(text, ''))
    `);

    res.json({ ok:true });
  } catch (e) {
    console.error('POST /knowledge/reindex', e);
    res.status(500).json({ ok:false, message:'Reindex-Fehler' });
  }
});

// === Tokens anpassen ===
router.post('/users/:id/tokens', requireAdmin, async (req, res) => {
  try {
    const userId = parseInt(req.params.id, 10);
    const { delta, reason } = req.body || {};
    if (!Number.isInteger(userId) || !Number.isInteger(delta)) {
      return res.status(400).json({ ok: false, message: 'Ungültige Daten' });
    }

    let result;
    const reasonText = (reason || '').toString().trim() || 'admin-adjust';

    if (delta > 0) {
      // Tokens hinzufügen
      result = await tokenDb.buyTokens(userId, delta, reasonText);
    } else {
      // Tokens abziehen
      result = await tokenDb.consumeTokens(userId, Math.abs(delta), reasonText);
    }

    return res.json({ ok: true, balance: result.balance });
  } catch (err) {
    console.error('❌ Token-Anpassung fehlgeschlagen:', err);
    return res.status(500).json({ ok: false, message: 'Serverfehler beim Token-Update' });
  }
});

module.exports = router;
