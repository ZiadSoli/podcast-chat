/* ── State ─────────────────────────────────────────────────────── */
const state = {
  // Search panel
  view: 'podcasts',            // 'podcasts' | 'episodes'
  podcastResults: [],          // results from podcast search
  episodeResults: [],          // episodes for the active podcast
  activePodcast: null,         // {id, title, publisher, thumbnail, total_episodes}
  nextEpisodePubDate: null,    // for pagination
  // Knowledge base
  episodes: [],                // {id, title, podcast, thumbnail, transcript, transcriptSource, status}
  // Chat
  chatHistory: [],             // [{role, content}]
  // Loading flags
  searching: false,
  loadingEpisodes: false,
  chatting: false,
};

/* ── DOM refs ──────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const searchInput     = $('searchInput');
const searchBtn       = $('searchBtn');
const searchResultsEl = $('searchResults');
const kbList          = $('kbList');
const kbBadge         = $('kbBadge');
const kbFooter        = $('kbFooter');
const chatMessages    = $('chatMessages');
const chatInput       = $('chatInput');
const sendBtn         = $('sendBtn');
const clearChatBtn    = $('clearChatBtn');
const clearKbBtn      = $('clearKbBtn');

/* ── Utils ─────────────────────────────────────────────────────── */
function fmtDuration(sec) {
  if (!sec) return '';
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

function fmtDate(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function scrollBottom(el) {
  requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
}

/* ── API health check ──────────────────────────────────────────── */
async function checkHealth() {
  try {
    const res = await fetch('/api/health');
    const { listennotes, anthropic, openai } = await res.json();
    $('apiStatus').innerHTML = `
      <span class="${listennotes ? 'ok' : 'miss'}"><span class="dot"></span> ListenNotes</span>
      <span class="${anthropic  ? 'ok' : 'miss'}"><span class="dot"></span> Anthropic</span>
      <span class="${openai     ? 'ok' : 'miss'}"><span class="dot"></span> OpenAI</span>
    `;
  } catch (_) {}
}

/* ── Search podcasts ───────────────────────────────────────────── */
async function doSearch() {
  const q = searchInput.value.trim();
  if (!q || state.searching) return;

  // Reset to podcast view
  state.view = 'podcasts';
  state.activePodcast = null;
  state.searching = true;
  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching…';
  searchResultsEl.innerHTML = `<div class="empty-state"><span class="spinner"></span><p>Searching…</p></div>`;

  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}&type=podcast`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.podcastResults = data.results || [];
    renderSearchResults();
  } catch (err) {
    searchResultsEl.innerHTML = `<div class="error-banner">Search failed: ${escHtml(err.message)}</div>`;
  } finally {
    state.searching = false;
    searchBtn.disabled = false;
    searchBtn.textContent = 'Search';
  }
}

/* ── Open a podcast → show its episodes ───────────────────────── */
async function openPodcast(id) {
  if (state.loadingEpisodes) return;

  state.loadingEpisodes = true;
  state.view = 'episodes';
  state.episodeResults = [];
  state.nextEpisodePubDate = null;

  // Show loading immediately
  renderSearchResults();

  try {
    const res = await fetch(`/api/podcast/${encodeURIComponent(id)}/episodes`);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.activePodcast = data.podcast;
    state.episodeResults = data.episodes || [];
    state.nextEpisodePubDate = data.next_episode_pub_date || null;
    renderSearchResults();
  } catch (err) {
    searchResultsEl.innerHTML = `
      <div class="panel-breadcrumb">
        <button class="btn-back" id="backBtn">&#8592; Back</button>
      </div>
      <div class="error-banner">Failed to load episodes: ${escHtml(err.message)}</div>
    `;
    document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
  } finally {
    state.loadingEpisodes = false;
  }
}

/* ── Load more episodes ────────────────────────────────────────── */
async function loadMoreEpisodes() {
  if (!state.activePodcast || !state.nextEpisodePubDate || state.loadingEpisodes) return;
  state.loadingEpisodes = true;

  // Disable load-more button immediately
  const btn = document.getElementById('loadMoreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    const url = `/api/podcast/${encodeURIComponent(state.activePodcast.id)}/episodes?next_episode_pub_date=${state.nextEpisodePubDate}`;
    const res = await fetch(url);
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.episodeResults = [...state.episodeResults, ...(data.episodes || [])];
    state.nextEpisodePubDate = data.next_episode_pub_date || null;
    renderSearchResults();
  } catch (err) {
    if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
  } finally {
    state.loadingEpisodes = false;
  }
}

/* ── Back to podcast list ──────────────────────────────────────── */
function backToPodcasts() {
  state.view = 'podcasts';
  state.activePodcast = null;
  state.episodeResults = [];
  state.nextEpisodePubDate = null;
  renderSearchResults();
}

/* ── Render search panel ───────────────────────────────────────── */
function renderSearchResults() {
  if (state.view === 'podcasts') {
    renderPodcastResults();
  } else {
    renderEpisodeResults();
  }
}

function renderPodcastResults() {
  if (state.podcastResults.length === 0) {
    searchResultsEl.innerHTML = `<div class="empty-state"><span class="empty-icon">&#127897;</span><p>Search for a podcast above</p></div>`;
    return;
  }

  searchResultsEl.innerHTML = state.podcastResults.map(p => {
    const thumb     = p.thumbnail || '';
    const title     = p.title_original || p.title || 'Untitled';
    const publisher = p.publisher_original || p.publisher || '';
    const count     = p.total_episodes != null ? `${p.total_episodes} episodes` : '';

    return `
      <div class="podcast-card" data-id="${escHtml(p.id)}">
        <img class="ep-thumb" src="${escHtml(thumb)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="ep-body">
          <div class="ep-title" title="${escHtml(title)}">${escHtml(title)}</div>
          <div class="ep-podcast">${escHtml(publisher)}</div>
          ${count ? `<div class="ep-meta">${escHtml(count)}</div>` : ''}
        </div>
        <button class="browse-btn" data-id="${escHtml(p.id)}" title="Browse episodes">
          Browse &#8594;
        </button>
      </div>
    `;
  }).join('');
}

