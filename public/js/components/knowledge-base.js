import { state } from '../state.js';
import { escHtml } from '../utils.js';
import { startTranscription } from '../api.js';
import { redirectIfUnauth } from './auth.js';
import { renderSearchResults } from './search.js';
import { loadEpisode } from './player.js';

const kbList     = document.getElementById('kbList');
const kbBadge    = document.getElementById('kbBadge');
const kbFooter   = document.getElementById('kbFooter');
const clearKbBtn = document.getElementById('clearKbBtn');

// Callback set by initKnowledgeBase — called after an episode is added
// (used by main.js to switch the mobile tab)
let onEpisodeAdded = null;

// ── SSE job tracking ──────────────────────────────────────────────
const activeStreams = new Map(); // episodeId → EventSource

const statusMap = {
  pending:      'queued',
  fetching:     'fetching',
  downloading:  'downloading',
  transcribing: 'transcribing',
};

function watchJob(episodeId, jobId) {
  const es = new EventSource(`/api/transcribe/job/${jobId}/stream`);
  activeStreams.set(episodeId, es);

  es.onmessage = e => {
    const job = JSON.parse(e.data);
    const idx = state.episodes.findIndex(ep => ep.id === episodeId);
    if (idx === -1) { es.close(); activeStreams.delete(episodeId); return; }

    if (job.status === 'done') {
      state.episodes[idx].transcript = job.transcript;
      state.episodes[idx].status     = 'ready';
      renderKb();
      renderSearchResults(); // refresh add-button state (+ → ✓)
      es.close();
      activeStreams.delete(episodeId);
    } else if (job.status === 'error') {
      state.episodes[idx].status   = 'error';
      state.episodes[idx].errorMsg = job.error || 'Unknown error';
      renderKb();
      es.close();
      activeStreams.delete(episodeId);
    } else {
      state.episodes[idx].status = statusMap[job.status] || 'queued';
      renderKb();
    }
  };

  es.onerror = () => {
    // EventSource reconnects automatically — only clean up if episode is gone
    const idx = state.episodes.findIndex(ep => ep.id === episodeId);
    if (idx === -1) { es.close(); activeStreams.delete(episodeId); }
  };
}

// ── Add / remove ──────────────────────────────────────────────────
export async function addEpisode(id) {
  if (state.episodes.some(e => e.id === id)) return;

  const raw = state.episodeResults.find(e => e.id === id);
  state.episodes.push({
    id,
    title:      raw?.title                         || 'Loading…',
    podcast:    state.activePodcast?.title         || '',
    thumbnail:  raw?.thumbnail || state.activePodcast?.thumbnail || '',
    audioUrl:   raw?.audio_url                     || null,
    transcript: null,
    status:     'queued',
  });

  renderKb();
  renderSearchResults();
  onEpisodeAdded?.();

  try {
    const res = await startTranscription(id);
    if (redirectIfUnauth(res)) return;
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    watchJob(id, data.jobId);
  } catch (err) {
    const idx = state.episodes.findIndex(e => e.id === id);
    if (idx !== -1) {
      state.episodes[idx].status   = 'error';
      state.episodes[idx].errorMsg = err.message;
      renderKb();
    }
  }
}

export function removeEpisode(id) {
  const es = activeStreams.get(id);
  if (es) { es.close(); activeStreams.delete(id); }
  state.episodes = state.episodes.filter(e => e.id !== id);
  renderKb();
  renderSearchResults();
}

// ── Render ────────────────────────────────────────────────────────
export function renderKb() {
  kbBadge.textContent = state.episodes.length;
  kbFooter.classList.toggle('hidden', state.episodes.length === 0);

  const mobileBadge = document.getElementById('mobileKbBadge');
  if (mobileBadge) {
    mobileBadge.textContent = state.episodes.length;
    mobileBadge.classList.toggle('hidden', state.episodes.length === 0);
  }

  if (state.episodes.length === 0) {
    kbList.innerHTML = `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 2 7 12 12 22 7 12 2"/><polyline points="2 17 12 22 22 17"/><polyline points="2 12 12 17 22 12"/></svg><p>Add episodes from search results</p></div>`;
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
    const cfg = statusConfig[ep.status] || statusConfig.queued;
    const tag = sourceTagMap[ep.status] || '';
    const listenBtn = ep.audioUrl
      ? `<button class="listen-btn" data-id="${escHtml(ep.id)}" title="Listen">▶ Listen</button>`
      : '';
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
        ${listenBtn}
        <button class="remove-btn" data-id="${escHtml(ep.id)}" title="Remove">&times;</button>
      </div>
    `;
  }).join('');
}

// ── Init ──────────────────────────────────────────────────────────
export function initKnowledgeBase(options = {}) {
  onEpisodeAdded = options.onEpisodeAdded ?? null;

  kbList.addEventListener('click', e => {
    const removeBtn = e.target.closest('.remove-btn');
    if (removeBtn) { removeEpisode(removeBtn.dataset.id); return; }

    const listenBtn = e.target.closest('.listen-btn');
    if (listenBtn) {
      const ep = state.episodes.find(ep => ep.id === listenBtn.dataset.id);
      if (ep?.audioUrl) loadEpisode(ep);
    }
  });

  clearKbBtn.addEventListener('click', () => {
    state.episodes = [];
    renderKb();
    renderSearchResults();
  });
}
