const { db }                    = require('../db/index');
const { getEpisodesSince }       = require('./podcastindex');
const { sendCollectionSummary }  = require('./email');
const { summarizeEpisode }       = require('./summarize');

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtAllCollections  = db.prepare('SELECT * FROM collections');
const stmtGetUser         = db.prepare('SELECT id, email FROM users WHERE id = ?');
const stmtGetFeeds        = db.prepare('SELECT * FROM collection_feeds WHERE collection_id = ?');
const stmtUpdateLastSent  = db.prepare('UPDATE collections SET last_sent_at = ? WHERE id = ?');
const stmtUpdateChecked   = db.prepare('UPDATE collections SET last_checked_at = ? WHERE id = ?');
const stmtInsertQueue     = db.prepare(`
  INSERT OR IGNORE INTO episode_queue
    (collection_id, feed_id, feed_title, episode_id, episode_title,
     episode_url, date_published, ai_summary, queued_at)
  VALUES
    (@collection_id, @feed_id, @feed_title, @episode_id, @episode_title,
     @episode_url, @date_published, @ai_summary, @queued_at)
`);
const stmtGetQueue        = db.prepare('SELECT * FROM episode_queue WHERE collection_id = ? ORDER BY date_published ASC');
const stmtDeleteQueue     = db.prepare('DELETE FROM episode_queue WHERE collection_id = ?');
const stmtInsertArchive   = db.prepare(`
  INSERT INTO summary_archive
    (user_id, collection_id, collection_name, frequency, sent_at, total_episodes, created_at)
  VALUES
    (@user_id, @collection_id, @collection_name, @frequency, @sent_at, @total_episodes, @created_at)
`);
const stmtInsertArchiveEp = db.prepare(`
  INSERT INTO summary_archive_episodes
    (archive_id, feed_id, feed_title, episode_id, episode_title, episode_url, date_published, ai_summary)
  VALUES
    (@archive_id, @feed_id, @feed_title, @episode_id, @episode_title, @episode_url, @date_published, @ai_summary)
`);
const writeArchive = db.transaction((user, col, queued, sentAt) => {
  const { lastInsertRowid: archiveId } = stmtInsertArchive.run({
    user_id:         user.id,
    collection_id:   col.id,
    collection_name: col.name,
    frequency:       col.frequency,
    sent_at:         sentAt,
    total_episodes:  queued.length,
    created_at:      sentAt,
  });
  for (const ep of queued) {
    stmtInsertArchiveEp.run({
      archive_id:     archiveId,
      feed_id:        ep.feed_id,
      feed_title:     ep.feed_title,
      episode_id:     ep.episode_id,
      episode_title:  ep.episode_title,
      episode_url:    ep.episode_url,
      date_published: ep.date_published,
      ai_summary:     ep.ai_summary,
    });
  }
});

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

// ── Daily episode discovery ───────────────────────────────────────────────────
// Checks all feeds across all collections for new episodes since the last check,
// generates an AI summary for each, and queues them. Runs at most once per 23 h.
async function checkCollection(col) {
  const feeds = stmtGetFeeds.all(col.id);
  if (!feeds.length) return;

  // First-ever check → look back 7 days; subsequent checks → since last_checked_at
  const sinceSeconds = col.last_checked_at
    ? Math.floor(col.last_checked_at / 1000)
    : Math.floor((Date.now() - 7 * 24 * 3_600_000) / 1000);

  await Promise.all(
    feeds.map(async feed => {
      let items;
      try {
        const data = await getEpisodesSince(feed.feed_id, sinceSeconds);
        items = data.items || [];
      } catch {
        return; // Skip this feed on API error; will retry next check
      }

      for (const ep of items) {
        const summary = await summarizeEpisode(ep.title, ep.description);
        stmtInsertQueue.run({
          collection_id:  col.id,
          feed_id:        feed.feed_id,
          feed_title:     feed.feed_title || ep.feedTitle || null,
          episode_id:     String(ep.id),
          episode_title:  ep.title || 'Untitled',
          episode_url:    ep.enclosureUrl || null,
          date_published: ep.datePublished || null,
          ai_summary:     summary,
          queued_at:      Date.now(),
        });
      }
    })
  );

  stmtUpdateChecked.run(Date.now(), col.id);
}

async function checkAllCollections(collections, now) {
  const CHECK_INTERVAL_MS = 23 * 3_600_000;
  for (const col of collections) {
    const sinceLastCheck = col.last_checked_at ? now - col.last_checked_at : Infinity;
    if (sinceLastCheck >= CHECK_INTERVAL_MS) {
      checkCollection(col).catch(err =>
        console.error(`[scheduler] check collection ${col.id}: ${err.message}`)
      );
    }
  }
}

// ── Per-collection email dispatch ─────────────────────────────────────────────
// Reads from the episode queue and sends an email if anything is waiting.
// Clears the queue after a successful send.
async function processCollection(col) {
  const user = stmtGetUser.get(col.user_id);
  if (!user) return;

  const queued = stmtGetQueue.all(col.id);
  if (!queued.length) {
    // Nothing to send — advance last_sent_at so we don't re-check immediately
    stmtUpdateLastSent.run(Date.now(), col.id);
    return;
  }

  // Group queued episodes by feed for the email template
  const feedMap = new Map();
  for (const row of queued) {
    if (!feedMap.has(row.feed_id)) {
      feedMap.set(row.feed_id, { feed_id: row.feed_id, feed_title: row.feed_title, episodes: [] });
    }
    feedMap.get(row.feed_id).episodes.push(row);
  }
  const feedsWithEpisodes = Array.from(feedMap.values());

  await sendCollectionSummary(user.email, col, feedsWithEpisodes);

  const sentAt = Date.now();
  writeArchive(user, col, queued, sentAt);
  stmtDeleteQueue.run(col.id);
  stmtUpdateLastSent.run(sentAt, col.id);
}

// ── Tick ──────────────────────────────────────────────────────────────────────
function tick() {
  const now      = Date.now();
  const todayDow = new Date().getDay(); // 0 = Sunday … 6 = Saturday
  const collections = stmtAllCollections.all();

  // 1. Daily check: discover new episodes and queue them with AI summaries
  checkAllCollections(collections, now);

  // 2. Email send: flush the queue for any collection whose send schedule is due
  for (const col of collections) {
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

module.exports = { startScheduler, checkCollection, processCollection };
