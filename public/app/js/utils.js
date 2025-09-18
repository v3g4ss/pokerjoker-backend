// public/js/utils.js

// Checkt ob der User eingeloggt ist, sonst → Redirect zum Login
function checkAuth() {
  return fetch('/api/auth/me', {
    method: 'GET',
    credentials: 'include'
  }).then(res => {
    if (res.status !== 200) {
      window.location.href = '/login';
    }
  }).catch(() => {
    window.location.href = '/login';
  });
}
