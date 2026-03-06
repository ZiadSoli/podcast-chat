const crypto = require('crypto');
const axios  = require('axios');

const BASE = 'https://api.podcastindex.org/api/1.0';

// ── Auth ──────────────────────────────────────────────────────────────────────
// Podcast Index uses a challenge-response scheme: the secret never travels over
// the wire. Instead, a SHA-1 hash of (key + secret + timestamp) is sent, and
// the server independently recomputes it. Valid for a 3-minute window.
function authHeaders() {
  const key  = process.env.PODCASTINDEX_API_KEY;
  const sec  = process.env.PODCASTINDEX_API_SECRET;
  const ts   = Math.floor(Date.now() / 1000).toString();
  const hash = crypto.createHash('sha1').update(key + sec + ts).digest('hex');
  return {
    'User-Agent':    'PodcastChat/1.0',
    'X-Auth-Key':    key,
    'X-Auth-Date':   ts,
    'Authorization': hash,
  };
}

async function piGet(path, params = {}) {
  const { data } = await axios.get(`${BASE}${path}`, {
    params,
    headers: authHeaders(),
  });
  return data;
}

// ── API helpers ───────────────────────────────────────────────────────────────
module.exports = {
  searchFeeds: (q) =>
    piGet('/search/byterm', { q, max: 10 }),

  getFeedById: (id) =>
    piGet('/podcasts/byfeedid', { id }),

  getEpisodesByFeedId: (id, before) =>
    piGet('/episodes/byfeedid', before ? { id, max: 10, before } : { id, max: 10 }),

  getEpisodeById: (id) =>
    piGet('/episodes/byid', { id }),

  // Returns episodes published after sinceSeconds (Unix timestamp, seconds)
  getEpisodesSince: (feedId, sinceSeconds) =>
    piGet('/episodes/byfeedid', { id: feedId, max: 50, since: sinceSeconds }),
};
