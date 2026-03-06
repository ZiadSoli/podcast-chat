const { db }                    = require('../db/index');
const { getEpisodesSince }       = require('./podcastindex');
const { sendCollectionSummary }  = require('./email');

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtAllCollections = db.prepare('SELECT * FROM collections');
const stmtGetUser        = db.prepare('SELECT id, email FROM users WHERE id = ?');
const stmtGetFeeds       = db.prepare('SELECT * FROM collection_feeds WHERE collection_id = ?');
const stmtUpdateLastSent = db.prepare('UPDATE collections SET last_sent_at = ? WHERE id = ?');

// ── Due-time logic ────────────────────────────────────────────────────────────
// Daily:  fire if it has been at least 23 hours since last send (or never sent)
// Weekly: fire if it has been at least 6.5 days AND today matches the chosen day
function isDue(col, now, todayDow) {
  const sinceMs = col.last_sent_at ? now - col.last_sent_at : Infinity;
  if (col.frequency === 'daily')  return sinceMs >= 23 * 3_600_000;
  if (col.frequency === 'weekly') return sinceMs >= 6.5 * 24 * 3_600_000
                                      && todayDow === col.day_of_week;
  return false;
}

// ── Per-collection processing ─────────────────────────────────────────────────
async function processCollection(col) {
  const user  = stmtGetUser.get(col.user_id);
  const feeds = stmtGetFeeds.all(col.id);
  if (!user || !feeds.length) return;

  // First-ever send → look back 7 days; subsequent sends → since last_sent_at
  const sinceSeconds = col.last_sent_at
    ? Math.floor(col.last_sent_at / 1000)
    : Math.floor((Date.now() - 7 * 24 * 3_600_000) / 1000);

  const feedsWithEpisodes = await Promise.all(
    feeds.map(async feed => {
      try {
        const data = await getEpisodesSince(feed.feed_id, sinceSeconds);
        return { ...feed, episodes: (data.items || []).slice(0, 10) };
      } catch {
        return { ...feed, episodes: [] };
      }
    })
  );

  const hasEpisodes = feedsWithEpisodes.some(f => f.episodes.length > 0);

  if (!hasEpisodes && col.no_episodes_behavior === 'suppress') {
    // Advance the timestamp so we don't re-check immediately next tick
    stmtUpdateLastSent.run(Date.now(), col.id);
    return;
  }

  await sendCollectionSummary(user.email, col, feedsWithEpisodes);
  stmtUpdateLastSent.run(Date.now(), col.id);
}

// ── Tick ──────────────────────────────────────────────────────────────────────
function tick() {
  const now      = Date.now();
  const todayDow = new Date().getDay(); // 0 = Sunday … 6 = Saturday

  for (const col of stmtAllCollections.all()) {
    if (isDue(col, now, todayDow)) {
      processCollection(col).catch(err =>
        console.error(`[scheduler] collection ${col.id}: ${err.message}`)
      );
    }
  }
}

// ── Public API ────────────────────────────────────────────────────────────────
function startScheduler() {
  tick(); // Run immediately on startup — makes dev testing easy
  // .unref() means the interval won't prevent the Node process from exiting
  setInterval(tick, 15 * 60 * 1000).unref();
}

module.exports = { startScheduler };
