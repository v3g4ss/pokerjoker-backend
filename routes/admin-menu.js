// routes/admin-menu.js
const express = require('express');
const router  = express.Router();

const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');
const { pool }     = require('../db');

// --- Handler (einmal definieren, für beide Pfad-Präfixe registrieren) ---
const listItems = async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM menu_items ORDER BY id');
    res.json({ ok: true, items: result.rows });
  } catch (err) {
    console.error('Fehler beim Laden der Menüeinträge:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Laden' });
  }
};

const createItem = async (req, res) => {
  const {
    title = 'Neuer Punkt',
    position = 1,
    content_html = '',
    location = 'both',
    is_active = true
  } = req.body || {};

  const key  = 'item-' + Math.random().toString(36).substring(2, 8);
  const slug = 'slug-' + Math.random().toString(36).substring(2, 6);

  try {
    const result = await pool.query(
      `INSERT INTO menu_items (key, title, slug, position, content_html, location, is_active)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       RETURNING *`,
      [key, title, slug, position, content_html, location, is_active]
    );
    res.json({ ok: true, item: result.rows[0] });
  } catch (err) {
    console.error('Fehler beim Hinzufügen:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Speichern' });
  }
};

const updateItem = async (req, res) => {
  const { title, position, content_html, location, is_active } = req.body || {};
  try {
    await pool.query(
      `UPDATE menu_items SET
         title        = COALESCE($1, title),
         position     = COALESCE($2, position),
         content_html = COALESCE($3, content_html),
         location     = COALESCE($4, location),
         is_active    = COALESCE($5, is_active)
       WHERE id = $6`,
      [title, position, content_html, location, is_active, req.params.id]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error('Fehler beim Aktualisieren:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Update' });
  }
};

const deleteItem = async (req, res) => {
  try {
    await pool.query('DELETE FROM menu_items WHERE id = $1', [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error('Fehler beim Löschen:', err);
    res.status(500).json({ ok: false, error: 'Fehler beim Löschen' });
  }
};

// --- Routen unter /editor (bestehend) ---
router.get   ('/editor',      requireAuth, requireAdmin, listItems);
router.post  ('/editor',      requireAuth, requireAdmin, createItem);
router.put   ('/editor/:id',  requireAuth, requireAdmin, updateItem);
router.delete('/editor/:id',  requireAuth, requireAdmin, deleteItem);

// --- Alias unter /menu (für bestehendes Frontend) ---
router.get   ('/menu',        requireAuth, requireAdmin, listItems);
router.post  ('/menu',        requireAuth, requireAdmin, createItem);
router.put   ('/menu/:id',    requireAuth, requireAdmin, updateItem);
router.delete('/menu/:id',    requireAuth, requireAdmin, deleteItem);

module.exports = router;
