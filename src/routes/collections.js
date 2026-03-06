const express        = require('express');
const { db }         = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

// ── Prepared statements ───────────────────────────────────────────────────────
const stmtListCollections = db.prepare(`
  SELECT c.*,
         (SELECT COUNT(*) FROM collection_feeds WHERE collection_id = c.id) AS feed_count
  FROM collections c
  WHERE c.user_id = ?
  ORDER BY c.created_at DESC
`);

const stmtGetCollection = db.prepare(`
  SELECT * FROM collections WHERE id = ? AND user_id = ?
`);

const stmtCreateCollection = db.prepare(`
  INSERT INTO collections (user_id, name, description, frequency, day_of_week, no_episodes_behavior, created_at, updated_at)
  VALUES (@user_id, @name, @description, @frequency, @day_of_week, @no_episodes_behavior, @now, @now)
`);

const stmtUpdateCollection = db.prepare(`
  UPDATE collections
  SET name = @name,
      description = @description,
      frequency = @frequency,
      day_of_week = @day_of_week,
      no_episodes_behavior = @no_episodes_behavior,
      updated_at = @now
  WHERE id = @id AND user_id = @user_id
`);

const stmtDeleteCollection = db.prepare(`
  DELETE FROM collections WHERE id = ? AND user_id = ?
`);

const stmtGetFeeds = db.prepare(`
  SELECT * FROM collection_feeds WHERE collection_id = ? ORDER BY added_at ASC
`);

const stmtAddFeed = db.prepare(`
  INSERT OR IGNORE INTO collection_feeds (collection_id, feed_id, feed_title, feed_thumbnail, added_at)
  VALUES (@collection_id, @feed_id, @feed_title, @feed_thumbnail, @now)
`);

const stmtRemoveFeed = db.prepare(`
  DELETE FROM collection_feeds WHERE collection_id = ? AND feed_id = ?
`);

// ── Ownership helper ──────────────────────────────────────────────────────────
function ownedCollection(req, res) {
  const col = stmtGetCollection.get(req.params.id, req.session.userId);
  if (!col) res.status(404).json({ error: 'Collection not found.' });
  return col || null;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// GET /api/collections — list user's collections
router.get('/collections', requireAuth, (req, res) => {
  res.json({ collections: stmtListCollections.all(req.session.userId) });
});

// POST /api/collections — create collection
router.post('/collections', requireAuth, (req, res) => {
  const { name, description = null, frequency = 'weekly',
          day_of_week = null, no_episodes_behavior = 'suppress' } = req.body;

  if (!name?.trim()) return res.status(400).json({ error: 'Collection name is required.' });

  const info = stmtCreateCollection.run({
    user_id: req.session.userId,
    name: name.trim(),
    description: description || null,
    frequency,
    day_of_week: frequency === 'weekly' ? (day_of_week ?? 1) : null,
    no_episodes_behavior,
    now: Date.now(),
  });

  res.status(201).json({ id: info.lastInsertRowid });
});

// GET /api/collections/:id — get collection + its feeds
router.get('/collections/:id', requireAuth, (req, res) => {
  const col = ownedCollection(req, res);
  if (!col) return;
  const feeds = stmtGetFeeds.all(col.id);
  res.json({ ...col, feeds });
});

// PUT /api/collections/:id — update collection settings
router.put('/collections/:id', requireAuth, (req, res) => {
  const col = ownedCollection(req, res);
  if (!col) return;

  const { name, description, frequency, day_of_week, no_episodes_behavior } = req.body;

  if (name !== undefined && !name?.trim())
    return res.status(400).json({ error: 'Collection name cannot be empty.' });

  stmtUpdateCollection.run({
    id:                   col.id,
    user_id:              req.session.userId,
    name:                 (name ?? col.name).trim(),
    description:          description !== undefined ? (description || null) : col.description,
    frequency:            frequency            ?? col.frequency,
    day_of_week:          (frequency ?? col.frequency) === 'weekly'
                            ? (day_of_week ?? col.day_of_week ?? 1)
                            : null,
    no_episodes_behavior: no_episodes_behavior ?? col.no_episodes_behavior,
    now:                  Date.now(),
  });

  res.json({ ok: true });
});

// DELETE /api/collections/:id — delete collection (cascades to collection_feeds)
router.delete('/collections/:id', requireAuth, (req, res) => {
  const col = ownedCollection(req, res);
  if (!col) return;
  stmtDeleteCollection.run(col.id, req.session.userId);
  res.json({ ok: true });
});

// POST /api/collections/:id/feeds — add a feed
router.post('/collections/:id/feeds', requireAuth, (req, res) => {
  const col = ownedCollection(req, res);
  if (!col) return;

  const { feed_id, feed_title = null, feed_thumbnail = null } = req.body;
  if (!feed_id) return res.status(400).json({ error: 'feed_id is required.' });

  stmtAddFeed.run({
    collection_id:  col.id,
    feed_id:        String(feed_id),
    feed_title:     feed_title || null,
    feed_thumbnail: feed_thumbnail || null,
    now:            Date.now(),
  });

  res.status(201).json({ ok: true });
});

// DELETE /api/collections/:id/feeds/:feedId — remove a feed
router.delete('/collections/:id/feeds/:feedId', requireAuth, (req, res) => {
  const col = ownedCollection(req, res);
  if (!col) return;
  stmtRemoveFeed.run(col.id, req.params.feedId);
  res.json({ ok: true });
});

module.exports = router;
