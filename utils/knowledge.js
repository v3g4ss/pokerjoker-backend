// utils/knowledge.js
const crypto = require('crypto');
const { pool } = require('../db');

// optionale Parser „best effort“
const { JSDOM } = (() => { try { return require('jsdom'); } catch { return {}; } })();
let pdfParse = null, mammoth = null, xlsx = null;
try { pdfParse = require('pdf-parse'); } catch {}
try { mammoth  = require('mammoth'); } catch {}
try { xlsx     = require('xlsx'); } catch {}

// ~100k Tokens grob (4 chars/Tkn)
const MAX_TEXT_CHARS = 400_000;

// ===== Helpers =====
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const ext = (name = '') => (name.split('.').pop() || '').toLowerCase();
const looksSecret = (s) => /(api[_-]?key|bearer|sk-|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.)/i.test(s);
const approxTokens = (s = '') => Math.ceil(s.length / 4);

// Sichere Variante: immer Fortschritt, auch bei sehr kurzen Texten
function chunkify(text, size = 3500, overlap = 600) {
  if (!text) return [];
  const len = text.length;
  if (len <= size) {
    return [{ ord: 0, text, token_count: approxTokens(text) }];
  }
  const step = Math.max(1, size - overlap);
  const out = [];
  let i = 0;
  while (i < len) {
    const end = Math.min(i + size, len);
    const slice = text.slice(i, end);
    out.push({ ord: out.length, text: slice, token_count: approxTokens(slice) });
    if (end >= len) break;
    i += step;
  }
  return out;
}

