require('dotenv').config();
const express = require('express');
const session = require('express-session');
const crypto  = require('crypto');
const axios   = require('axios');
const FormData   = require('form-data');
const path       = require('path');
const fs         = require('fs');
const Database   = require('better-sqlite3');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LISTENNOTES_API_KEY = process.env.LISTENNOTES_API_KEY;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const PORT           = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-secret-change-me';
const BASE_URL       = process.env.BASE_URL || `http://localhost:${PORT}`;
const RESEND_API_KEY = process.env.RESEND_API_KEY;
const EMAIL_FROM     = process.env.EMAIL_FROM || 'noreply@example.com';

const LISTENNOTES_BASE = 'https://listen-api.listennotes.com/api/v2';
const listennotes = (endpoint, params = {}) =>
  axios.get(`${LISTENNOTES_BASE}${endpoint}`, {
    headers: { 'X-ListenAPI-Key': LISTENNOTES_API_KEY },
    params,
  });

// ── SQLite store ──────────────────────────────────────────────────────────────
const DATA_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || path.join(__dirname, 'data');
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

// ── Prepared statements: auth ─────────────────────────────────────────────────
const stmtInsertUser      = db.prepare('INSERT OR IGNORE INTO users (email, created_at) VALUES (?, ?)');
const stmtGetUserByEmail  = db.prepare('SELECT id, email FROM users WHERE email = ?');
const stmtGetUserById     = db.prepare('SELECT id, email FROM users WHERE id = ?');
const stmtInsertToken     = db.prepare('INSERT INTO magic_tokens (token, user_id, expires_at) VALUES (?, ?, ?)');
const stmtGetToken        = db.prepare('SELECT * FROM magic_tokens WHERE token = ?');
const stmtDeleteToken     = db.prepare('DELETE FROM magic_tokens WHERE token = ?');
const stmtCleanTokens     = db.prepare('DELETE FROM magic_tokens WHERE expires_at < ?');

// ── Prepared statements: sessions ────────────────────────────────────────────
const stmtGetSession     = db.prepare('SELECT data, expires FROM sessions WHERE sid = ?');
const stmtSetSession     = db.prepare('INSERT OR REPLACE INTO sessions (sid, data, expires) VALUES (?, ?, ?)');
const stmtDestroySession = db.prepare('DELETE FROM sessions WHERE sid = ?');
const stmtTouchSession   = db.prepare('UPDATE sessions SET expires = ? WHERE sid = ?');
const stmtCleanSessions  = db.prepare('DELETE FROM sessions WHERE expires < ?');

// ── Custom SQLite session store ───────────────────────────────────────────────
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

// ── Session middleware ────────────────────────────────────────────────────────
app.use(session({
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
}));