function renderEpisodeResults() {
  const podcast = state.activePodcast;
  const podcastName = podcast?.title || 'Podcast';
  const podcastThumb = podcast?.thumbnail || '';

  let html = `
    <div class="panel-breadcrumb">
      <button class="btn-back" id="backBtn">&#8592; Back</button>
      <img class="breadcrumb-thumb" src="${escHtml(podcastThumb)}" alt="" onerror="this.style.display='none'" />
      <span class="breadcrumb-title" title="${escHtml(podcastName)}">${escHtml(podcastName)}</span>
    </div>
  `;

  if (state.loadingEpisodes && state.episodeResults.length === 0) {
    html += `<div class="empty-state"><span class="spinner"></span><p>Loading episodes…</p></div>`;
    searchResultsEl.innerHTML = html;
    document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
    return;
  }

  if (state.episodeResults.length === 0) {
    html += `<div class="empty-state"><span class="empty-icon">&#128214;</span><p>No episodes found</p></div>`;
    searchResultsEl.innerHTML = html;
    document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
    return;
  }

  html += state.episodeResults.map(ep => {
    const isAdded = state.episodes.some(e => e.id === ep.id);
    const thumb   = ep.thumbnail || '';
    const title   = ep.title || 'Untitled';
    const dur     = fmtDuration(ep.audio_length_sec);
    const date    = fmtDate(ep.pub_date_ms);
    const cached  = ep.cached;

    return `
      <div class="episode-card ${isAdded ? 'is-added' : ''}">
        <img class="ep-thumb" src="${escHtml(thumb)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="ep-body">
          <div class="ep-title" title="${escHtml(title)}">${escHtml(title)}</div>
          <div class="ep-meta">
            ${[dur, date].filter(Boolean).join(' · ')}
            ${cached ? '<span class="cached-badge" title="Transcript already saved — loads instantly">⚡ cached</span>' : ''}
          </div>
        </div>
        <button
          class="add-btn ${isAdded ? 'added' : ''}"
          data-id="${escHtml(ep.id)}"
          title="${isAdded ? 'Already added' : cached ? 'Add (instant — already transcribed)' : 'Add to knowledge base'}"
          ${isAdded ? 'disabled' : ''}
        >${isAdded ? '✓' : '+'}</button>
      </div>
    `;
  }).join('');

  // Load more button
  if (state.nextEpisodePubDate) {
    html += `<button class="btn-load-more" id="loadMoreBtn">Load more episodes</button>`;
  }

  searchResultsEl.innerHTML = html;

  // Re-attach event listeners for dynamic elements
  document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
  document.getElementById('loadMoreBtn')?.addEventListener('click', loadMoreEpisodes);
}

