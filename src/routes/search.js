const express  = require('express');
const axios    = require('axios');
const { hasCached } = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

const LISTENNOTES_BASE = 'https://listen-api.listennotes.com/api/v2';
const listennotes = (endpoint, params = {}) =>
  axios.get(`${LISTENNOTES_BASE}${endpoint}`, {
    headers: { 'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY },
    params,
  });

router.get('/search', requireAuth, async (req, res) => {
  const { q, offset = 0, type = 'podcast' } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });
  if (!process.env.LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  try {
    const { data } = await listennotes('/search', { q, type, language: 'English', sort_by_date: 0, offset });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

router.get('/podcast/:id/episodes', requireAuth, async (req, res) => {
  const { id } = req.params;
  const { next_episode_pub_date } = req.query;
  if (!process.env.LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

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

module.exports = router;
