// public/app/js/admin-contacts.js
(function () {
  // =========================
  // Helpers
  // =========================
  const esc = s => (s ?? '').toString()
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');

  const fmt = iso => iso ? new Date(iso).toLocaleString() : '';

  const timeAgo = iso => {
    const d = new Date(iso);
    const sec = (Date.now() - d.getTime()) / 1000;
    if (isNaN(sec)) return '';
    if (sec < 60)   return `${sec|0}s`;
    if (sec < 3600) return `${(sec/60)|0}m`;
    if (sec < 86400)return `${(sec/3600)|0}h`;
    return d.toLocaleString();
  };

  const $id = (id) => document.getElementById(id);
  const setChecked = (id, val) => { const el = $id(id); if (el && 'checked' in el) el.checked = !!val; };
  const setValue   = (id, val) => { const el = $id(id); if (el) el.value = (val ?? ''); };

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      ...opts
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json().catch(() => ({}));
  }

  // Paging-State
  const state = { page: 1, limit: 10, total: 0, q: '' };

  // =========================
  // DOM Ready
  // =========================
  document.addEventListener('DOMContentLoaded', () => {
    // --- Kontakte-Liste UI (falls vorhanden)
    const tbody       = $id('contactRows');          // <tbody>
    const prevBtn     = $id('btnContactPrev');
    const nextBtn     = $id('btnContactNext');
    const reloadBtn   = $id('btnContactReload');
    const listInfo    = $id('msgPageInfo');
    const searchInput = $id('msgSearch');

    // Detailbereich (rechts/unten)
    let detailBox = $id('detailBox');
    if (!detailBox && tbody?.parentNode) {
      detailBox = document.createElement('div');
      detailBox.id = 'detailBox';
      detailBox.textContent = 'Wähle links eine Nachricht aus.';
      tbody.parentNode.appendChild(detailBox);
    }

    // -------------------------
    // Bot-Konfig-UI (safe)
    // -------------------------
    async function loadBotConfigUI() {
      const hasUI = $id('admPrompt') || $id('admTemp') || $id('admModel') || $id('kbOnly');
      if (!hasUI) return; // Sektion fehlt auf dieser Seite

      const d   = await api('/admin/bot/config');
      const cfg = d?.cfg || {};

      setValue('admPrompt', cfg.system_prompt || '');
      setValue('admTemp',   cfg.temperature ?? 0.3);
      setValue('admModel',  cfg.model || 'gpt-4o-mini');
      setChecked('kbOnly',  cfg.knowledge_mode === 'always');
    }

    const btnSave = $id('btnPromptSave');
    if (btnSave) {
      btnSave.addEventListener('click', async () => {
        const body = {
          system_prompt: $id('admPrompt')?.value || '',
          temperature:   parseFloat($id('admTemp')?.value || '0.3'),
          model:         $id('admModel')?.value || 'gpt-4o-mini',
          knowledge_mode: ($id('kbOnly')?.checked ? 'always' : 'on-demand')
        };

        const status = $id('promptStatus');
        btnSave.disabled = true; if (status) status.textContent = 'speichere…';
        try {
          await api('/admin/bot/config', { method: 'POST', body: JSON.stringify(body) });
          if (status) status.textContent = 'LIVE aktualisiert';
        } catch (e) {
          if (status) status.textContent = 'Fehler: ' + e.message;
        } finally {
          btnSave.disabled = false;
          setTimeout(() => { if (status) status.textContent = ''; }, 1200);
        }
      });
    }

    // gleich laden (macht nichts, wenn UI fehlt)
    loadBotConfigUI();

    // -------------------------
    // Kontakte-Liste nur binden, wenn vorhanden
    // -------------------------
    if (!tbody || !prevBtn || !nextBtn || !reloadBtn || !listInfo) {
      // Kein Kontakte-UI auf dieser Seite – OK.
      return;
    }

    // ---------- LISTE LADEN ----------
    async function loadPage(p = 1) {
      try {
        state.page = p;

        const params = new URLSearchParams({
          page: String(state.page),
          limit: String(state.limit)
        });
        if (state.q) params.set('q', state.q);

        const res = await fetch(`/api/admin/messages?${params.toString()}`, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();

        state.total = data.total || 0;
        const items = data.items || [];

        tbody.innerHTML = '';
        if (!items.length) {
          tbody.innerHTML = `<tr><td colspan="8">Keine Nachrichten gefunden.</td></tr>`;
        } else {
          for (const m of items) {
            const tr = document.createElement('tr');
            tr.dataset.id = m.id;

            tr.innerHTML = `
              <td title="${esc(fmt(m.created_at))}">${esc(timeAgo(m.created_at))}</td>
              <td>${m.user_id ?? '–'}</td>
              <td>${esc(m.name || '')}</td>
              <td>${esc(m.email || '')}</td>
              <td>${esc(m.subject || '')}</td>

              <!-- Email Inhalt -->
              <td>
                <button class="icon" data-open="${m.id}" title="Details öffnen">Öffnen</button>
              </td>

              <!-- Aktionen -->
              <td>
                <button class="icon" data-reply="${m.id}" title="Antwort schreiben">Antwort schreiben</button>
                <button class="icon" data-view="${m.id}" title="Antworten lesen">Antwort lesen</button>
              </td>

              <!-- Datum Antwort -->
              <td>${m.last_reply_at ? esc(fmt(m.last_reply_at)) : ''}</td>
            `;
            tbody.appendChild(tr);
          }
        }

        const from = (state.page - 1) * state.limit + 1;
        const to   = Math.min(state.page * state.limit, state.total);
        listInfo.textContent = state.total ? `Einträge ${from}-${to} von ${state.total}` : '–';
        prevBtn.disabled = state.page <= 1;
        nextBtn.disabled = (state.page * state.limit) >= state.total;
      } catch (e) {
        console.error('[admin-contacts] loadPage failed', e);
        tbody.innerHTML = `<tr><td colspan="8">Fehler beim Laden.</td></tr>`;
      }
    }

    // ---------- DETAIL + ANTWORTEN ----------
    async function loadReplies(id){
      const r = await fetch(`/api/admin/messages/${id}/replies`, { credentials:'include' });
      const d = await r.json();
      const box = detailBox?.querySelector('#replies');
      if (!box) return;

      if (!d.ok || !d.items?.length) {
        box.innerHTML = '<div class="muted">Noch keine Antworten.</div>';
        return;
      }

      box.innerHTML = d.items.map(x => `
        <div class="reply" style="margin:10px 0;padding:10px;border:1px solid #2b3145;border-radius:8px">
          <div><strong>${x.sent_at ? 'Gesendet: ' + fmt(x.sent_at) : 'Entwurf'}</strong></div>
          ${x.subject ? `<div class="muted">${esc(x.subject)}</div>` : ''}
          <pre class="body" style="white-space:pre-wrap;margin:6px 0 0">${esc(x.body||'')}</pre>
        </div>
      `).join('');
    }

    async function openDetail(id, opts = { focus:false }) {
      try {
        if (!detailBox) return;
        detailBox.textContent = 'Lade …';

        const r = await fetch(`/api/admin/messages/${id}`, { credentials:'include' });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const { item = {} } = await r.json();

        detailBox.innerHTML = `
          <div class="msgHead">
            <div><strong>Betreff:</strong> ${esc(item.subject||'')}</div>
            <div><strong>Von:</strong> ${esc(item.name||'')} &lt;${esc(item.email||'')}&gt;</div>
            <div class="muted"><strong>Erstellt:</strong> ${fmt(item.created_at)}</div>
          </div>

          <pre class="body" style="white-space:pre-wrap;margin:6px 0 10px">${esc(item.message||'')}</pre>

          <div id="replies"></div>

          <form id="replyForm" style="margin-top:12px">
            <textarea id="replyBody" placeholder="Antwort eingeben…"></textarea>
            <div class="actions" style="margin-top:8px;display:flex;gap:8px">
              <button id="replySend" type="submit">Senden</button>
            </div>
          </form>
        `;

        await loadReplies(id);

        const form = detailBox.querySelector('#replyForm');
        const ta   = detailBox.querySelector('#replyBody');
        if (opts.focus) ta?.focus();

        form?.addEventListener('submit', async (e) => {
          e.preventDefault();
          const body = (ta?.value || '').trim();
          if (!body) { ta?.focus(); return; }

          const rr = await fetch(`/api/admin/messages/${id}/reply`, {
            method: 'POST',
            headers: { 'Content-Type':'application/json' },
            credentials: 'include',
            body: JSON.stringify({ body })
          });
          const d = await rr.json().catch(()=>({}));
          if (!d.ok) { alert(d.message || 'Fehler beim Senden.'); return; }

          if (ta) ta.value = '';
          await loadReplies(id);       // Antwortenliste updaten
          await loadPage(state.page);  // Tabelle (letzte Antwort) aktualisieren
        });

      } catch (e) {
        console.error('[admin-contacts] openDetail failed', e);
        if (detailBox) detailBox.textContent = 'Fehler beim Laden der Details.';
      }
    }

    // ---------- Events ----------
    tbody.addEventListener('click', async (e) => {
      const t  = e.target;
      const id = t?.dataset?.open || t?.dataset?.reply || t?.dataset?.view;
      if (!id) return;

      if (t.dataset.open)  openDetail(id);
      if (t.dataset.view)  openDetail(id);
      if (t.dataset.reply) openDetail(id, { focus:true });
    });

    prevBtn.addEventListener('click', () => loadPage(state.page - 1));
    nextBtn.addEventListener('click', () => loadPage(state.page + 1));
    reloadBtn.addEventListener('click', () => loadPage(state.page));

    // Suche (Debounce)
    let searchTimer;
    searchInput?.addEventListener('input', () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = searchInput.value.trim();
        loadPage(1);
      }, 300);
    });

    // initial
    loadPage(1);
  }); // DOMContentLoaded
})(); // IIFE
