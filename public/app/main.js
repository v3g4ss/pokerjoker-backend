// public/app/main.js
// ---------------------------
// Poker Joker - Frontend JS
// ---------------------------

// === DOM Handles ===
const chatBox   = document.getElementById('chatBox');
const input     = document.getElementById('userInput');
const button    = document.getElementById('sendButton');
const micButton = document.getElementById('micButton');
const menuToggle= document.getElementById('menu-toggle');
const menu      = document.querySelector('.menu');
const infoWindow= document.getElementById('infoWindow');
const logoutBtn = document.getElementById('logoutBtn');
const clearBtn  = document.getElementById('clearChatButton');
const speechStatus = document.getElementById('speechStatus');

const STORAGE_KEY = 'pokerjoker_chatlog';
let sendingInProgress = false;

// === Logout ===
if (logoutBtn) {
  logoutBtn.addEventListener('click', async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }); } catch {}
    location.href = '/login';
  });
}

// === Burger zeigen/verstecken ===
let activeItemId = null;
if (menuToggle && menu) {
  menuToggle.addEventListener('change', () => {
    const open = menuToggle.checked;
    menu.style.display = open ? 'block' : 'none';
    if (!open && infoWindow) {
      infoWindow.style.display = 'none';
      activeItemId = null;
    }
  });
}

let menuLoading = false;
let menuLoadedOnce = false;

async function loadMenu(location = 'live') {
  if (menuLoading || menuLoadedOnce) return; // kein Flooding
  menuLoading = true;
  try {
    const res = await fetch(`/api/menu?location=${location}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`menu-api failed: ${res.status}`);
    const j = await res.json();
    renderMenu(Array.isArray(j.items) ? j.items : []);
    menuLoadedOnce = true;
  } catch (e) {
    console.error('[menu] json parse error:', e);
  } finally {
    menuLoading = false;
  }
}

// === Dynamisches Untermenü vom Backend ===
(async function(){
  const ul = document.getElementById('submenu'); 
  if (!ul) return;

  try {
    // Erkennen, ob wir auf der Login-Seite sind:
    const onLoginPage = location.pathname.startsWith('/login');

    // Wenn Login-Seite -> nur Login-Menüs laden; sonst Live
    const loc = onLoginPage ? 'login' : 'live';

    // API mit passendem location-Parameter fragen
    const r = await fetch(`/api/menu?location=${loc}`, { credentials:'include' });
    const d = await r.json();

    // Nur aktive + passende Location anzeigen
    const items = (d.items || [])
      .filter(i => i.is_active && (i.location === 'both' || i.location === loc))
      .sort((a,b) => (a.position||0) - (b.position||0));

    ul.innerHTML = '';
    items.forEach(it => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="menu-item" data-id="${it.id}" data-slug="${it.slug||''}">${it.title}</button>`;
      ul.appendChild(li);
    });

    // Click-Handler wie gehabt:
    document.body.addEventListener('click', e => {
      const btn = e.target.closest('.menu-item'); 
      if (!btn) return;
      const id  = btn.dataset.id;
      const it  = items.find(x => String(x.id) === String(id));
      if (!it) return;

      if (activeItemId === id) {
        infoWindow.style.display = 'none';
        activeItemId = null;
        return;
      }

      const isContact =
        String(it.slug||'').toLowerCase() === 'contact' ||
        String(it.title||'').trim().toLowerCase() === 'contact' ||
        String(it.title||'').trim().toLowerCase() === 'kontakt';

      if (isContact) {
        const tpl = document.getElementById('contactTemplate');
        infoWindow.innerHTML = tpl ? tpl.innerHTML : (it.content_html || '');
      } else {
        infoWindow.innerHTML = it.content_html || '';
      }
      infoWindow.style.display = 'block';
      activeItemId = id;

      bindContactFormIfPresent();
    });
  } catch (e) {
    console.warn('Menu load failed:', e);
  }
})();