/* ── Add episode to KB ─────────────────────────────────────────── */
async function addEpisode(id) {
  if (state.episodes.some(e => e.id === id)) return;

  // Use metadata already cached in episodeResults
  const raw = state.episodeResults.find(e => e.id === id);

  const entry = {
    id,
    title:     raw?.title     || 'Loading…',
    podcast:   state.activePodcast?.title    || '',
    thumbnail: raw?.thumbnail || state.activePodcast?.thumbnail || '',
    transcript: null,
    status: 'queued',
  };

  state.episodes.push(entry);
  renderKb();
  renderSearchResults();

  try {
    const res = await fetch(`/api/transcribe/${encodeURIComponent(id)}`, { method: 'POST' });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // If cached, poll almost immediately — transcript is already ready
    pollJob(id, data.jobId, data.cached ? 100 : JOB_POLL_INTERVAL);
  } catch (err) {
    const idx = state.episodes.findIndex(e => e.id === id);
    if (idx !== -1) {
      state.episodes[idx].status = 'error';
      state.episodes[idx].errorMsg = err.message;
      renderKb();
    }
  }
}

/* ── Poll transcription job ────────────────────────────────────── */
const JOB_POLL_INTERVAL = 3000;
const JOB_MAX_POLLS     = 200; // ~10 minutes

function pollJob(episodeId, jobId, initialDelay = JOB_POLL_INTERVAL) {
  let polls = 0;

  const statusMap = {
    pending:      'queued',
    fetching:     'fetching',
    downloading:  'downloading',
    transcribing: 'transcribing',
  };

  const tick = async () => {
    if (polls++ > JOB_MAX_POLLS) {
      const idx = state.episodes.findIndex(e => e.id === episodeId);
      if (idx !== -1) {
        state.episodes[idx].status   = 'error';
        state.episodes[idx].errorMsg = 'Transcription timed out.';
        renderKb();
      }
      return;
    }

    try {
      const res = await fetch(`/api/transcribe/job/${jobId}`);
      const job = await res.json();

      const idx = state.episodes.findIndex(e => e.id === episodeId);
      if (idx === -1) return; // episode was removed — stop polling

      if (job.status === 'done') {
        state.episodes[idx].transcript = job.transcript;
        state.episodes[idx].status     = 'ready';
        renderKb();
        renderSearchResults(); // keep add button state consistent
      } else if (job.status === 'error') {
        state.episodes[idx].status   = 'error';
        state.episodes[idx].errorMsg = job.error || 'Unknown error';
        renderKb();
      } else {
        state.episodes[idx].status = statusMap[job.status] || 'queued';
        renderKb();
        setTimeout(tick, JOB_POLL_INTERVAL);
      }
    } catch (_) {
      // Network blip — keep retrying
      setTimeout(tick, JOB_POLL_INTERVAL);
    }
  };

  setTimeout(tick, initialDelay);
}

/* ── Remove episode from KB ────────────────────────────────────── */
function removeEpisode(id) {
  state.episodes = state.episodes.filter(e => e.id !== id);
  renderKb();
  renderSearchResults();
}

/* ── Render KB ─────────────────────────────────────────────────── */
function renderKb() {
  kbBadge.textContent = state.episodes.length;
  kbFooter.classList.toggle('hidden', state.episodes.length === 0);

  if (state.episodes.length === 0) {
    kbList.innerHTML = `<div class="empty-state"><span class="empty-icon">&#128218;</span><p>Add episodes from search results</p></div>`;
    return;
  }

  const statusConfig = {
    queued:       { dot: 'loading',      label: 'Queued…' },
    fetching:     { dot: 'loading',      label: 'Fetching episode info…' },
    downloading:  { dot: 'loading',      label: 'Downloading audio…' },
    transcribing: { dot: 'transcribing', label: 'Transcribing with Whisper…' },
    ready:        { dot: 'ready',        label: 'Transcript ready' },
    error:        { dot: 'error',        label: 'Transcription failed' },
  };

  const sourceTagMap = {
    ready: `<span class="source-tag transcript">Whisper</span>`,
    error: `<span class="source-tag none">Error</span>`,
  };

  kbList.innerHTML = state.episodes.map(ep => {
    const cfg = statusConfig[ep.status] || statusConfig.loading;
    const tag = sourceTagMap[ep.status] || '';
    return `
      <div class="kb-item">
        <img class="kb-thumb" src="${escHtml(ep.thumbnail)}" alt="" onerror="this.style.visibility='hidden'" />
        <div class="kb-info">
          <div class="kb-title" title="${escHtml(ep.title)}">${escHtml(ep.title)}</div>
          <div class="kb-podcast">${escHtml(ep.podcast)}</div>
          <div class="kb-status">
            <span class="status-dot ${cfg.dot}"></span>
            <span>${cfg.label}</span>
            ${tag}
          </div>
        </div>
        <button class="remove-btn" data-id="${escHtml(ep.id)}" title="Remove">&times;</button>
      </div>
    `;
  }).join('');
}

