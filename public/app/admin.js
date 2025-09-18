// public/app/admin.js
// ============================================================
// Admin-Frontend für Poker Joker
// ============================================================

// ---- Hilfs-API ------------------------------------------------------------
async function api(path, opts = {}) {
  const res = await fetch('/api' + path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('application/json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error((data && data.message) || ('HTTP ' + res.status));
  return data;
}
const $ = s => document.querySelector(s);

// ---- Logout ---------------------------------------------------------------
document.getElementById('logoutBtn')?.addEventListener('click', async () => {
  try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
  location.href = '/login/';
});

// ---- KPIs -----------------------------------------------------------------
async function loadStats() {
  try {
    const s = await api('/admin/stats');

    const set = (sel, val) => {
      const n = document.querySelector(sel);
      if (n) n.textContent = (val ?? 0).toString();
    };

    set('#statCustomers',          s.customers);
    set('#statAdmins',             s.admins);
    set('#statMsgs',               s.messages_total);
    set('#statMsgsNew',            s.messages_new);
    set('#statPurchased',          s.purchased);
    set('#statAdminGranted',       s.admin_granted);
    set('#statTokensCirculation',  s.tokens_in_circulation);
  } catch (e) {
    console.warn('stats:', e.message);
  }
}
loadStats();

// ---- Users Liste ----------------------------------------------------------
let uPage = 1, uLimit = 10, uQ = '';

async function loadUsers() {
  const qs = new URLSearchParams({ page: uPage, limit: uLimit });
  if (uQ) qs.set('q', uQ);

  const d = await api('/admin/users?' + qs.toString());
  const tb = document.querySelector('#usersTbl tbody');
  if (!tb) return;
  tb.innerHTML = '';

  (d.items || []).forEach(u => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${u.id}</td>
      <td class="mono">${u.email}</td>
      <td>${u.is_admin ? 'Ja' : 'Nein'}</td>
      <td>${u.is_locked ? '🔒 gesperrt' : '✔ aktiv'}</td>
      <td class="mono">${u.tokens ?? 0}</td>
      <td class="mono">${u.purchased ?? 0}</td>
      <td>
        <button class="tplus"  data-id="${u.id}" data-delta="50">+50</button>
        <button class="tminus" data-id="${u.id}" data-delta="-50">-50</button>
        <button class="adm"    data-id="${u.id}" data-admin="${u.is_admin ? 0 : 1}">${u.is_admin ? 'Admin −' : 'Admin +'}</button>
        <button class="lock"   data-id="${u.id}" data-lock="${u.is_locked ? 0 : 1}">${u.is_locked ? 'Entsperren' : 'Sperren'}</button>
        <button class="del"    data-id="${u.id}" style="color:#e74c3c">Löschen</button>
      </td>`;
    tb.appendChild(tr);
  });

  $('#pageInfo') && ($('#pageInfo').textContent = d.total ? `Seite ${uPage} · ${d.total} User` : '–');
  $('#prevPage') && ($('#prevPage').disabled = uPage <= 1);
  $('#nextPage') && ($('#nextPage').disabled = uPage * uLimit >= (d.total || 0));
}

$('#btnSearch')?.addEventListener('click', () => {
  uQ = $('#userSearch')?.value?.trim() || '';
  uPage = 1;
  loadUsers();
});
$('#prevPage')?.addEventListener('click', () => { if (uPage>1){ uPage--; loadUsers(); }});
$('#nextPage')?.addEventListener('click', () => { uPage++; loadUsers(); });

// Tabellen-Click: +50 / -50 / Admin / Lock / Delete ------------------------
document.querySelector('#usersTbl tbody')?.addEventListener('click', async (e) => {
  const b = e.target.closest('button'); if (!b) return;
  const id = Number(b.dataset.id);
  if (!Number.isInteger(id)) return;

  const reasonInput = document.getElementById('tokenReason');
  const baseReason  = (reasonInput?.value || '').trim();
  const statusEl    = document.getElementById('tokenStatus');

  // +/− Tokens (Backend: /admin/tokens/adjust)
  if (b.classList.contains('tplus') || b.classList.contains('tminus')) {
    const delta  = parseInt(b.dataset.delta, 10);
    const reason = baseReason || (delta > 0 ? 'admin quick +50' : 'admin quick -50');
    try {
      await api('/admin/tokens/adjust', {
        method: 'POST',
        body: JSON.stringify({ userId: id, delta, reason })
      });
      statusEl && (statusEl.textContent = `✅ Tokens aktualisiert (${delta>0?'+':''}${delta}) – Grund: ${reason}`);
      await Promise.all([loadUsers(), loadStats()]);
    } catch (err) {
      statusEl && (statusEl.textContent = '❌ ' + (err.message || 'Fehler beim Aktualisieren'));
    }
    return;
  }

  // Admin Flag
  if (b.classList.contains('adm')) {
    const is_admin = b.dataset.admin === '1';
    await api(`/admin/users/${id}/admin`, { method:'POST', body: JSON.stringify({ is_admin }) });
    await Promise.all([loadUsers(), loadStats()]);
    return;
  }

  // Lock/Unlock
  if (b.classList.contains('lock')) {
    const locked = b.dataset.lock === '1';
    await api(`/admin/users/${id}/lock`, { method:'POST', body: JSON.stringify({ locked }) });
    await loadUsers();
    return;
  }

  // Soft Delete
  if (b.classList.contains('del')) {
    if (!confirm('User wirklich löschen? (soft delete)')) return;
    await api(`/admin/users/${id}`, { method:'DELETE' });
    await loadUsers();
    return;
  }
});

loadUsers();

// ---- Tokens anpassen Kachel (mit Grund + Statusausgabe) -------------------
async function adjustTokens(deltaSign = 1) {
  const uidEl = $('#tokenUserId');
  const deltaEl = $('#tokenDelta');
  const reasonEl = $('#tokenReason');
  const st = $('#tokenStatus');

  const uid   = parseInt(uidEl?.value, 10);
  const delta = parseInt(deltaEl?.value, 10);
  const reason = String(reasonEl?.value || '').trim();

  if (!Number.isInteger(uid) || !Number.isInteger(delta)) {
    st && (st.textContent = '⚠ Bitte gültige User-ID und Token-Anzahl angeben.');
    return;
  }

  const finalDelta = deltaSign * Math.abs(delta);
  const body = {
    userId: uid,
    delta: finalDelta,
    reason: reason || (finalDelta > 0 ? `admin adjust +${Math.abs(finalDelta)}` : `admin adjust -${Math.abs(finalDelta)}`)
  };

  const btnAdd = $('#btnAddTokens'), btnRem = $('#btnRemoveTokens');
  btnAdd && (btnAdd.disabled = true);
  btnRem && (btnRem.disabled = true);
  st && (st.textContent = '⏳ Übertrage…');

  try {
    const r = await api('/admin/tokens/adjust', { method:'POST', body: JSON.stringify(body) });
    st && (st.textContent = `✅ Gespeichert. Neuer Kontostand: ${r.balance}`);
    if (deltaEl) deltaEl.value = ''; // Grund bleibt stehen
    await Promise.all([loadUsers(), loadStats()]);
  } catch (e) {
    st && (st.textContent = '❌ ' + (e.message || 'Fehler beim Anpassen'));
  } finally {
    btnAdd && (btnAdd.disabled = false);
    btnRem && (btnRem.disabled = false);
  }
}
$('#btnAddTokens')?.addEventListener('click', ()=>adjustTokens(+1));
$('#btnRemoveTokens')?.addEventListener('click', ()=>adjustTokens(-1));
$('#btnRefreshUsers')?.addEventListener('click', async ()=>{
  const b = $('#btnRefreshUsers');
  if (!b) return;
  b.disabled = true; b.textContent = 'Aktualisiere…';
  await Promise.all([loadUsers(), loadStats()]);
  b.textContent = 'Aktualisieren'; b.disabled = false;
});

// Admin ersetzt sein eigenes Passwort 
document.getElementById('btnMePass')?.addEventListener('click', async () => {
  const oldp = document.getElementById('meOldPass').value;
  const newp = document.getElementById('meNewPass').value;
  const st = document.getElementById('mePassStatus');
  if (st) st.textContent = '...';

  try {
    const r = await api('/auth/password', {
      method:'POST',
      body: JSON.stringify({ current_password: oldp, new_password: newp })
    });
    if (st) st.textContent = '✅ ' + (r.message || 'Passwort geändert. Bitte neu einloggen.');
    // kleinen Delay und auf Login-Seite
    setTimeout(()=>location.href='/login/', 800);
  } catch (e) {
    if (st) st.textContent = '❌ ' + (e.message || 'Fehler');
  }
});

// ---- User anlegen (NEU – Punkt 3) ----------------------------------------
document.getElementById('btnCreateUser')?.addEventListener('click', async ()=>{
  const email = document.getElementById('newUserEmail')?.value.trim();
  const pass  = document.getElementById('newUserPass')?.value || '';
  const adm   = !!document.getElementById('newUserAdmin')?.checked;
  const st    = document.getElementById('createUserStatus');

  if (!email || pass.length < 6) {
    st && (st.textContent = '⚠ E-Mail & mind. 6 Zeichen Passwort');
    return;
  }
  st && (st.textContent = '⏳ Anlegen…');

  try {
    await api('/admin/users', { method:'POST', body: JSON.stringify({ email, password: pass, is_admin: adm }) });
    st && (st.textContent = '✅ Angelegt');
    document.getElementById('newUserEmail').value = '';
    document.getElementById('newUserPass').value  = '';
    document.getElementById('newUserAdmin').checked = false;
    await Promise.all([loadUsers(), loadStats()]);
  } catch (e) {
    st && (st.textContent = '❌ ' + (e.message || 'Fehler'));
  }
});

// ---- Ledger / Reports -----------------------------------------------------
$('#btnLoadUserLedger')?.addEventListener('click', async ()=>{
  const uid = parseInt($('#ledgerUserId')?.value, 10); if (!Number.isInteger(uid)) return;
  const rows = await api(`/admin/ledger/user/${uid}`);
  const tb = $('#userLedgerTbl tbody'); if (!tb) return; tb.innerHTML = '';
  rows.slice(0,50).forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.id}</td><td class="mono">${r.delta}</td><td>${r.reason||''}</td><td class="mono">${r.balance_after}</td><td class="muted">${r.created_at}</td>`;
    tb.appendChild(tr);
  });
});

