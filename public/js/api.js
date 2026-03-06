export async function getMe() {
  return fetch('/api/auth/me');
}

export async function requestMagicLink(email) {
  return fetch('/api/auth/request', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

export async function apiLogout() {
  return fetch('/api/auth/logout', { method: 'POST' });
}

export async function searchPodcasts(q, offset = 0) {
  return fetch(`/api/search?q=${encodeURIComponent(q)}&type=podcast&offset=${offset}`);
}

export async function fetchEpisodes(podcastId, nextEpisodePubDate) {
  const params = nextEpisodePubDate ? `?next_episode_pub_date=${nextEpisodePubDate}` : '';
  return fetch(`/api/podcast/${encodeURIComponent(podcastId)}/episodes${params}`);
}

export async function startTranscription(episodeId) {
  return fetch(`/api/transcribe/${encodeURIComponent(episodeId)}`, { method: 'POST' });
}

export async function sendChatMessage(messages, episodes) {
  return fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages, episodes }),
  });
}

export async function checkHealth() {
  return fetch('/api/health');
}

// ── Collections ───────────────────────────────────────────────────────────────
const json = data => ({
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(data),
});

export const getCollections          = ()          => fetch('/api/collections');
export const createCollection        = data        => fetch('/api/collections',                       { method: 'POST',   ...json(data) });
export const getCollection           = id          => fetch(`/api/collections/${id}`);
export const updateCollection        = (id, data)  => fetch(`/api/collections/${id}`,                { method: 'PUT',    ...json(data) });
export const deleteCollection        = id          => fetch(`/api/collections/${id}`,                { method: 'DELETE' });
export const addFeedToCollection     = (id, feed)  => fetch(`/api/collections/${id}/feeds`,          { method: 'POST',   ...json(feed) });
export const removeFeedFromCollection = (id, fid)  => fetch(`/api/collections/${id}/feeds/${fid}`,   { method: 'DELETE' });
