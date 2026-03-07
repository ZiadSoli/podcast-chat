const express = require('express');
const { hasCached } = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { searchFeeds, getFeedById, getEpisodesByFeedId } = require('../services/podcastindex');

const router = express.Router();

const PI_GUARD = () =>
  !process.env.PODCASTINDEX_API_KEY || !process.env.PODCASTINDEX_API_SECRET;

// ── Search podcasts ───────────────────────────────────────────────────────────
router.get('/search', requireAuth, async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });
  if (PI_GUARD()) return res.status(500).json({ error: 'PODCASTINDEX_API_KEY / PODCASTINDEX_API_SECRET not configured.' });

  try {
    const data = await searchFeeds(q);
    const results = (data.feeds || []).map(f => ({
      id:             String(f.id),
      title:          f.title          || '',
      publisher:      f.author         || '',
      thumbnail:      f.image || f.artwork || '',
      total_episodes: f.episodeCount   || null,
    }));
    res.json({ results });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.description || err.message });
  }
});

// ── Get podcast episodes ──────────────────────────────────────────────────────
router.get('/podcast/:id/episodes', requireAuth, async (req, res) => {
  const { id } = req.params;
  // next_episode_pub_date is repurposed as a generic pagination cursor.
  // For Listen Notes it was a timestamp; for Podcast Index it is an episode ID
  // passed as `before`. The frontend never inspects the value — it just stores
  // and echoes it back — so the field name is kept identical for compatibility.
  const before = req.query.next_episode_pub_date || null;
  if (PI_GUARD()) return res.status(500).json({ error: 'PODCASTINDEX_API_KEY / PODCASTINDEX_API_SECRET not configured.' });

  try {
    // Fetch podcast metadata and episode list in parallel
    const [feedData, epsData] = await Promise.all([
      getFeedById(id),
      getEpisodesByFeedId(id, before),
    ]);

    const feed  = feedData.feed || {};
    // PI returns the episode list under `items`, not `episodes`
    const items = epsData.items || [];
    const feedImg = feed.image || feed.artwork || '';

    const lastItem = items[items.length - 1];
    // If a full page came back there may be more; send the last episode's ID as
    // the cursor. Podcast Index accepts this as `before` on the next request.
    const next_episode_pub_date =
      (epsData.count === 10 && lastItem) ? String(lastItem.id) : null;

    res.json({
      podcast: {
        id:             String(feed.id),
        title:          feed.title   || '',
        publisher:      feed.author  || '',
        thumbnail:      feedImg,
        total_episodes: feed.episodeCount || null,
      },
      // Each item carries feedImage (podcast artwork) alongside its own image
      episodes: items.map(ep => ({
        id:               String(ep.id),
        title:            ep.title || 'Untitled',
        thumbnail:        ep.image || ep.feedImage || feedImg,
        pub_date_ms:      (ep.datePublished || 0) * 1000, // PI uses seconds; frontend expects ms
        audio_length_sec: ep.duration || null,
        audio_url:        ep.enclosureUrl || null,
        cached:           hasCached(String(ep.id)),
      })),
      next_episode_pub_date,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.description || err.message });
  }
});

module.exports = router;
