'use strict';
document.getElementById('login').addEventListener('submit', async event => {
  event.preventDefault();
  const form = event.target;
  const error = document.getElementById('error');
  error.textContent = '';
  form.querySelector('button').disabled = true;
  try {
    const res = await fetch('/studio-api/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user: form.user.value, password: form.password.value }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) { error.textContent = body.error || '들어가지 못했습니다.'; return; }
    location.replace('/studio/studio.html');
  } catch {
    error.textContent = '서버에 연결하지 못했습니다.';
  } finally {
    form.querySelector('button').disabled = false;
  }
});