/* ── Chat ──────────────────────────────────────────────────────── */
function renderChat() {
  if (state.chatHistory.length === 0) {
    chatMessages.innerHTML = `
      <div class="message assistant-message">
        <div class="message-content">Add podcast episodes to your knowledge base on the left, then ask me anything about them.</div>
      </div>`;
    return;
  }

  chatMessages.innerHTML = state.chatHistory.map(msg => `
    <div class="message ${msg.role === 'user' ? 'user-message' : 'assistant-message'}">
      <div class="msg-role">${msg.role === 'user' ? 'You' : 'Assistant'}</div>
      <div class="message-content">${escHtml(msg.content)}</div>
    </div>
  `).join('');

  scrollBottom(chatMessages);
}

function addThinkingBubble() {
  const el = document.createElement('div');
  el.className = 'message assistant-message thinking';
  el.id = 'thinkingBubble';
  el.innerHTML = `<div class="msg-role">Assistant</div><div class="message-content"><span class="spinner"></span> Thinking…</div>`;
  chatMessages.appendChild(el);
  scrollBottom(chatMessages);
  return el;
}

async function sendMessage() {
  const text = chatInput.value.trim();
  if (!text || state.chatting) return;

  state.chatHistory.push({ role: 'user', content: text });
  chatInput.value = '';
  chatInput.style.height = 'auto';
  renderChat();

  const bubble = addThinkingBubble();
  state.chatting = true;
  sendBtn.disabled = true;

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messages: state.chatHistory,
        episodes: state.episodes.map(e => ({ title: e.title, podcast: e.podcast, transcript: e.transcript })),
      }),
    });

    const data = await res.json();
    bubble.remove();

    if (data.error) throw new Error(data.error);

    state.chatHistory.push({ role: 'assistant', content: data.reply });
    renderChat();
  } catch (err) {
    bubble.remove();
    state.chatHistory.push({ role: 'assistant', content: `Sorry, an error occurred: ${err.message}` });
    renderChat();
  } finally {
    state.chatting = false;
    updateSendBtn();
  }
}

function updateSendBtn() {
  sendBtn.disabled = state.chatting || chatInput.value.trim().length === 0;
}

/* ── Event listeners ───────────────────────────────────────────── */
searchBtn.addEventListener('click', doSearch);
searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

// Delegate: podcast browse buttons
searchResultsEl.addEventListener('click', e => {
  const browseBtn = e.target.closest('.browse-btn');
  if (browseBtn) { openPodcast(browseBtn.dataset.id); return; }

  const addBtn = e.target.closest('.add-btn');
  if (addBtn && !addBtn.disabled) addEpisode(addBtn.dataset.id);
});

// Delegate: remove kb items
kbList.addEventListener('click', e => {
  const btn = e.target.closest('.remove-btn');
  if (btn) removeEpisode(btn.dataset.id);
});

clearKbBtn.addEventListener('click', () => {
  state.episodes = [];
  renderKb();
  renderSearchResults();
});

chatInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
});

chatInput.addEventListener('input', () => {
  chatInput.style.height = 'auto';
  chatInput.style.height = Math.min(chatInput.scrollHeight, 140) + 'px';
  updateSendBtn();
});

sendBtn.addEventListener('click', sendMessage);

clearChatBtn.addEventListener('click', () => {
  state.chatHistory = [];
  renderChat();
});

/* ── Init ──────────────────────────────────────────────────────── */
checkHealth();
renderKb();
renderChat();
renderSearchResults();
updateSendBtn();
