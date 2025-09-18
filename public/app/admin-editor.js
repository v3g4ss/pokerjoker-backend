// public/app/admin-editor.js
// 🃏 Poker Joker: Prompt UI erweitert mit punctRate + maxUsedTokens

document.addEventListener('DOMContentLoaded', () => {
  async function loadMenuItems() {
  const res = await fetch('/api/admin/editor', { credentials: 'include' });
  const data = await res.json();
  const tbody = document.querySelector('#menuItemsTable tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  (data.items || []).forEach(drawRow); // drawRow existiert schon
}
  const promptTextarea = document.getElementById('admPrompt');
  const tempInput      = document.getElementById('admTemp');
  const modelSelect    = document.getElementById('admModel');
  const testBtn        = document.getElementById('btnPromptTest');
  const saveBtn        = document.getElementById('btnPromptSave');
  const statusSpan     = document.getElementById('promptStatus');
  const outAnswer      = document.getElementById('admAnswer');
  const modeButtons    = document.querySelectorAll('input[name="chatMode"]');
  const chatModeSave   = document.getElementById('btnChatModeSave');
  const chatModeStatus = document.getElementById('chatModeStatus');
  const punctInput     = document.getElementById('punctRate');
  const maxTokInput    = document.getElementById('maxUsedTokens');

  const tableBody  = document.querySelector('#mnTable tbody');
  const addBtn     = document.getElementById('mnAdd');
  let addLocked    = false;

  if (!promptTextarea || !tempInput || !modelSelect || !testBtn || !saveBtn) return;

  async function api(url, options = {}) {
    const opts = {
      credentials: 'include',
      headers: { 'Accept': 'application/json', ...(options.headers || {}) },
      ...options,
    };
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error((await res.json())?.error || 'Fehler');
    return res.json();
  }

  // === Prompt + Settings laden ===
  async function loadPromptSettings() {
    try {
      const j = await api('/api/admin/prompt');
      promptTextarea.value = j.system_prompt;
      tempInput.value      = j.temperature;
      modelSelect.value    = j.model;
      punctInput.value     = j.punct_rate ?? 1;
      maxTokInput.value    = j.max_usedtokens_per_msg ?? 1000;
      // ChatMode setzen
      if (j.knowledge_mode) {
        const b = Array.from(modeButtons).find(x => x.value === j.knowledge_mode);
        if (b) b.checked = true;
      }
    } catch (err) {
      console.error(err);
      statusSpan.textContent = 'Fehler beim Laden';
    }
  }

  // === Prompt testen ===
  testBtn.addEventListener('click', async () => {
    const payload = {
      system_prompt: promptTextarea.value.trim(),
      temperature: Number(tempInput.value),
      model: modelSelect.value,
      input: 'Was ist Poker?'
    };
    try {
      const j = await api('/api/admin/prompt/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      outAnswer.textContent = j?.output || '[Kein Output]';
    } catch (err) {
      outAnswer.textContent = 'Fehler: ' + err.message;
    }
  });

  // === Prompt + Einstellungen speichern ===
  saveBtn.addEventListener('click', async () => {
    const payload = {
      system_prompt: promptTextarea.value.trim(),
      temperature: Number(tempInput.value),
      model: modelSelect.value,
      punct_rate: Number(punctInput.value),
      max_usedtokens_per_msg: Number(maxTokInput.value)
    };
    try {
      const j = await api('/api/admin/prompt', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      statusSpan.textContent = j.ok ? 'Gespeichert ✅' : 'Fehler ⚠️';
    } catch (err) {
      statusSpan.textContent = 'Fehler ⚠️';
    }
  });

  // === Chat-Mode speichern ===
  chatModeSave?.addEventListener('click', async () => {
    const mode = Array.from(modeButtons).find(x => x.checked)?.value || 'LLM_ONLY';
    try {
      const j = await api('/api/admin/prompt/mode', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode })
      });
      chatModeStatus.textContent = j.ok ? 'Gespeichert ✅' : 'Fehler ⚠️';
    } catch (err) {
      chatModeStatus.textContent = 'Fehler ⚠️';
    }
  });

  if (!window.mnMenuInitDone) {
    window.mnMenuInitDone = true;
    addBtn?.addEventListener('click', createMenuItem);
    loadMenuItems();
  }

  loadPromptSettings();
});

// === Menüpunkt-Erstellung auslagern ===
async function createMenuItem() {
  if (addLocked) return;
  addLocked = true;

  try {
    const j = await fetch('/api/admin/editor', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: 'Neuer Punkt',
        content_html: '<p>Inhalt kommt später</p>',
        position: 1,
        location: 'both',
        is_active: true
      })
    }).then(res => res.json());

    addLocked = false;

    if (j.ok && j.item) {
      statusSpan.textContent = 'Gespeichert ✅';
      drawRow(j.item);
    } else {
      statusSpan.textContent = 'Fehler beim Speichern ⚠️';
      console.error(j.error || j);
    }
  } catch (err) {
    addLocked = false;
    console.error(err);
    statusSpan.textContent = 'Fehler beim Speichern ⚠️';
  }
}
