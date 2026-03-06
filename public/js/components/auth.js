import { getMe, apiLogout } from '../api.js';

export function redirectIfUnauth(res) {
  if (res.status === 401) { location.href = '/login.html'; return true; }
  return false;
}

export async function initAuth() {
  const logoutBtn  = document.getElementById('logoutBtn');
  const userEmailEl = document.getElementById('userEmail');

  logoutBtn?.addEventListener('click', async () => {
    await apiLogout();
    location.href = '/login.html';
  });

  try {
    const res = await getMe();
    if (res.status === 401) { location.href = '/login.html'; return false; }
    const { email } = await res.json();
    if (userEmailEl) userEmailEl.textContent = email;
    return true;
  } catch {
    return true; // network error — let the app load and fail on next real request
  }
}