$('#btnLoadSummary')?.addEventListener('click', async ()=>{
  const rows = await api('/admin/summary');
  const tb = $('#summaryTbl tbody'); if (!tb) return; tb.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td class="mono">${r.user_id}</td><td>${r.purchased ?? 0}</td><td>${r.in_sum ?? 0}</td><td>${r.out_sum ?? 0}</td><td><b>${r.balance ?? 0}</b></td>`;
    tb.appendChild(tr);
  });
});

$('#btnLoadLast200')?.addEventListener('click', async ()=>{
  const rows = await api('/admin/ledger/last200');
  const tb = $('#lastTbl tbody'); if (!tb) return; tb.innerHTML = '';
  rows.forEach(r=>{
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${r.id}</td><td class="mono">${r.user_id}</td><td class="mono">${r.delta}</td><td>${r.reason||''}</td><td class="mono">${r.balance_after}</td><td class="muted">${r.created_at}</td>`;
    tb.appendChild(tr);
  });
});

// ---- Chat-Mode UI (KB_ONLY / KB_PREFERRED / LLM_ONLY) ---------------------
(async function(){
  const status = $('#chatModeStatus');
  const radios = [...document.querySelectorAll('input[name="chatMode"]')];
  if (!radios.length) return;
  const setUI = m => (radios.find(r=>r.value===m) || radios[1]).checked = true;

  try {
    const d = await api('/admin/bot-mode'); setUI(d.mode || 'KB_PREFERRED');
    status && (status.textContent = `Aktuell: ${d.mode}`);
  } catch {}

  $('#btnChatModeSave')?.addEventListener('click', async ()=>{
    const val = (radios.find(r=>r.checked)||{}).value;
    try {
      await api('/admin/bot-mode', { method:'PUT', body: JSON.stringify({ mode: val }) });
      status && (status.textContent = `Gespeichert: ${val}`);
    } catch(e){
      status && (status.textContent = e.message || 'Fehler');
    }
  });
})();

