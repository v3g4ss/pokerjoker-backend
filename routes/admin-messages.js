// routes/admin-messages.js
const express = require('express');
const router = express.Router();

const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pool }     = require('../db');

// GET /api/admin/messages?page=&limit=&q=
router.get('/messages', requireAuth, requireAdmin, async (req, res) => {
  try {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 10));
    const q     = (req.query.q || '').trim();

    const params = [];
    let whereSql = '';
    if (q) {
      params.push(`%${q}%`);
      whereSql = `WHERE (m.name ILIKE $1 OR m.email ILIKE $1 OR m.subject ILIKE $1 OR m.message ILIKE $1)`;
    }

    const cnt = await pool.query(`SELECT COUNT(*)::int AS total FROM messages m ${whereSql}`, params);
    const total = cnt.rows[0]?.total || 0;

    params.push(limit, (page - 1) * limit);
    const items = await pool.query(`
      SELECT m.*,
             (SELECT MAX(r.sent_at) FROM message_replies r WHERE r.message_id = m.id) AS last_reply_at
      FROM messages m
      ${whereSql}
      ORDER BY m.created_at DESC
      LIMIT $${params.length-1} OFFSET $${params.length}
    `, params);

    res.json({ ok:true, items: items.rows, total });
  } catch (err) {
    console.error('Admin messages list error:', err);
    res.status(500).json({ ok:false, error:'Fehler beim Laden' });
  }
});

// GET /api/admin/messages/:id
router.get('/messages/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = +req.params.id;
    const r = await pool.query(`SELECT * FROM messages WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ ok:false, error:'Nicht gefunden' });
    res.json({ ok:true, item:r.rows[0] });
  } catch (err) {
    console.error('Admin message detail error:', err);
    res.status(500).json({ ok:false, error:'Fehler beim Laden' });
  }
});

// GET /api/admin/messages/:id/replies
router.get('/messages/:id/replies', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = +req.params.id;
    const r = await pool.query(
      `SELECT * FROM message_replies WHERE message_id=$1 ORDER BY sent_at NULLS FIRST, id ASC`, [id]
    );
    res.json({ ok:true, items:r.rows });
  } catch (err) {
    console.error('Admin message replies error:', err);
    res.status(500).json({ ok:false, error:'Fehler beim Laden' });
  }
});

// POST /api/admin/messages/:id/reply
router.post('/messages/:id/reply', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id   = +req.params.id;
    const body = (req.body?.body || '').trim();
    if (!body) return res.status(400).json({ ok:false, message:'Text fehlt' });

    const msgQ = await pool.query(`SELECT * FROM messages WHERE id=$1`, [id]);
    if (!msgQ.rowCount) return res.status(404).json({ ok:false, message:'Nachricht nicht gefunden' });
    const msg = msgQ.rows[0];

    const ins = await pool.query(
      `INSERT INTO message_replies(message_id, to_email, subject, body, sent_at)
       VALUES ($1,$2,$3,$4, now())
       RETURNING *`,
      [id, msg.email, `Re: ${msg.subject || ''}`.trim(), body]
    );

    // optional mailen – nur wenn transporter & CONTACT_SENDER gesetzt
    try {
      const tx = req.app?.locals?.transporter;
      if (tx && process.env.CONTACT_SENDER) {
        await tx.sendMail({
          from: process.env.CONTACT_SENDER,
          to: msg.email,
          subject: `Re: ${msg.subject || ''}`.trim(),
          text: body,
        });
      }
    } catch (e) {
      console.warn('⚠️ Reply-Mail fehlgeschlagen:', e.message);
    }

    res.json({ ok:true, item: ins.rows[0] });
  } catch (err) {
    console.error('Admin send reply error:', err);
    res.status(500).json({ ok:false, message:'Senden fehlgeschlagen' });
  }
});

module.exports = router;
