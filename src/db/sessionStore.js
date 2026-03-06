const session = require('express-session');
const { db }  = require('./index');

// ── Prepared statements: sessions ────────────────────────────────────────────
const stmtGetSession     = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
const stmtSetSession     = db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)');
const stmtDestroySession = db.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtTouchSession   = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
const stmtCleanSessions  = db.prepare('DELETE FROM sessions WHERE expires < ?');

class SQLiteStore extends session.Store {
  constructor() {
    super();
    setInterval(() => stmtCleanSessions.run(Date.now()), 10 * 60 * 1000).unref();
  }

  get(sid, cb) {
    const row = stmtGetSession.get(sid);
    if (!row || row.expires < Date.now()) return cb(null, null);
    try { cb(null, JSON.parse(row.data)); } catch { cb(null, null); }
  }

  set(sid, sess, cb) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    stmtSetSession.run(sid, JSON.stringify(sess), expires);
    cb(null);
  }

  destroy(sid, cb) {
    stmtDestroySession.run(sid);
    cb(null);
  }

  touch(sid, sess, cb) {
    const expires = sess.cookie?.expires
      ? new Date(sess.cookie.expires).getTime()
      : Date.now() + 30 * 24 * 60 * 60 * 1000;
    stmtTouchSession.run(expires, sid);
    cb(null);
  }
}

module.exports = { SQLiteStore };
