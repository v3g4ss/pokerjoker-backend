// routes/messages.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

router.post('/messages', async (req, res) => {
  try {
    const { name, email, subject, message } = req.body || {};
    if (!name || !email || !subject || !message) {
      return res.status(400).json({ ok:false, error:'Bitte alle Felder ausfüllen' });
    }
    await pool.query(
      `INSERT INTO messages(name,email,subject,message,created_at) VALUES ($1,$2,$3,$4,now())`,
      [name, email, subject, message]
    );
    res.json({ ok:true });
  } catch (err) {
    console.error('Message error:', err);
    res.status(500).json({ ok:false, error:'Fehler beim Speichern' });
  }
});

module.exports = router;
