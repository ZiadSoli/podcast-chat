require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path    = require('path');

const { sessionMiddleware } = require('./src/middleware/auth');
const authRoutes         = require('./src/routes/auth');
const searchRoutes       = require('./src/routes/search');
const transcribeRoutes   = require('./src/routes/transcribe');
const chatRoutes         = require('./src/routes/chat');
const collectionsRoutes  = require('./src/routes/collections');
const { startScheduler, checkCollection, processCollection } = require('./src/services/scheduler');
const { db } = require('./src/db/index');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(sessionMiddleware);

// Root: landing page for visitors, app for authenticated users
app.get('/', (req, res) => {
  if (req.session?.userId) {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  } else {
    res.sendFile(path.join(__dirname, 'public', 'landing.html'));
  }
});

app.use(express.static(path.join(__dirname, 'public')));

app.use('/',    authRoutes);
app.use('/api', searchRoutes);
app.use('/api', transcribeRoutes);
app.use('/api', chatRoutes);
app.use('/api', collectionsRoutes);

// ── Dev-only debug routes (only available when BASE_URL points to localhost) ──
const isDev = !process.env.BASE_URL || process.env.BASE_URL.includes('localhost');
if (isDev) {
  const stmtAllCols  = db.prepare('SELECT id, name, frequency, last_sent_at, last_checked_at FROM collections');
  const stmtQueueCount = db.prepare('SELECT COUNT(*) AS n FROM episode_queue WHERE collection_id = ?');

  // GET /api/debug/collections — overview of all collections + queue depth
  app.get('/api/debug/collections', (req, res) => {
    const cols = stmtAllCols.all().map(c => ({
      ...c,
      queued_episodes: stmtQueueCount.get(c.id).n,
      last_sent_at:    c.last_sent_at    ? new Date(c.last_sent_at).toISOString()    : null,
      last_checked_at: c.last_checked_at ? new Date(c.last_checked_at).toISOString() : null,
    }));
    res.json(cols);
  });

  // POST /api/debug/collections/:id/check — fetch new episodes + generate AI summaries
  app.post('/api/debug/collections/:id/check', async (req, res) => {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    // Reset last_checked_at so the check runs regardless of the 23h gate
    db.prepare('UPDATE collections SET last_checked_at = NULL WHERE id = ?').run(col.id);
    await checkCollection({ ...col, last_checked_at: null });
    const queued = stmtQueueCount.get(col.id).n;
    res.json({ ok: true, queued_episodes: queued });
  });

  // POST /api/debug/collections/:id/send — flush queue and send the summary email
  app.post('/api/debug/collections/:id/send', async (req, res) => {
    const col = db.prepare('SELECT * FROM collections WHERE id = ?').get(req.params.id);
    if (!col) return res.status(404).json({ error: 'Collection not found' });
    await processCollection(col);
    res.json({ ok: true, queue_after_send: stmtQueueCount.get(col.id).n });
  });
}

app.listen(PORT, () => {
  startScheduler();
  console.log(`\nPodcast Chat running at http://localhost:${PORT}`);
  console.log(`  PodcastIndex: ${process.env.PODCASTINDEX_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  Anthropic:    ${process.env.ANTHROPIC_API_KEY    ? 'set' : 'MISSING'}`);
  console.log(`  OpenAI:       ${process.env.OPENAI_API_KEY        ? 'set' : 'MISSING'}`);
  console.log(`  Email:        ${process.env.RESEND_API_KEY         ? 'Resend configured' : 'DEV MODE (links logged to console)'}`);
  console.log(`  Base URL:     ${process.env.BASE_URL || `http://localhost:${PORT}`}\n`);
});
