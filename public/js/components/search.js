import { state } from '../state.js';
import { escHtml, fmtDuration, fmtDate } from '../utils.js';
import { searchPodcasts, fetchEpisodes } from '../api.js';
import { redirectIfUnauth } from './auth.js';

const searchInput     = document.getElementById('searchInput');
const searchBtn       = document.getElementById('searchBtn');
const searchResultsEl = document.getElementById('searchResults');

// ── Search podcasts ───────────────────────────────────────────────
async function doSearch() {
  const q = searchInput.value.trim();
  if (!q || state.searching) return;

  state.view = 'podcasts';
  state.activePodcast = null;
  state.searching = true;
  searchBtn.disabled = true;
  searchBtn.textContent = 'Searching…';
  searchResultsEl.innerHTML = `<div class="empty-state"><span class="spinner"></span><p style="color:var(--text-secondary);font-size:13px">Searching…</p></div>`;

  try {
    const res = await searchPodcasts(q);
    if (redirectIfUnauth(res)) return;
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

// ── Open a podcast → show its episodes ───────────────────────────
async function openPodcast(id) {
  if (state.loadingEpisodes) return;

  state.loadingEpisodes = true;
  state.view = 'episodes';
  state.episodeResults = [];
  state.nextEpisodePubDate = null;
  renderSearchResults();

  try {
    const res = await fetchEpisodes(id);
    if (redirectIfUnauth(res)) return;
    const data = await res.json();
    if (data.error) throw new Error(data.error);

    state.activePodcast      = data.podcast;
    state.episodeResults     = data.episodes || [];
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

// ── Load more episodes ────────────────────────────────────────────
async function loadMoreEpisodes() {
  if (!state.activePodcast || !state.nextEpisodePubDate || state.loadingEpisodes) return;
  state.loadingEpisodes = true;

  const btn = document.getElementById('loadMoreBtn');
  if (btn) { btn.disabled = true; btn.textContent = 'Loading…'; }

  try {
    const res = await fetchEpisodes(state.activePodcast.id, state.nextEpisodePubDate);
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    state.episodeResults     = [...state.episodeResults, ...(data.episodes || [])];
    state.nextEpisodePubDate = data.next_episode_pub_date || null;
    renderSearchResults();
  } catch (_) {
    if (btn) { btn.disabled = false; btn.textContent = 'Load more'; }
  } finally {
    state.loadingEpisodes = false;
  }
}

// ── Back to podcast list ──────────────────────────────────────────
function backToPodcasts() {
  state.view = 'podcasts';
  state.activePodcast = null;
  state.episodeResults = [];
  state.nextEpisodePubDate = null;
  renderSearchResults();
}

// ── Render ────────────────────────────────────────────────────────
export function renderSearchResults() {
  if (state.view === 'podcasts') renderPodcastResults();
  else renderEpisodeResults();
}

function renderPodcastResults() {
  if (state.podcastResults.length === 0) {
    searchResultsEl.innerHTML = `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg><p>Search for a podcast above</p></div>`;
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
        <button class="browse-btn" data-id="${escHtml(p.id)}" title="Browse episodes">Browse &#8594;</button>
      </div>
    `;
  }).join('');
}

function renderEpisodeResults() {
  const podcast      = state.activePodcast;
  const podcastName  = podcast?.title || 'Podcast';
  const podcastThumb = podcast?.thumbnail || '';

  let html = `
    <div class="panel-breadcrumb">
      <button class="btn-back" id="backBtn">&#8592; Back</button>
      <img class="breadcrumb-thumb" src="${escHtml(podcastThumb)}" alt="" onerror="this.style.display='none'" />
      <span class="breadcrumb-title" title="${escHtml(podcastName)}">${escHtml(podcastName)}</span>
    </div>
  `;

  if (state.loadingEpisodes && state.episodeResults.length === 0) {
    html += `<div class="empty-state"><span class="spinner"></span><p style="color:var(--text-secondary);font-size:13px">Loading episodes…</p></div>`;
    searchResultsEl.innerHTML = html;
    document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
    return;
  }

  if (state.episodeResults.length === 0) {
    html += `<div class="empty-state"><svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg><p>No episodes found</p></div>`;
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

  if (state.nextEpisodePubDate) {
    html += `<button class="btn-load-more" id="loadMoreBtn">Load more episodes</button>`;
  }

  searchResultsEl.innerHTML = html;
  document.getElementById('backBtn')?.addEventListener('click', backToPodcasts);
  document.getElementById('loadMoreBtn')?.addEventListener('click', loadMoreEpisodes);
}

// ── Init ──────────────────────────────────────────────────────────
export function initSearch({ onAddEpisode }) {
  searchBtn.addEventListener('click', doSearch);
  searchInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

  searchResultsEl.addEventListener('click', e => {
    const browseBtn = e.target.closest('.browse-btn');
    if (browseBtn) { openPodcast(browseBtn.dataset.id); return; }

    const addBtn = e.target.closest('.add-btn');
    if (addBtn && !addBtn.disabled) onAddEpisode(addBtn.dataset.id);
  });
}
