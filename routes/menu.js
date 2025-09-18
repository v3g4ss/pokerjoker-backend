// routes/menu.js
const express = require('express');
const router = express.Router();
const { pool } = require('../db');

// Öffentliche Menü-API (keine Auth), damit auch Login-Seiten laden können
router.get('/menu', async (req, res) => {
  try {
    const location = String(req.query.location || 'live').toLowerCase(); // 'live' | 'login'
    const { rows } = await pool.query(
      `
      SELECT id, title, slug, position, location, is_active,
             COALESCE(content_html, '') AS content_html
      FROM public.menu_items
      WHERE is_active = true AND (location = 'both' OR location = $1)
      ORDER BY position, id
      `,
      [location]
    );
    res.json({ ok: true, items: rows });
  } catch (err) {
    console.error('GET /api/menu failed:', err);
    res.status(500).json({ ok: false, error: 'menu-failed' });
  }
});

module.exports = router;
