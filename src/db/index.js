const path     = require('path');
const fs       = require('fs');
const Database = require('better-sqlite3');

const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, '../../data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'transcripts.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS transcripts (
    episode_id  TEXT PRIMARY KEY,
    transcript  TEXT NOT NULL,
    title       TEXT,
    podcast     TEXT,
    thumbnail   TEXT,
    cached_at   INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS users (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    email      TEXT UNIQUE NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS magic_tokens (
    token      TEXT PRIMARY KEY,
    user_id    INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    sid     TEXT PRIMARY KEY,
    data    TEXT NOT NULL,
    expires INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS jobs (
    id         TEXT PRIMARY KEY,
    episode_id TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'pending',
    transcript TEXT,
    error      TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS collections (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id              INTEGER NOT NULL,
    name                 TEXT NOT NULL,
    description          TEXT,
    frequency            TEXT NOT NULL DEFAULT 'weekly',
    day_of_week          INTEGER,
    no_episodes_behavior TEXT NOT NULL DEFAULT 'suppress',
    last_sent_at         INTEGER,
    created_at           INTEGER NOT NULL,
    updated_at           INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS collection_feeds (
    collection_id INTEGER NOT NULL,
    feed_id       TEXT NOT NULL,
    feed_title    TEXT,
    feed_thumbnail TEXT,
    added_at      INTEGER NOT NULL,
    PRIMARY KEY (collection_id, feed_id),
    FOREIGN KEY (collection_id) REFERENCES collections(id) ON DELETE CASCADE
  )
`);

// Migrate any existing JSON cache into SQLite then remove the old file
const LEGACY_CACHE = path.join(DATA_DIR, 'transcripts.json');
if (fs.existsSync(LEGACY_CACHE)) {
  try {
    const raw = JSON.parse(fs.readFileSync(LEGACY_CACHE, 'utf8'));
    const insert = db.prepare(`
      INSERT OR IGNORE INTO transcripts (episode_id, transcript, title, podcast, thumbnail, cached_at)
      VALUES (@episode_id, @transcript, @title, @podcast, @thumbnail, @cached_at)
    `);
    const migrate = db.transaction(entries => {
      for (const [id, e] of entries) {
        insert.run({ episode_id: id, transcript: e.transcript, title: e.title || null,
                     podcast: e.podcast || null, thumbnail: e.thumbnail || null,
                     cached_at: e.cachedAt || Date.now() });
      }
    });
    migrate(Object.entries(raw));
    fs.renameSync(LEGACY_CACHE, LEGACY_CACHE + '.migrated');
    console.log(`  Migrated ${Object.keys(raw).length} cached transcript(s) from JSON → SQLite`);
  } catch (err) {
    console.warn('  Could not migrate legacy cache:', err.message);
  }
}

// ── Prepared statements: transcripts ─────────────────────────────────────────
const stmtGet    = db.prepare('SELECT * FROM transcripts WHERE episode_id = ?');
const stmtUpsert = db.prepare(`
  INSERT INTO transcripts (episode_id, transcript, title, podcast, thumbnail, cached_at)
  VALUES (@episode_id, @transcript, @title, @podcast, @thumbnail, @cached_at)
  ON CONFLICT(episode_id) DO UPDATE SET
    transcript = excluded.transcript,
    title      = excluded.title,
    podcast    = excluded.podcast,
    thumbnail  = excluded.thumbnail,
    cached_at  = excluded.cached_at
`);
const stmtHas   = db.prepare('SELECT 1 FROM transcripts WHERE episode_id = ?');
const stmtCount = db.prepare('SELECT COUNT(*) AS n FROM transcripts');

function getCached(episodeId)  { return stmtGet.get(episodeId) || null; }
function hasCached(episodeId)  { return !!stmtHas.get(episodeId); }
function putCached(episodeId, { transcript, title, podcast, thumbnail }) {
  stmtUpsert.run({ episode_id: episodeId, transcript, title: title || null,
                   podcast: podcast || null, thumbnail: thumbnail || null,
                   cached_at: Date.now() });
}

const count = stmtCount.get().n;
console.log(`  Transcript store: ${count} episode(s) in SQLite DB`);

module.exports = { db, getCached, hasCached, putCached, stmtCount };
