const session      = require('express-session');
const { SQLiteStore } = require('../db/sessionStore');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';

const sessionMiddleware = session({
  store: new SQLiteStore(),
  secret: SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
});

function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Not authenticated.' });
}

module.exports = { sessionMiddleware, requireAuth };