function bindContactFormIfPresent(){
  const form = document.getElementById('contactForm');
  if (!form) return;
  const status = document.getElementById('contactStatus');
  form.addEventListener('submit', async (e)=>{
    e.preventDefault();
    const payload = {
      name:    document.getElementById('contactName')?.value?.trim(),
      email:   document.getElementById('contactEmail')?.value?.trim(),
      subject: document.getElementById('contactSubject')?.value?.trim(),
      message: document.getElementById('contactMessage')?.value?.trim(),
    };
    if (status) status.textContent = 'Sende…';
    try{
      const r = await fetch('/api/messages', {
        method:'POST', credentials:'include',
        headers:{'Content-Type':'application/json'},
        body: JSON.stringify(payload)
      });
      const d = await r.json().catch(()=>({}));
      status.textContent = r.ok ? '✅ Gesendet!' : (d.message || 'Fehler');
      if (r.ok) form.reset();
    }catch{ status.textContent = 'Fehler beim Senden.'; }
  });
}

// ---------------------------
// Chat-Utils
// ---------------------------
function appendMessage(sender, text, save = true) {
  if (!chatBox) return;
  const msg = document.createElement('div');
  msg.classList.add('message', sender);
  const who = sender === 'bot' ? '🤖 Poker Joker' : (sender === 'meta' ? 'ℹ️' : '🧑‍💻 Du');
  msg.innerHTML = `<strong>${who}:</strong><br>${text}`;
  chatBox.appendChild(msg);  
}
// Chatverlauf aus Datenbank laden
async function loadChatFromDatabase() {
  try {
    const res = await fetch('/api/chat/history', { credentials: 'include' });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.history)) return;

    if (!chatBox?.hasChildNodes()) {
  for (const msg of data.history) {
    appendMessage(msg.role, msg.message, false);
  }
}
  } catch (err) {
    console.error('Fehler beim Laden der Chat-Historie:', err);
  }
}

// === Tipp-Erkennung / Hotkey-GUARD (robust) ===
const isTypingTarget = (el) => {
  if (!el) return false;
  const tag = el.tagName?.toLowerCase?.();
  if (tag === 'textarea') return true;
  if (tag === 'input') {
    const t = (el.type || 'text').toLowerCase();
    // alle typischen Text-Inputs
    return ['text','search','email','url','number','password','tel'].includes(t);
  }
  if (el.isContentEditable) return true;
  return false;
};
const isTypingNow = () =>
  isTypingTarget(document.activeElement) ||
  isTypingTarget(window.getSelection?.().anchorNode?.parentElement);

// IME/Komposition berücksichtigen (z. B. japanisch/chinesisch)
let isComposing = false;
document.addEventListener('compositionstart', () => { isComposing = true; }, true);
document.addEventListener('compositionend',   () => { isComposing = false; }, true);

// === Chat löschen (repariert) ===
function onClearChat() {
  try { localStorage.removeItem(STORAGE_KEY); } catch {}
  if (chatBox) chatBox.innerHTML = '';
  appendMessage('meta', '🧹 Verlauf gelöscht', false);
}
if (clearBtn) clearBtn.addEventListener('click', onClearChat);

// ---------------------------
// Tokens / Buy-in
// ---------------------------
const state = { balance: 0, purchased: 0 };
const MIN_BAL = 100; // Wird im Backend geprüft, daher hier minimal setzen

function updateGuardUI() {
  const sendBtn = document.getElementById('sendButton');
  const inputEl = document.getElementById('userInput');
  const locked = state.balance < MIN_BAL;
  if (sendBtn) {
    sendBtn.disabled = locked;
    sendBtn.style.opacity = locked ? '0.5' : '1';
    sendBtn.title = locked ? '🔋 Zu wenig Tokens. Bitte Buy-in!' : '';
  }
  if (inputEl) {
    inputEl.placeholder = locked ? 'Zu wenig Tokens. Bitte Buy-in!' : 'Ask me about poker, Digga...';
  }
}

