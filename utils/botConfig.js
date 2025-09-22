// utils/botConfig.js
const { pool } = require('../db');

let cache = null, cacheTS = 0;

async function getBotConfig() {
  const now = Date.now();
  if (cache && now - cacheTS < 10_000) return cache; // 10s Cache
  const { rows } = await pool.query('SELECT * FROM bot_settings WHERE id=1');
  cache = rows[0];
  cacheTS = now;
  return cache;
}

async function setBotConfig({ system_prompt, temperature, model }, adminUserId) {
  const cur = await getBotConfig();
  const nextVer = (cur?.version || 0) + 1;

  await pool.query(`
    UPDATE bot_settings
       SET system_prompt=$1, temperature=$2, model=$3,
           version=$4, updated_by=$5, updated_at=now()
     WHERE id=1
  `, [system_prompt, temperature, model, nextVer, adminUserId]);

  await pool.query(`
    INSERT INTO bot_settings_history(system_prompt,temperature,model,version,updated_by)
    VALUES ($1,$2,$3,$4,$5)
  `, [system_prompt, temperature, model, nextVer, adminUserId]);

  cache = null; // Cache invalidieren
}

module.exports = { getBotConfig, setBotConfig };
