// routes/admin-kb.js
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const crypto  = require('crypto');
const pdfParse = require('pdf-parse');

const { pool } = require('../db');
const requireAuth  = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');

const router = express.Router();

// Upload-Verzeichnis
const uploadDir = path.join(__dirname, '..', 'uploads_tmp');
fs.mkdirSync(uploadDir, { recursive: true });
const upload = multer({ dest: uploadDir });

const ALLOWED = new Set([
  'text/plain', 'text/markdown', 'application/json',
  'text/javascript', 'application/pdf'
]);

const countTokens = s => (s.match(/\S+/g) || []).length;

function chunk(text, maxLen = 1200) {
  const out = [], lines = text.split(/\n{2,}/g);
  let buf = [], len = 0;
  for (const p of lines) {
    const t = p.trim(); if (!t) continue;
    if (len + t.length > maxLen && buf.length) {
      out.push(buf.join('\n\n')); buf = [t]; len = t.length;
    } else {
      buf.push(t); len += t.length + 2;
    }
  }
  if (buf.length) out.push(buf.join('\n\n'));
  return out;
}

async function fileToText(filePath, mime) {
  if (mime === 'application/pdf') {
    const data = await pdfParse(fs.readFileSync(filePath));
    return data.text || '';
  }
  return fs.readFileSync(filePath, 'utf8');
}

// ====================== ROUTES ======================

// Upload
router.post('/kb/upload', requireAuth, requireAdmin, upload.single('file'), async (req, res) => {
  console.log('HIT /api/admin/kb/upload');

  if (!req.file) return res.status(400).json({ ok:false, error:'Keine Datei hochgeladen' });

  const tmpPath = req.file.path;
  const original = req.file.originalname;
  const mime = req.file.mimetype;
  const size = req.file.size;

  const title    = (req.body?.title || original).toString();
  const category = (req.body?.category || '').toString().trim() || null;
  const tagsCsv  = (req.body?.tags || '').toString().trim();
  const tagsArr  = tagsCsv ? tagsCsv.split(',').map(s=>s.trim()).filter(Boolean) : null;

  try {
    if (!ALLOWED.has(mime)) {
      fs.unlink(tmpPath, ()=>{});
      return res.status(400).json({ ok:false, error:`Nicht erlaubt: ${mime}` });
    }

    const text = await fileToText(tmpPath, mime);
    fs.unlink(tmpPath, ()=>{});
    if (!text?.trim()) return res.status(400).json({ ok:false, error:'Kein extrahierbarer Text' });

    const hash = crypto.createHash('sha256').update(text).digest('hex');

    const docSql = `
      INSERT INTO knowledge_docs
        (title, filename, mime, size_bytes, category, tags, language, source_url,
         version, enabled, priority, hash, content, tsv, created_at)
      VALUES
        ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,to_tsvector('german',$13),NOW())
      RETURNING id
    `;
    const docVals = [
      title, original, mime, size, category, tagsArr,
      null, null, 1, true, 0, hash, text
    ];
    const { rows } = await pool.query(docSql, docVals);
    const docId = rows[0].id;

    const parts = chunk(text);
    for (let i = 0; i < parts.length; i++) {
      await pool.query(`
        INSERT INTO knowledge_chunks (doc_id, ord, text, token_count, tsv)
        VALUES ($1,$2,$3,$4,to_tsvector('german',$3))`,
        [docId, i, parts[i], countTokens(parts[i])]
      );
    }

    res.json({ ok:true, docId, filename:original, chunks: parts.length });
  } catch (err) {
    console.error('KB upload error:', err);
    try { fs.unlinkSync(tmpPath); } catch {}
    res.status(500).json({ ok:false, error: err.message });
  }
});

// List (optional Suche + Kategorie)
router.get('/kb/docs', requireAuth, requireAdmin, async (req, res) => {
  console.log('HIT /api/admin/kb/docs');
  const q   = (req.query.q || '').toString().trim();
  const cat = (req.query.cat || '').toString().trim();
  const where = [], vals = []; let i = 1;

  if (q)   { where.push(`(title ILIKE $${i} OR filename ILIKE $${i})`); vals.push(`%${q}%`); i++; }
  if (cat) { where.push(`(category = $${i})`); vals.push(cat); i++; }

  const sql = `
    SELECT id, title, filename, mime, size_bytes, enabled, priority, category, tags, created_at
    FROM knowledge_docs
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY created_at DESC
    LIMIT 500
  `;
  const { rows } = await pool.query(sql, vals);
  res.json({ ok:true, items: rows });
});

// Toggle aktiv / prio ändern
router.patch('/kb/doc/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { enabled, priority } = req.body || {};
  if (!id) return res.status(400).json({ ok:false, error:'Bad ID' });

  const sets = [], vals = []; let i = 1;
  if (typeof enabled === 'boolean') { sets.push(`enabled=$${i++}`); vals.push(enabled); }
  if (Number.isFinite(priority))    { sets.push(`priority=$${i++}`); vals.push(priority); }
  if (!sets.length) return res.json({ ok:true });

  vals.push(id);
  await pool.query(`UPDATE knowledge_docs SET ${sets.join(', ')} WHERE id=$${i}`, vals);
  res.json({ ok:true });
});

// Reindex: tsv neu berechnen
router.post('/kb/reindex', requireAuth, requireAdmin, async (_req, res) => {
  await pool.query(`UPDATE knowledge_docs SET tsv = to_tsvector('german', content)`);
  await pool.query(`UPDATE knowledge_chunks SET tsv = to_tsvector('german', text)`);
  const { rows: d } = await pool.query(`SELECT COUNT(*)::int AS c FROM knowledge_docs`);
  const { rows: c } = await pool.query(`SELECT COUNT(*)::int AS c FROM knowledge_chunks`);
  res.json({ ok:true, count_docs: d[0].c, count_chunks: c[0].c });
});

// DELETE-Route
router.delete('/kb/doc/:id', requireAuth, requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ ok:false, error:'Ungültige ID' });

  await pool.query('DELETE FROM knowledge_chunks WHERE doc_id=$1', [id]);
  await pool.query('DELETE FROM knowledge_docs WHERE id=$1', [id]);

  res.json({ ok:true });
});

module.exports = router;
