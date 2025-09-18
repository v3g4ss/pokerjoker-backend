// routes/admin-prompt.js
const express = require('express');
const router = express.Router();

const { pool } = require('../db');
const requireAuth = require('../middleware/requireAuth');
const requireAdmin = require('../middleware/requireAdmin');

let OpenAI = null;
try { ({ OpenAI } = require('openai')); } catch (_) {}

console.log('ROUTE LOADED:', __filename);

// --- GET /api/admin/prompt ---
router.get('/prompt', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const r = await pool.query(`
      SELECT id, system_prompt, temperature, model, knowledge_mode, version, updated_at,
             punct_rate, max_usedtokens_per_msg
      FROM bot_settings
      ORDER BY id
      LIMIT 1
    `);
    res.json(
      r.rows[0] || {
        system_prompt: '',
        temperature: 0.3,
        model: 'gpt-4o-mini',
        knowledge_mode: 'LLM_ONLY',
        punct_rate: 1,
        max_usedtokens_per_msg: 1000
      }
    );
  } catch (err) {
    console.error('Prompt load error:', err);
    res.status(500).json({ ok: false, error: 'DB Fehler beim Laden' });
  }
});

// --- PUT /api/admin/prompt ---
router.put('/prompt', requireAuth, requireAdmin, async (req, res) => {
  const {
    system_prompt,
    temperature,
    model,
    punct_rate,
    max_usedtokens_per_msg
  } = req.body || {};

  const t      = Number.isFinite(temperature) ? Number(temperature) : 0.3;
  const m      = (model || 'gpt-4o-mini').toString();
  const pr     = Number.isFinite(punct_rate) ? Number(punct_rate) : 1;
  const maxTok = Number.isFinite(max_usedtokens_per_msg) ? Number(max_usedtokens_per_msg) : 1000;

  try {
    await pool.query('BEGIN');

    const cur = await pool.query(`SELECT * FROM bot_settings ORDER BY id LIMIT 1`);
    if (cur.rowCount) {
      await pool.query(`
        INSERT INTO bot_settings_history
          (system_prompt, temperature, model, version, updated_by, updated_at, knowledge_mode, punct_rate, max_usedtokens_per_msg)
        VALUES ($1,$2,$3,$4,$5,now(),$6,$7,$8)
      `, [
        cur.rows[0].system_prompt ?? '',
        cur.rows[0].temperature ?? 0.3,
        cur.rows[0].model ?? 'gpt-4o-mini',
        cur.rows[0].version ?? 0,
        req.user?.id || null,
        cur.rows[0].knowledge_mode ?? 'LLM_ONLY',
        cur.rows[0].punct_rate ?? 1,
        cur.rows[0].max_usedtokens_per_msg ?? 1000
      ]);
    }

    await pool.query(`
      INSERT INTO bot_settings 
        (id, system_prompt, temperature, model, punct_rate, max_usedtokens_per_msg, version, updated_by, updated_at)
      VALUES 
        (1, $1, $2, $3, $4, $5, 1, $6, now())
      ON CONFLICT (id) DO UPDATE SET
        system_prompt = EXCLUDED.system_prompt,
        temperature   = EXCLUDED.temperature,
        model         = EXCLUDED.model,
        punct_rate    = EXCLUDED.punct_rate,
        max_usedtokens_per_msg = EXCLUDED.max_usedtokens_per_msg,
        version       = bot_settings.version + 1,
        updated_by    = EXCLUDED.updated_by,
        updated_at    = now()
    `, [system_prompt || '', t, m, pr, maxTok, req.user?.id || null]);

    await pool.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    console.error('Prompt save error:', err);
    res.status(500).json({ ok: false, error: 'Speichern fehlgeschlagen' });
  }
});

// --- POST /api/admin/prompt/test ---
router.post('/prompt/test', requireAuth, requireAdmin, async (req, res) => {
  console.log('HIT /api/admin/prompt/test (ECHO + optional OpenAI)');
  console.log('Prompt-Test Body:', req.body);


  const body = req.body || {};

const system_prompt = body.system_prompt ?? '';
const input         = body.input ?? 'Ping';
const model         = body.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini';
const temperature   = body.temperature ?? 0.3;


  const preview = system_prompt.toString().replace(/\s+/g, ' ').slice(0, 160);
  let output = `[SERVER OK]\nPrompt: "${preview}${system_prompt.length > 160 ? '…' : ''}"\nAntwort auf "${input}": Server antwortet.`;

  try {
    if (OpenAI && process.env.OPENAI_API_KEY) {
      const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

      const r = await openai.chat.completions.create({
        model,
        temperature: Number(temperature) || 0.3,
        max_tokens: 200,
        messages: [
          { role: 'system', content: system_prompt },
          { role: 'user', content: input }
        ]
      });

      let txt = (r?.choices?.[0]?.message?.content || '').trim();
      if (txt) output = txt;
    }
  } catch (err) {
    console.warn('OpenAI Test warn:', err?.message || err);
  }

  return res.json({ ok: true, output });
});

module.exports = router;