// ── Email (Resend HTTP API) ───────────────────────────────────────────────────
async function sendMagicLinkEmail(email, token) {
  const link = `${BASE_URL}/auth/verify?token=${token}`;

  if (!RESEND_API_KEY) {
    // Dev mode: print to console instead of sending
    console.log(`\n  ── Magic link for ${email} ──`);
    console.log(`  ${link}\n`);
    return;
  }

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: EMAIL_FROM,
      to: [email],
      subject: 'Your sign-in link for Podcast Chat',
      html: `
        <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:40px 24px">
          <h2 style="margin:0 0 8px;font-size:20px">Sign in to Podcast Chat</h2>
          <p style="color:#555;margin:0 0 24px">Click the button below to sign in. This link expires in 15 minutes and can only be used once.</p>
          <a href="${link}" style="display:inline-block;background:#18181b;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:500">Sign in</a>
          <p style="color:#888;font-size:13px;margin:24px 0 0">If you didn't request this, you can safely ignore it.</p>
        </div>
      `,
      text: `Sign in to Podcast Chat: ${link}\n\nThis link expires in 15 minutes.`,
    },
    {
      headers: {
        Authorization: `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// ── Auth middleware ───────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.userId) return next();
  res.status(401).json({ error: 'Not authenticated.' });
}

// ── Auth routes (no auth required) ───────────────────────────────────────────

// Current user
app.get('/api/auth/me', (req, res) => {
  if (!req.session?.userId) return res.status(401).json({ error: 'Not authenticated.' });
  res.json({ email: req.session.email });
});

// Request a magic link
app.post('/api/auth/request', async (req, res) => {
  const email = (req.body.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }

  // Upsert user
  stmtInsertUser.run(email, Date.now());
  const user = stmtGetUserByEmail.get(email);

  // Clean up expired tokens
  stmtCleanTokens.run(Date.now());

  // Generate one-time token (256 bits of entropy)
  const token     = crypto.randomBytes(32).toString('hex');
  const expiresAt = Date.now() + 15 * 60 * 1000; // 15 minutes
  stmtInsertToken.run(token, user.id, expiresAt);

  try {
    await sendMagicLinkEmail(email, token);
    res.json({ ok: true });
  } catch (err) {
    console.error('Email send error:', err.message);
    res.status(500).json({ error: 'Failed to send email. Please try again.' });
  }
});

// Verify magic link token — called when user clicks the email link
app.get('/auth/verify', (req, res) => {
  const { token } = req.query;
  if (!token) return res.redirect('/login.html?error=missing_token');

  const row = stmtGetToken.get(token);
  if (!row) return res.redirect('/login.html?error=invalid_token');

  if (row.expires_at < Date.now()) {
    stmtDeleteToken.run(token);
    return res.redirect('/login.html?error=expired_token');
  }

  // Consume the token (one-time use)
  stmtDeleteToken.run(token);

  const user = stmtGetUserById.get(row.user_id);
  if (!user) return res.redirect('/login.html?error=invalid_token');

  // Regenerate session to prevent fixation attacks
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
app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => {
    res.clearCookie('connect.sid');
    res.json({ ok: true });
  });
});

// ── Transcription job store ───────────────────────────────────────────────────
const jobs = new Map();
let jobSeq = 0;

function createJob() {
  const id = `job_${++jobSeq}_${Date.now()}`;
  jobs.set(id, { status: 'pending', transcript: null, error: null, createdAt: Date.now() });
  for (const [jid, j] of jobs) {
    if (Date.now() - j.createdAt > 30 * 60 * 1000) jobs.delete(jid);
  }
  return id;
}

// ── Background transcription ──────────────────────────────────────────────────
const AUDIO_LIMIT = 24.5 * 1024 * 1024;

async function transcribeEpisode(episodeId, jobId) {
  const job = jobs.get(jobId);

  try {
    job.status = 'fetching';
    const { data: episode } = await listennotes(`/episodes/${episodeId}`);

    if (!episode.audio) {
      throw new Error('No audio URL found for this episode. The podcast may not expose a direct MP3 link.');
    }

    job.status = 'downloading';
    const audioBuffer = await downloadAudio(episode.audio);

    job.status = 'transcribing';
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
      knownLength: audioBuffer.length,
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const whisperRes = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600_000,
      }
    );

    const transcript = typeof whisperRes.data === 'string'
      ? whisperRes.data
      : whisperRes.data.text || JSON.stringify(whisperRes.data);

    job.status     = 'done';
    job.transcript = transcript;

    putCached(episodeId, {
      transcript,
      title:     episode.title,
      podcast:   episode.podcast?.title || null,
      thumbnail: episode.thumbnail || episode.podcast?.thumbnail || null,
    });

  } catch (err) {
    job.status = 'error';
    job.error  = err.response?.data?.error?.message || err.message;
  }
}

async function downloadAudio(url) {
  const chunks = [];
  let total = 0;

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 90_000,
    headers: { Range: `bytes=0-${Math.ceil(AUDIO_LIMIT) - 1}` },
    validateStatus: s => s >= 200 && s < 300,
  });

  await new Promise((resolve, reject) => {
    response.data.on('data', chunk => {
      if (total < AUDIO_LIMIT) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= AUDIO_LIMIT) {
        response.data.destroy();
        resolve();
      }
    });
    response.data.on('end', resolve);
    response.data.on('error', reject);
    response.data.on('close', resolve);
  });

  return Buffer.concat(chunks);
}

// ── Protected routes ──────────────────────────────────────────────────────────

app.get('/api/search', requireAuth, async (req, res) => {
  const { q, offset = 0, type = 'podcast' } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  try {
    const { data } = await listennotes('/search', { q, type, language: 'English', sort_by_date: 0, offset });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

app.get('/api/podcast/:id/episodes', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { next_episode_pub_date } = req.query;
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  try {
    const params = { sort: 'recent_first' };
    if (next_episode_pub_date) params.next_episode_pub_date = next_episode_pub_date;

    const { data } = await listennotes(`/podcasts/${id}`, params);
    res.json({
      podcast: {
        id:             data.id,
        title:          data.title,
        publisher:      data.publisher,
        thumbnail:      data.thumbnail,
        total_episodes: data.total_episodes,
      },
      episodes: (data.episodes || []).map(ep => ({
        id:               ep.id,
        title:            ep.title,
        thumbnail:        ep.thumbnail || data.thumbnail,
        pub_date_ms:      ep.pub_date_ms,
        audio_length_sec: ep.audio_length_sec,
        cached:           hasCached(ep.id),
      })),
      next_episode_pub_date: data.next_episode_pub_date,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

app.post('/api/transcribe/:episodeId', requireAuth, (req, res) => {
  if (!OPENAI_API_KEY)      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured.' });
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  const { episodeId } = req.params;
  const jobId = createJob();

  const cached = getCached(episodeId);
  if (cached) {
    const job = jobs.get(jobId);
    job.status     = 'done';
    job.transcript = cached.transcript;
    return res.json({ jobId, cached: true });
  }

  res.json({ jobId, cached: false });
  transcribeEpisode(episodeId, jobId).catch(() => {});
});

app.get('/api/transcribe/job/:jobId', requireAuth, (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  const { transcript, ...rest } = job;
  res.json(job.status === 'done' ? job : rest);
});

app.post('/api/chat', requireAuth, async (req, res) => {
  const { messages, episodes } = req.body;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
  if (!messages?.length)  return res.status(400).json({ error: 'messages array is required.' });

  const MAX_CHARS = 12_000;
  const knowledgeBase = (episodes || [])
    .filter(e => e.transcript)
    .map(e => {
      const content   = e.transcript.slice(0, MAX_CHARS);
      const truncated = e.transcript.length > MAX_CHARS ? ' [truncated]' : '';
      return `### Episode: "${e.title}"${e.podcast ? ` (${e.podcast})` : ''}\n${content}${truncated}`;
    })
    .join('\n\n---\n\n');

  const systemPrompt = knowledgeBase.length > 0
    ? `You are a helpful assistant that answers questions about podcast episodes. Use the provided transcripts as your primary knowledge source. If the answer isn't in the transcripts, say so and offer general knowledge if appropriate.\n\nTranscripts:\n\n${knowledgeBase}`
    : 'You are a helpful assistant. No podcast transcripts have been loaded yet — ask the user to select and transcribe some episodes first.';

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-6', max_tokens: 1536, system: systemPrompt, messages },
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    res.json({ reply: data.content[0].text });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

app.get('/api/health', requireAuth, (req, res) => {
  res.json({
    status:      'ok',
    listennotes: !!LISTENNOTES_API_KEY,
    anthropic:   !!ANTHROPIC_API_KEY,
    openai:      !!OPENAI_API_KEY,
    cachedEpisodes: stmtCount.get().n,
  });
});

app.listen(PORT, () => {
  console.log(`\nPodcast Chat running at http://localhost:${PORT}`);
  console.log(`  ListenNotes: ${LISTENNOTES_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  Anthropic:   ${ANTHROPIC_API_KEY   ? 'set' : 'MISSING'}`);
  console.log(`  OpenAI:      ${OPENAI_API_KEY       ? 'set' : 'MISSING'}`);
  console.log(`  Email:       ${RESEND_API_KEY        ? 'Resend configured' : 'DEV MODE (links logged to console)'}`);
  console.log(`  Base URL:    ${BASE_URL}\n`);
});