// ---- Prompt-Kachel: Laden/Speichern/Testen -------------------------------
(async function(){
  const txt = $('#admPrompt'), temp = $('#admTemp'), mdl = $('#admModel');
  const st  = $('#promptStatus'), btnSave = $('#btnPromptSave'), btnTest = $('#btnPromptTest');
  if (!txt || !temp || !mdl) return;

  // Laden
  try {
    const r = await fetch('/api/admin/prompt', { credentials:'include' });
    const d = await r.json();
    if (d && d.system_prompt !== undefined) {
      if (typeof d.system_prompt === 'string') txt.value = d.system_prompt;
      if (d.temperature != null) temp.value = d.temperature;
      if (d.model) mdl.value = d.model;
      st && (st.textContent = 'Geladen');
    }
  } catch {}

  // Speichern (LIVE)
  btnSave?.addEventListener('click', async ()=>{
    st && (st.textContent = 'Speichere…');
    const body = { system_prompt: txt.value, temperature: parseFloat(temp.value||'0.3'), model: mdl.value };
    try {
      const r = await fetch('/api/admin/prompt', {
        method:'PUT', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(()=>({}));
      st && (st.textContent = d.ok ? 'Gespeichert' : (d.error||'Fehler'));
    } catch (e) {
      st && (st.textContent = e.message || 'Fehler');
    }
  });

  // Testen (zeigt IMMER etwas an – auch bei Server/Model-Fehlern)
  btnTest?.addEventListener('click', async ()=>{
    const outEl = document.getElementById('admAnswer');
    outEl && (outEl.textContent = '⏳ teste…');
    st && (st.textContent = 'Teste…');

    const body = {
      system_prompt: txt.value,
      temperature: parseFloat(temp.value || '0.3'),
      model: mdl.value,
      input: 'Erkläre in 1 Satz, was du kannst.'
    };

    try {
      const r  = await fetch('/api/admin/prompt/test', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type':'application/json' },
        body: JSON.stringify(body)
      });
      const ct = r.headers.get('content-type') || '';
      const d  = ct.includes('application/json') ? await r.json()
                                                 : { ok:false, output:'', error: await r.text() };

      const text = (d && (d.output || d.error)) ||
                   `[CLIENT Fallback]\nPrompt: "${(body.system_prompt||'').replace(/\s+/g,' ').slice(0,120)}${(body.system_prompt||'').length>120?'…':''}"\nAntwort: (Server gab keinen Text zurück)`;

      outEl && (outEl.textContent = text);
      st && (st.textContent = d?.ok ? 'Test ok' : 'Fehler beim Test');
      console.debug('prompt/test response:', d);
    } catch (e) {
      outEl && (outEl.textContent = `[CLIENT Error] ${e.message || String(e)}`);
      st && (st.textContent = 'Fehler');
    }
  });
})();