// ===== Extractors =====
// Wichtig: KEIN blindes buffer.toString() bei Binärformaten!
async function extractText(buffer, filename, mime = '') {
  const e = ext(filename);

  // reine Textformate
  if (e === 'jsonl') {
    const raw = buffer.toString('utf8');
    return raw.split(/\r?\n/).filter(Boolean).join('\n');
  }
  if (e === 'csv' || e === 'md' || e === 'txt' || e === 'yaml' || e === 'yml') {
    return buffer.toString('utf8');
  }

  // HTML (nur, wenn jsdom da ist)
  if (e === 'html' && JSDOM) {
    const raw = buffer.toString('utf8');
    const dom = new JSDOM(raw);
    return dom.window.document.body.textContent || raw;
  }

  // Binärformate – Parser direkt auf Buffer
  if (e === 'pdf' && pdfParse) {
    const { text } = await pdfParse(buffer);
    return text || '';
  }
  if (e === 'docx' && mammoth) {
    const { value } = await mammoth.extractRawText({ buffer });
    return value || '';
  }
  if (e === 'xlsx' && xlsx) {
    const wb = xlsx.read(buffer, { type: 'buffer' });
    return wb.SheetNames.map(n => xlsx.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  }

  // Fallback
  return buffer.toString('utf8');
}

// ===== Ingestion =====
async function ingestOne({ buffer, filename, mime, category, tags, title }) {
  const hash = sha(buffer);

  // 1) Duplikate früh rausschmeißen (schnell & spart RAM)
  const d = await pool.query('SELECT id FROM knowledge_docs WHERE hash=$1', [hash]);
  if (d.rows[0]) return { id: d.rows[0].id, skipped: true };

  // 2) Text extrahieren
  let content = await extractText(buffer, filename, mime) || '';

  // 3) Vor dem Chunking hart deckeln
  if (content.length > MAX_TEXT_CHARS) {
    content = content.slice(0, MAX_TEXT_CHARS);
  }

  const size_bytes = buffer.length;

  // 4) Secret-Hinweis (nur Log)
  if (looksSecret(content)) console.warn('[knowledge] possible secret in', filename);

  // 5) Doc speichern
  const ins = await pool.query(
    `INSERT INTO knowledge_docs
       (title, filename, mime, size_bytes, category, tags, hash, content)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     RETURNING id`,
    [
      title || filename,
      filename,
      mime || '',
      size_bytes,
      category || null,
      (Array.isArray(tags) && tags.length) ? tags : null,
      hash,
      content
    ]
  );
  const doc_id = ins.rows[0].id;

  // 6) Chunking + Insert (transaktional)
  const chunks = chunkify(content);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const q = `INSERT INTO knowledge_chunks (doc_id, ord, text, token_count) VALUES ($1,$2,$3,$4)`;
    for (const c of chunks) {
      await client.query(q, [doc_id, c.ord, c.text, c.token_count]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }

  return { id: doc_id, chunks: chunks.length };
}

// ===== Search (FTS) =====
async function searchChunks({ q, categories = [], topK = 5 }) {
  const orig = String(q || '');
   // NEU: Query aufräumen (Satzzeichen raus, kurze Wörter entfernen)
  const cleaned =
    orig
      .normalize('NFKD')
      .replace(/[^\p{L}\p{N}\s-]/gu, ' ')   // nur Buchstaben/Zahlen/Leer/Hyphen
      .split(/\s+/)
      .filter(w => w.length >= 3)          // "wie", "der", "in" fliegen raus
      .join(' ')
      .trim();

  const term = cleaned || orig;            // falls alles rausfliegt, nimm Original

  const params = [term];
  let where = `kc.tsv @@ websearch_to_tsquery('simple', $1) AND kd.enabled = TRUE`;
  if (categories.length) {
    where += ` AND kd.category = ANY($${params.length + 1})`;
    params.push(categories);
  }

  const sql = `
    SELECT kc.id, kc.doc_id, kc.ord, kc.text,
           kd.title, kd.filename, kd.category, kd.tags, kd.priority
    FROM knowledge_chunks kc
    JOIN knowledge_docs  kd ON kd.id = kc.doc_id
    WHERE ${where}
    ORDER BY
      kd.priority DESC,
      ts_rank(kc.tsv, websearch_to_tsquery('simple', $1)) DESC,
      kc.id DESC
    LIMIT $${params.length + 1};
  `;
  params.push(topK);

  const { rows } = await pool.query(sql, params);

  const diversify = (arr) => {
    const out = [], byDoc = new Map();
    for (const r of arr) {
      const n = byDoc.get(r.doc_id) || 0;
      if (n < 2) { out.push(r); byDoc.set(r.doc_id, n + 1); }
      if (out.length >= topK) break;
    }
    return out;
  };

  let out = diversify(rows);

    // --- Fallback, falls FTS nichts findet ---
if (out.length === 0) {
  // Query in Tokens zerlegen; Bindestriche/Spaces angleichen
  const tokens = (cleaned || orig)
    .replace(/[-\s]+/g, ' ')          // buy-in -> buy in
    .split(/\s+/)
    .filter(w => w.length >= 3);      // Kurz-Wörter raus

  const toks = tokens.length ? tokens : [ (cleaned || orig) ];

  // für jedes Token: (text ILIKE $n OR title ILIKE $n OR filename ILIKE $n OR tags ILIKE $n)
  const clauses = [];
  const params2 = [];
  let p = 1;

  for (const t of toks) {
    const needle = `%${t}%`;
    clauses.push(`(
       kc.text ILIKE $${p} OR
       kd.title ILIKE $${p+1} OR
       kd.filename ILIKE $${p+2} OR
       COALESCE(array_to_string(kd.tags, ','), '') ILIKE $${p+3}
    )`);
    params2.push(needle, needle, needle, needle);
    p += 4;
  }

const sql2 = `
  SELECT kc.id, kc.doc_id, kc.ord, kc.text,
         kd.title, kd.filename, kd.category, kd.tags, kd.priority
  FROM knowledge_chunks kc
  JOIN knowledge_docs  kd ON kd.id = kc.doc_id
  WHERE kd.enabled = TRUE
    ${clauses.length ? ' AND (' + clauses.join(' OR ') + ')' : ''}
  ORDER BY kd.priority DESC, kc.id DESC
  LIMIT $${p};
`;
params2.push(topK);

const { rows: rows2 } = await pool.query(sql2, params2);
out = diversify(rows2);
}

  return out.slice(0, topK);
}

module.exports = { ingestOne, searchChunks };
