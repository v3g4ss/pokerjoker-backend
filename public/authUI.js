// === Modal-Elemente ===
const loginModal = document.getElementById("loginModal");
const signupModal = document.getElementById("signupModal");

function openLogin() {
  loginModal?.classList.remove("hidden");
}
function closeLogin() {
  loginModal?.classList.add("hidden");
}
function openSignup() {
  signupModal?.classList.remove("hidden");
}
function closeSignup() {
  signupModal?.classList.add("hidden");
}

// ---- Login ----
async function login() {
  const email = document.getElementById('loginEmail')?.value.trim();      // NICHT username
  const password = document.getElementById('loginPassword')?.value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',                                // Cookie setzen!
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Login fehlgeschlagen');

    // Redirect
    location.href = data.redirect || (data.user?.is_admin ? '/admin' : '/app');
  } catch (err) {
    console.error('❌ Login-Fehler:', err);
    alert(err.message);
  }
}

// ---- Signup ----
async function signup() {
  const email = document.getElementById('signupEmail')?.value.trim();     // NICHT username
  const password = document.getElementById('signupPassword')?.value;

  try {
    const res = await fetch('/api/auth/signup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',                                // Cookie setzen!
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.message || 'Signup fehlgeschlagen');

    // Redirect
    location.href = data.redirect || '/app';
  } catch (err) {
    console.error('❌ Signup-Fehler:', err);
    alert(err.message);
  }
}

// === „Passwort vergessen?“ – UI + Request ===
(function setupForgot() {
  const forgotLink  = document.getElementById('forgotLink');
  const forgotForm  = document.getElementById('forgotForm');
  const forgotEmail = document.getElementById('forgotEmail');
  const forgotMsg   = document.getElementById('forgotMsg');

  const loginEmail  = document.getElementById('loginEmail'); // zum Auto-Füllen aus dem Login-Feld

  if (!forgotLink || !forgotForm || !forgotEmail || !forgotMsg) return; // Seite ohne Forgot-UI

  // Toggle anzeigen/ausblenden
  forgotLink.addEventListener('click', (e) => {
    e.preventDefault();
    const visible = forgotForm.style.display === 'block';
    if (!visible && loginEmail?.value) forgotEmail.value = loginEmail.value;
    forgotForm.style.display = visible ? 'none' : 'block';
    forgotMsg.textContent = '';
  });

  // Absenden
  forgotForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = forgotEmail.value.trim();
    if (!email) {
      forgotMsg.textContent = 'Bitte E-Mail eingeben.';
      return;
    }
    forgotMsg.textContent = 'Sende Link...';

    try {
      const r = await fetch('/api/auth/forgot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ email })
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.ok) {
        // Mail kann optional fehlschlagen – der Link steht immer im Server-Log
        forgotMsg.textContent = 'Wenn die E-Mail existiert, wurde ein Reset-Link gesendet (siehe Server-Konsole).';
      } else {
        forgotMsg.textContent = d.message || 'Fehler beim Anfordern.';
      }
    } catch (err) {
      console.error('❌ Forgot-Fehler:', err);
      forgotMsg.textContent = 'Netzwerkfehler.';
    }
  });
})();

// === Menü auf der Login-Seite laden ===
(async function(){
  const ul = document.getElementById('submenu'); 
  if (!ul) return; // falls kein Menü existiert

  try {
    const r = await fetch('/api/menu?location=login', { credentials:'include' });
    const d = await r.json();

    const items = (d.items||[])
      .filter(i => i.is_active && (i.location === 'both' || i.location === 'login'))
      .sort((a,b) => (a.position||0) - (b.position||0));

    ul.innerHTML = '';
    items.forEach(it => {
      const li = document.createElement('li');
      li.innerHTML = `<button class="menu-item" data-id="${it.id}" data-slug="${it.slug||''}">${it.title}</button>`;
      ul.appendChild(li);
    });

    document.body.addEventListener('click', e => {
      const btn = e.target.closest('.menu-item'); 
      if (!btn) return;
      const id  = btn.dataset.id;
      const it  = items.find(x => String(x.id) === String(id));
      if (!it) return;

      const infoWindow = document.getElementById('infoWindow');
      if (!infoWindow) return;

      infoWindow.innerHTML = it.content_html || '';
      infoWindow.style.display = 'block';
    });
  } catch (e) {
    console.warn('[login-menu] Laden fehlgeschlagen:', e);
  }
})();

// === Funktionen global verfügbar machen ===
window.openLogin = openLogin;
window.closeLogin = closeLogin;
window.openSignup = openSignup;
window.closeSignup = closeSignup;
window.login = login;
window.signup = signup;

// === Upgrade-Button Funktion ===
function upgradeToPremium() {
  alert("Upgrade-Funktion kommt bald 😎");
}
window.upgradeToPremium = upgradeToPremium;