function renderTokens(d) {
  console.log('[DEBUG] Tokens geladen:', d);
  state.balance = d?.balance ?? 0;
  state.purchased = d?.purchased ?? 0;

  const balEl = document.getElementById('tokenBalance');
  const purEl = document.getElementById('tokenPurchased');

  if (balEl) balEl.textContent = state.balance;
  if (purEl) purEl.textContent = state.purchased;

  updateGuardUI(); // ← Das prüft, ob gesperrt werden muss
}

async function fetchTokens() {
  try {
    const r = await fetch('/api/tokens', { credentials: 'include' });
    console.log('[DEBUG] fetch /api/tokens → response', r);

    if (!r.ok) return null;

    const d = await r.json();
    console.log('[DEBUG] fetch /api/tokens → JSON', d);

    return d && d.ok ? d : null;
  } catch (err) {
    console.warn('[DEBUG] fetchTokens ERROR:', err);
    return null;
  }
}

async function refreshTokenUI() {
  try {
    const d = await fetchTokens();
    if (d) renderTokens(d);
  } catch {}
}

// === Init / Hooks ===
document.addEventListener('DOMContentLoaded', refreshTokenUI);
console.log('[DEBUG] DOM ready → Token UI wird geladen');


// === Init / Hooks ===
document.addEventListener('DOMContentLoaded', async () => {
  console.log('[DEBUG] DOM ready + Token UI wird geladen');

  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.status === 401) console.warn('Nicht eingeloggt');
  } catch {}

  // Tokens sofort laden
  await refreshTokenUI();

  // 🔄 Chatverlauf aus Datenbank laden
  await loadChatFromDatabase();

  // Chat-Eingabe binden
  if (typeof chatBox !== 'undefined' && chatBox && input && button) {
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    input.addEventListener('keyup',   (e) => e.stopPropagation());
    input.addEventListener('keypress',(e) => e.stopPropagation());
    button.addEventListener('click',  sendMessage);
  }
});

// === Nach erfolgreichem Buy-in (Stripe/PayPal) – Success-Seite leitet zurück
if (location.pathname.endsWith('/app/pay-success.html')) {
  setTimeout(() => { window.location.href = '/app'; }, 800);
}

// beim Laden:
document.addEventListener('DOMContentLoaded', refreshTokenUI);

// === Nach erfolgreichem Buy-in (Stripe/PayPal) – Success-Seite leitet zurück
if (location.pathname.endsWith('/app/pay-success.html')) {
  setTimeout(() => { window.location.href = '/app'; }, 800);
}

