const form = document.getElementById('loginForm');
const errEl = document.getElementById('error');
const errMsg = document.getElementById('errorMessage');
const submitBtn = document.getElementById('submitBtn');
const submitText = document.getElementById('submitText');

const existingToken = localStorage.getItem('token');
const existingUser = JSON.parse(localStorage.getItem('user') || 'null');
if (existingToken && existingUser) {
  window.location.href = existingUser.role === 'admin' ? '/admin' : '/personnel';
}

function showError(msg) {
  errMsg.textContent = msg;
  errEl.classList.remove('hidden');
}

function clearError() {
  errEl.classList.add('hidden');
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  clearError();
  submitBtn.disabled = true;
  submitText.textContent = 'Signing in...';

  const fd = new FormData(form);
  const body = Object.fromEntries(fd);
  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      throw new Error(d.error || 'Login failed');
    }
    const { token, user } = await res.json();
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
    window.location.href = user.role === 'admin' ? '/admin' : '/personnel';
  } catch (err) {
    showError(err.message);
    submitBtn.disabled = false;
    submitText.textContent = 'Sign in';
  }
});
