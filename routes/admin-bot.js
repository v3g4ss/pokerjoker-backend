// routes/admin-bot.js
const express = require('express');
const router  = express.Router();

const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pool }     = require('../db');

// Liefert/Setzt den globalen Chat-Modus in bot_settings. Werte:
// KB_ONLY | KB_PREFERRED | LLM_ONLY

router.get('/bot-mode', requireAuth, requireAdmin, async (req,res)=>{
  const r = await pool.query(`SELECT knowledge_mode FROM bot_settings LIMIT 1`);
  res.json({ ok:true, mode: r.rows[0]?.knowledge_mode || 'KB_PREFERRED' });
});

router.put('/bot-mode', requireAuth, requireAdmin, async (req,res)=>{
  const m = String(req.body?.mode || '').toUpperCase();
  const allowed = ['KB_ONLY','KB_PREFERRED','LLM_ONLY'];
  if (!allowed.includes(m)) return res.status(400).json({ ok:false, error:'invalid mode' });
  await pool.query(`UPDATE bot_settings SET knowledge_mode=$1`, [m]);
  res.json({ ok:true });
});

module.exports = router;