// === DOM Ready – EINMAL
document.addEventListener('DOMContentLoaded', async () => {
  try {
    const r = await fetch('/api/auth/me', { credentials: 'include' });
    if (r.status === 401) console.warn('Nicht eingeloggt');
  } catch {}

  document.addEventListener('DOMContentLoaded', async () => {
  // ...
  await loadChatHistory(); // <-- Chatverlauf anzeigen
});

  // Tokens sofort laden
  await refreshTokenUI();

  // Falls du die Checkout-Handler NICHT schon woanders bindest, hier aktivieren:
  // document.getElementById('buyinBtn')?.addEventListener('click', startStripeCheckout);
  // document.getElementById('buyinBtnPaypal')?.addEventListener('click', startPaypalCheckout);

  // UI initialisieren
  await refreshTokenUI();
  await loadChatFromDatabase();


  // Chat-Eingabe binden (Variablen müssen vorher existieren)
  if (typeof chatBox !== 'undefined' && chatBox && input && button) {
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    input.addEventListener('keyup',    (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());
    button.addEventListener('click', sendMessage);
  }
});

// Chatverlauf laden
async function loadChatHistory() {
  try {
    const res = await fetch('/api/chat/history', { credentials: 'include' });
    const data = await res.json();
    if (!data.ok || !Array.isArray(data.history)) return;

    for (const msg of data.history) {
      appendMessage(msg.role, msg.message);
    }
  } catch (err) {
    console.error('Fehler beim Laden des Chatverlaufs:', err);
  }
}

// === Mic & Hotkeys (robust, Hold-X + Button) =======================
(function initMicHotkeys(){
  if (window.__pjMicInit) return;
  window.__pjMicInit = true;

  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const setStatus = t => { if (speechStatus) speechStatus.textContent = t || ''; };

  const isTypingNow = () =>
    isTypingTarget(document.activeElement) ||
    isTypingTarget(window.getSelection?.().anchorNode?.parentElement);

  let composing = false;
  document.addEventListener('compositionstart', () => { composing = true;  }, true);
  document.addEventListener('compositionend',   () => { composing = false; }, true);

  // ---- SR State ----
  let rec = null;
  let listening = false;
  let holdMode = false;     // true = X wird gehalten
  let lastResultAt = 0;
  const PAUSE_MS = 900;

  function ensureSentenceClosed() {
  if (!input) return;
  let v = (input.value || '').trimEnd();
  if (!v) return;
  if (!/[.!?…]$/.test(v)) v += '.';
  if (!/\s$/.test(v)) v += ' ';
  input.value = v;
}

  function startSR(mode /* 'hold' | 'button' */) {
    if (!SR) { setStatus('Dein Browser unterstützt Sprache nicht.'); return; }
    if (listening) return;

    holdMode = (mode === 'hold');
    lastResultAt = 0;
    input?.blur();

    rec = new SR();
    rec.lang = 'de-DE';
    rec.continuous = true;
    rec.interimResults = false;

    listening = true;
    setStatus(holdMode ? '🎙️ Aufnahme (X halten)…' : '🎙️ Aufnahme läuft…');

    rec.onresult = (ev) => {
      const res = ev.results?.[ev.results.length - 1];
      if (!res?.isFinal) return;
      const txt = (res[0]?.transcript || '').trim();
      if (!txt || !input) return;

      const now = Date.now();
      if (lastResultAt && (now - lastResultAt) >= PAUSE_MS) {
        // Sprechpause -> Satz sauber schließen
        ensureSentenceClosed();
      }

      const needsSpace = input.value && !/\s$/.test(input.value);
      input.value = (input.value || '') + (needsSpace ? ' ' : '') + txt;
      lastResultAt = now;
    };

    rec.onerror = () => {
      listening = false;
      setStatus('❌ Mic-Fehler');
      try { rec.stop(); } catch {}
    };
    rec.onend = () => {
      listening = false;
      if (!holdMode) setStatus('');
    };

    try { rec.start(); } catch {}
  }

  function stopSR(send = true) {
    if (!listening) return;
    listening = false;
    try { rec?.stop(); } catch {}
    rec = null;

    // Letztes Fragment sauber beenden
    ensureSentenceClosed();
    setStatus('');

    const val = (input?.value || '').trim();
    if (send && val) sendMessage();

    // Cursor bleibt draußen, damit man sofort neu starten kann
    input?.blur();
  }

  // Mic-Button: Klick toggelt; beim Stop wird gesendet
  if (micButton) {
    micButton.addEventListener('click', () => {
      if (!listening) startSR('button');
      else            stopSR(true);
    });
  }

  // ---- Hotkeys ----
  function onKeyDown(e){
    // Hotkeys nur, wenn NICHT getippt/komponiert wird
    if (isTypingTarget(e.target) || isTypingNow() || composing) return;

    // X halten → aufnehmen
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      if (!listening && !e.repeat) startSR('hold');
      return;
    }

    // C → letzten Satz löschen – mehrfach möglich
    if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      deleteLastSentence();
      // WICHTIG: kein input.focus() während Aufnahme, sonst wird C blockiert
      if (!listening && input) { input.focus(); const n = input.value.length; input.setSelectionRange(n, n); }
    }
  }

  function onKeyUp(e){
    if (isTypingTarget(e.target) || isTypingNow() || composing) return;

    // X loslassen → nur im Hold-Modus stoppen & senden
    if ((e.key === 'x' || e.key === 'X') && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); e.stopPropagation();
      if (listening && holdMode) stopSR(true);
      holdMode = false;
    }
  }

  document.addEventListener('keydown', onKeyDown, true);
  document.addEventListener('keyup',   onKeyUp,   true);

  // Input entkoppeln: globale Hotkeys nie abfeuern, wenn man tippt
  if (input) {
    ['keydown','keyup','keypress'].forEach(ev =>
      input.addEventListener(ev, e => e.stopPropagation())
    );
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
  }
})(); // === Ende Mic & Hotkeys


