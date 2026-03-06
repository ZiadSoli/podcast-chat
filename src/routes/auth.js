const express  = require('express');
const crypto   = require('crypto');
const { db }   = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { sendMagicLinkEmail } = require('../services/email');

const router = express.Router();

// ── Prepared statements: auth ─────────────────────────────────────────────────
const stmtInsertUser     = db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)');
const stmtGetUserByEmail = db.prepare('SELECT id, email FROM users WHERE email = ?');
const stmtGetUserById    = db.prepare('SELECT id, email FROM users WHERE id = ?');
const stmtInsertToken    = db.prepare('INSERT INTO magic_tokens (token, user_id, expires_at) VALUES (?, ?, ?)');
const stmtGetToken       = db.prepare('SELECT * FROM magic_tokens WHERE token = ?');
const stmtDeleteToken    = db.prepare('DELETE FROM magic_tokens WHERE token = ?');
const stmtCleanTokens    = db.prepare('DELETE FROM magic_tokens WHERE expires_at < ?');

// Current user
router.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ email: req.session.email });
});

// Request a magic link
router.post('/api/auth/request', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  stmtInsertUser.run(email, Date.now());
  const user = stmtGetUserByEmail.get(email);

  stmtCleanTokens.run(Date.now());

  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
  stmtInsertToken.run(token, user.id, expiresAt);

  try {
    await sendMagicLinkEmail(email, token);
    res.json({ ok: true });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: `Email error: ${err.message}` });
  }
});

// Step 1 — Email link lands here. Only validate, never consume.
// Email security scanners follow GET links; we must not consume the token on GET.
router.get('/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login.html?error=missing_token');

  const row = stmtGetToken.get(token);
  if (!row) return res.redirect('/login.html?error=invalid_token');

  if (row.expires_at < Date.now()) {
    stmtDeleteToken.run(token);
    return res.redirect('/login.html?error=expired_token');
  }

  // Show a confirmation page — scanner-safe, token NOT consumed yet
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in — Podcast Chat</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: 'Inter', system-ui, sans-serif; font-size: 14px;
           background: #f8fafc; display: flex; align-items: center;
           justify-content: center; min-height: 100dvh; padding: 24px; }
    .card { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px;
            padding: 36px 32px; width: 100%; max-width: 400px; text-align: center; }
    .icon { width: 48px; height: 48px; background: #eff6ff; border-radius: 50%;
            display: flex; align-items: center; justify-content: center;
            margin: 0 auto 16px; color: #2563eb; }
    h1 { font-size: 18px; font-weight: 600; margin-bottom: 8px; }
    p  { font-size: 13px; color: #64748b; margin-bottom: 24px; line-height: 1.5; }
    button { width: 100%; padding: 10px 16px; background: #2563eb; color: #fff;
             border: none; border-radius: 8px; font-size: 14px; font-weight: 500;
             cursor: pointer; font-family: inherit; }
    button:hover { background: #1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3z"/>
        <path d="M19 10v2a7 7 0 0 1-14 0v-2"/>
        <line x1="12" y1="19" x2="12" y2="23"/>
        <line x1="8" y1="23" x2="16" y2="23"/>
      </svg>
    </div>
    <h1>Sign in to Podcast Chat</h1>
    <p>Click the button below to complete your sign-in.</p>
    <form method="POST" action="/auth/verify">
      <input type="hidden" name="token" value="${token}" />
      <button type="submit">Sign in</button>
    </form>
  </div>
</body>
</html>`);
});

// Step 2 — User clicks "Sign in". Consume token and create session.
router.post('/auth/verify', express.urlencoded({ extended: false }), (req, res) => {
  const { token } = req.body;
  if (!token) return res.redirect('/login.html?error=missing_token');

  const row = stmtGetToken.get(token);
  if (!row) return res.redirect('/login.html?error=invalid_token');

  if (row.expires_at < Date.now()) {
    stmtDeleteToken.run(token);
    return res.redirect('/login.html?error=expired_token');
  }

  stmtDeleteToken.run(token);

  const user = stmtGetUserById.get(row.user_id);
  if (!user) return res.redirect('/login.html?error=invalid_token');

  req.session.regenerate(err => {
    if (err) return res.redirect('/login.html?error=server_error');
    req.session.userId = user.id;
    req.session.email  = user.email;
    req.session.save(err2 => {
      if (err2) return res.redirect('/login.html?error=server_error');
      res.redirect('/');
    });
  });
});

// Logout
router.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

module.exports = router;