// ---------------------------
// Senden
// ---------------------------
function sendMessage() {
  if (sendingInProgress) return;
  const message = (input?.value || '').trim();
  if (!message) return;

  // NEU: auf state.balance prüfen
  if (state.balance < MIN_BAL) {
    appendMessage('bot', '🔋 Zu wenig Tokens. Bitte Buy-in!');
    return;
  }

  sendingInProgress = true;
  appendMessage('user', message);
  if (input) input.value = '';
  sendToBot(message).finally(() => { sendingInProgress = false; });
}
window.sendMessage = sendMessage;

async function sendToBot(message) {
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, topK: 6 })
    });

    if (res.status === 401) {
      appendMessage('bot', '⛔ Nicht eingeloggt. Ich schick dich kurz zum Login…');
      setTimeout(() => (location.href = '/login'), 900);
      return;
    }

    if (res.status === 402) {
      // NEU: frische Tokens ziehen statt tokensLeft/updateTokenDisplay
      try { await refreshTokenUI(); } catch {}
      const d = await res.json().catch(() => ({}));
      appendMessage('bot', d.reply || 'Zu wenig Tokens. Bitte Buy-in!');
      return;
    }

    if (!res.ok) {
      const payload = await res.text();
      appendMessage('bot', `🛑 Fehler ${res.status} ${payload || ''}`);
      return;
    }

    const data = await res.json().catch(() => ({}));
    appendMessage('bot', data.reply || '…');

    // NEU: nach erfolgreicher Antwort neu einlesen (zieht auch -50 ab)
    try { await refreshTokenUI(); } catch {}

    if (data.sources && Array.isArray(data.sources) && data.sources.length) {
      const seen = new Set();
      const titles = data.sources
        .map(s => (s && String(s.title || '').trim()))
        .filter(Boolean)
        .filter(t => (seen.has(t) ? false : (seen.add(t), true)));
      const top  = titles.slice(0, 3);
      const more = Math.max(0, titles.length - top.length);
      const line = 'Quellen: ' + top.join(' • ') + (more ? ` (+${more})` : '');
      appendMessage('meta', line);
    }
  } catch (err) {
    console.error(err);
    appendMessage('bot', '🛑 Netzwerkfehler. Versuch’s gleich nochmal.');
  }
}

// ---------------------------
// Letzten Satz löschen – Satzzeichen bleiben
// ---------------------------
function deleteLastSentence() {
  if (!input || typeof input.value !== 'string') return;

  const v = input.value.replace(/\s+$/, ''); // Trailing Spaces ab
  if (!v) { input.value = ''; return; }

  // Endpositionen HINTER Satzzeichen sammeln (. ! ? …)
  const re = /[.!?…]+/g;
  const ends = [];
  let m;
  while ((m = re.exec(v)) !== null) ends.push(m.index + m[0].length);

  if (ends.length === 0) { input.value = ''; return; }

  const lastEnd = ends[ends.length - 1];
  const endsWithTerminator = (lastEnd === v.length);

  let keepUpto;
  if (endsWithTerminator) {
    // Letzter Satz abgeschlossen -> kompletten letzten Satz weg;
    // vorletzte Grenze (inkl. Zeichen) bleibt stehen
    keepUpto = (ends.length >= 2) ? ends[ends.length - 2] : 0;
  } else {
    // Im laufenden Satz: ab letzter Grenze weg
    keepUpto = lastEnd;
  }

  input.value = v.slice(0, keepUpto) + (keepUpto ? ' ' : '');
}
window.deleteLastSentence = deleteLastSentence;

// === Buy-in Button → Weiterleitung auf pay.html ===
document.getElementById('buyinBtn')?.addEventListener('click', () => {
  window.location.href = '/app/pay.html';
});

