import { state } from '../state.js';
import { escHtml } from '../utils.js';
import {
  getCollections, createCollection, getCollection,
  updateCollection, deleteCollection,
  addFeedToCollection, removeFeedFromCollection,
  searchPodcasts,
  getCollectionArchive, getCollectionArchiveEntry,
} from '../api.js';

// ── DOM refs ──────────────────────────────────────────────────────────────────
const overlay           = document.getElementById('collectionsOverlay');
const listView          = document.getElementById('colListView');
const formView          = document.getElementById('colFormView');
const archiveView       = document.getElementById('colArchiveView');
const archiveDetailView = document.getElementById('colArchiveDetailView');
const archiveTitle      = document.getElementById('colArchiveTitle');
const archiveList       = document.getElementById('colArchiveList');
const archiveDetailTitle = document.getElementById('colArchiveDetailTitle');
const archiveDetail     = document.getElementById('colArchiveDetail');
const colList           = document.getElementById('colList');
const colFormTitle = document.getElementById('colFormTitle');
const nameInput    = document.getElementById('colNameInput');
const descInput    = document.getElementById('colDescInput');
const dowGroup     = document.getElementById('colDowGroup');
const dowSelect    = document.getElementById('colDowSelect');
const searchInput  = document.getElementById('colSearchInput');
const searchResults = document.getElementById('colSearchResults');
const feedList     = document.getElementById('colFeedList');
const saveBtn      = document.getElementById('colSaveBtn');
const deleteBtn    = document.getElementById('colDeleteBtn');

// ── Form-local state ──────────────────────────────────────────────────────────
let editingId             = null;  // null = creating, number = editing
let formFeeds             = [];    // [{feed_id, feed_title, feed_thumbnail}]
let searchTimer           = null;
let currentArchiveColId   = null;  // collection being browsed in archive view

// ── Helpers ───────────────────────────────────────────────────────────────────
function freqLabel(col) {
  if (col.frequency === 'daily') return 'Daily';
  const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  return `Weekly · ${days[col.day_of_week ?? 1]}`;
}

function formatDate(ms) {
  if (!ms) return 'never';
  return new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Render: collection list ───────────────────────────────────────────────────
export function renderCollections() {
  if (!state.collections.length) {
    colList.innerHTML = `
      <div class="empty-state">
        <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/>
        </svg>
        <p>No collections yet. Create one to start receiving email summaries.</p>
      </div>`;
    return;
  }

  colList.innerHTML = state.collections.map(col => `
    <div class="col-item" data-id="${col.id}">
      <div class="col-item-body">
        <div class="col-item-name">${escHtml(col.name)}</div>
        <div class="col-item-meta">${freqLabel(col)} · ${col.feed_count} show${col.feed_count !== 1 ? 's' : ''} · Last sent ${formatDate(col.last_sent_at)}</div>
      </div>
      <button class="col-item-history btn-ghost btn-sm" data-id="${col.id}" title="View history">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
        </svg>
      </button>
      <svg class="col-item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 18 15 12 9 6"/>
      </svg>
    </div>
  `).join('');

  colList.querySelectorAll('.col-item').forEach(el => {
    el.addEventListener('click', () => openForm(Number(el.dataset.id)));
  });

  colList.querySelectorAll('.col-item-history').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation(); // prevent the parent col-item click (edit form)
      openArchive(Number(btn.dataset.id));
    });
  });
}

// ── Render: form feed list ────────────────────────────────────────────────────
function renderFormFeeds() {
  if (!formFeeds.length) {
    feedList.innerHTML = `<p class="col-no-feeds">No shows added yet.</p>`;
    return;
  }
  feedList.innerHTML = formFeeds.map((f, i) => `
    <div class="col-feed-item">
      ${f.feed_thumbnail ? `<img src="${escHtml(f.feed_thumbnail)}" class="col-feed-thumb" alt="" />` : '<div class="col-feed-thumb col-feed-thumb-placeholder"></div>'}
      <span class="col-feed-title">${escHtml(f.feed_title || f.feed_id)}</span>
      <button class="col-feed-remove btn-ghost btn-sm" data-index="${i}" title="Remove">✕</button>
    </div>
  `).join('');

  feedList.querySelectorAll('.col-feed-remove').forEach(btn => {
    btn.addEventListener('click', () => removeFeedFromForm(Number(btn.dataset.index)));
  });
}

// ── Overlay open / close ──────────────────────────────────────────────────────
export async function openCollections() {
  state.collectionsOpen = true;
  overlay.classList.remove('hidden');
  showListView();
  await loadCollections();
}

export function closeCollections() {
  state.collectionsOpen = false;
  overlay.classList.add('hidden');
}

function hideAllViews() {
  listView.classList.add('hidden');
  formView.classList.add('hidden');
  archiveView.classList.add('hidden');
  archiveDetailView.classList.add('hidden');
}

function showListView() {
  hideAllViews();
  listView.classList.remove('hidden');
}

function showFormView() {
  hideAllViews();
  formView.classList.remove('hidden');
}

function showArchiveView() {
  hideAllViews();
  archiveView.classList.remove('hidden');
}

function showArchiveDetailView() {
  hideAllViews();
  archiveDetailView.classList.remove('hidden');
}

// ── Load collections from server ──────────────────────────────────────────────
async function loadCollections() {
  try {
    const res  = await getCollections();
    const data = await res.json();
    state.collections = data.collections || [];
    renderCollections();
  } catch (err) {
    console.error('[collections] load error:', err);
  }
}

// ── Open form (create or edit) ────────────────────────────────────────────────
async function openForm(id = null) {
  editingId  = id;
  formFeeds  = [];
  searchInput.value = '';
  searchResults.innerHTML = '';

  if (id) {
    colFormTitle.textContent = 'Edit collection';
    deleteBtn.classList.remove('hidden');
    try {
      const res  = await getCollection(id);
      const data = await res.json();
      nameInput.value = data.name || '';
      descInput.value = data.description || '';
      setFrequency(data.frequency || 'weekly');
      dowSelect.value = String(data.day_of_week ?? 1);
      setBehavior(data.no_episodes_behavior || 'suppress');
      formFeeds = (data.feeds || []).map(f => ({
        feed_id:        f.feed_id,
        feed_title:     f.feed_title,
        feed_thumbnail: f.feed_thumbnail,
      }));
    } catch (err) {
      console.error('[collections] load collection:', err);
    }
  } else {
    colFormTitle.textContent = 'New collection';
    deleteBtn.classList.add('hidden');
    nameInput.value = '';
    descInput.value = '';
    setFrequency('weekly');
    dowSelect.value = '1';
    setBehavior('suppress');
  }

  renderFormFeeds();
  showFormView();
  nameInput.focus();
}

// ── Form helpers ──────────────────────────────────────────────────────────────
function getFrequency() {
  return document.querySelector('input[name="colFreq"]:checked')?.value || 'weekly';
}

function setFrequency(val) {
  const radio = document.querySelector(`input[name="colFreq"][value="${val}"]`);
  if (radio) radio.checked = true;
  dowGroup.classList.toggle('hidden', val === 'daily');
}

function getBehavior() {
  return document.querySelector('input[name="colBehavior"]:checked')?.value || 'suppress';
}

function setBehavior(val) {
  const radio = document.querySelector(`input[name="colBehavior"][value="${val}"]`);
  if (radio) radio.checked = true;
}

// ── Inline podcast search ─────────────────────────────────────────────────────
async function doColSearch(q) {
  if (!q.trim()) { searchResults.innerHTML = ''; return; }
  searchResults.innerHTML = '<div class="col-search-spinner">Searching…</div>';
  try {
    const res  = await searchPodcasts(q);
    const data = await res.json();
    const results = data.results || [];
    if (!results.length) {
      searchResults.innerHTML = '<div class="col-search-empty">No results found.</div>';
      return;
    }
    searchResults.innerHTML = results.map(r => `
      <div class="col-search-item" data-id="${escHtml(r.id)}" data-title="${escHtml(r.title)}" data-thumb="${escHtml(r.thumbnail || '')}">
        ${r.thumbnail ? `<img src="${escHtml(r.thumbnail)}" class="col-feed-thumb" alt="" />` : '<div class="col-feed-thumb col-feed-thumb-placeholder"></div>'}
        <span class="col-feed-title">${escHtml(r.title)}</span>
        <button class="btn-primary btn-sm col-search-add">Add</button>
      </div>
    `).join('');

    searchResults.querySelectorAll('.col-search-item').forEach(el => {
      el.querySelector('.col-search-add').addEventListener('click', () => {
        addFeedToForm({
          feed_id:        el.dataset.id,
          feed_title:     el.dataset.title,
          feed_thumbnail: el.dataset.thumb,
        });
      });
    });
  } catch (err) {
    searchResults.innerHTML = `<div class="col-search-empty">Search failed: ${escHtml(err.message)}</div>`;
  }
}

function addFeedToForm(feed) {
  if (formFeeds.some(f => f.feed_id === feed.feed_id)) return; // already added
  formFeeds.push(feed);
  searchResults.innerHTML = '';
  searchInput.value = '';
  renderFormFeeds();
}

function removeFeedFromForm(index) {
  formFeeds.splice(index, 1);
  renderFormFeeds();
}

// ── Save (create or update) ───────────────────────────────────────────────────
async function saveForm() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); nameInput.classList.add('input-error'); return; }
  nameInput.classList.remove('input-error');

  const frequency  = getFrequency();
  const day_of_week = frequency === 'weekly' ? Number(dowSelect.value) : null;
  const payload = {
    name,
    description:          descInput.value.trim() || null,
    frequency,
    day_of_week,
    no_episodes_behavior: getBehavior(),
  };

  saveBtn.disabled = true;
  saveBtn.textContent = 'Saving…';

  try {
    let collectionId = editingId;

    if (editingId) {
      // Update settings
      await updateCollection(editingId, payload);

      // Reconcile feeds: get current server feeds, add/remove as needed
      const res   = await getCollection(editingId);
      const data  = await res.json();
      const existing = new Set((data.feeds || []).map(f => f.feed_id));
      const desired  = new Set(formFeeds.map(f => f.feed_id));

      // Remove feeds that were taken out
      for (const fid of existing) {
        if (!desired.has(fid)) await removeFeedFromCollection(editingId, fid);
      }
      // Add feeds that are new
      for (const f of formFeeds) {
        if (!existing.has(f.feed_id)) await addFeedToCollection(editingId, f);
      }
    } else {
      // Create collection
      const res    = await createCollection(payload);
      const data   = await res.json();
      collectionId = data.id;

      // Add all feeds
      for (const f of formFeeds) {
        await addFeedToCollection(collectionId, f);
      }
    }

    await loadCollections();
    showListView();
  } catch (err) {
    console.error('[collections] save error:', err);
    alert(`Failed to save: ${err.message}`);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Save';
  }
}

// ── Delete ────────────────────────────────────────────────────────────────────
async function confirmDelete() {
  if (!editingId) return;
  if (!confirm('Delete this collection? This cannot be undone.')) return;
  try {
    await deleteCollection(editingId);
    await loadCollections();
    showListView();
  } catch (err) {
    alert(`Failed to delete: ${err.message}`);
  }
}

// ── Archive: list view ────────────────────────────────────────────────────────
async function openArchive(collectionId) {
  currentArchiveColId = collectionId;
  const col = state.collections.find(c => c.id === collectionId);
  archiveTitle.textContent = col ? `${escHtml(col.name)} — History` : 'History';
  archiveList.innerHTML = '<div class="col-search-spinner">Loading…</div>';
  showArchiveView();

  try {
    const res  = await getCollectionArchive(collectionId);
    const data = await res.json();
    const archives = data.archives || [];

    if (!archives.length) {
      archiveList.innerHTML = `
        <div class="empty-state">
          <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>
          </svg>
          <p>No summaries sent yet for this collection.</p>
        </div>`;
      return;
    }

    archiveList.innerHTML = archives.map(a => `
      <div class="col-item col-archive-item" data-id="${a.id}">
        <div class="col-item-body">
          <div class="col-item-name">${formatDate(a.sent_at)}</div>
          <div class="col-item-meta">${a.total_episodes} episode${a.total_episodes !== 1 ? 's' : ''} · ${a.frequency === 'daily' ? 'Daily' : 'Weekly'} summary</div>
        </div>
        <svg class="col-item-arrow" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="9 18 15 12 9 6"/>
        </svg>
      </div>
    `).join('');

    archiveList.querySelectorAll('.col-archive-item').forEach(el => {
      el.addEventListener('click', () => openArchiveDetail(collectionId, Number(el.dataset.id)));
    });
  } catch (err) {
    archiveList.innerHTML = `<div class="col-search-empty">Failed to load history.</div>`;
    console.error('[collections] archive load error:', err);
  }
}

// ── Archive: detail view ──────────────────────────────────────────────────────
async function openArchiveDetail(collectionId, archiveId) {
  archiveDetailTitle.textContent = 'Loading…';
  archiveDetail.innerHTML = '<div class="col-search-spinner">Loading…</div>';
  showArchiveDetailView();

  try {
    const res  = await getCollectionArchiveEntry(collectionId, archiveId);
    const data = await res.json();

    archiveDetailTitle.textContent = formatDate(data.sent_at);

    // Group episodes by feed
    const feedMap = new Map();
    for (const ep of data.episodes || []) {
      const key = ep.feed_title || 'Podcast';
      if (!feedMap.has(key)) feedMap.set(key, []);
      feedMap.get(key).push(ep);
    }

    if (!feedMap.size) {
      archiveDetail.innerHTML = '<div class="col-search-empty">No episodes in this summary.</div>';
      return;
    }

    archiveDetail.innerHTML = Array.from(feedMap.entries()).map(([feedTitle, episodes]) => `
      <div class="col-archive-feed">
        <div class="col-archive-feed-title">${escHtml(feedTitle)}</div>
        ${episodes.map(ep => `
          <div class="col-archive-episode">
            <a class="col-archive-ep-title" href="${escHtml(ep.episode_url || '#')}" target="_blank" rel="noopener">
              ${escHtml(ep.episode_title || 'Untitled')}
            </a>
            ${ep.date_published ? `<div class="col-archive-ep-date">${formatDate(ep.date_published * 1000)}</div>` : ''}
            ${ep.ai_summary ? `<p class="col-archive-ep-summary">${escHtml(ep.ai_summary)}</p>` : ''}
          </div>
        `).join('')}
      </div>
    `).join('');
  } catch (err) {
    archiveDetail.innerHTML = `<div class="col-search-empty">Failed to load summary.</div>`;
    console.error('[collections] archive detail error:', err);
  }
}

// ── Init ──────────────────────────────────────────────────────────────────────
export function initCollections() {
  document.getElementById('colCloseBtn').addEventListener('click', closeCollections);
  document.getElementById('colNewBtn').addEventListener('click', () => openForm(null));
  document.getElementById('colBackBtn').addEventListener('click', showListView);
  document.getElementById('colArchiveBackBtn').addEventListener('click', showListView);
  document.getElementById('colArchiveDetailBackBtn').addEventListener('click', () => openArchive(currentArchiveColId));
  saveBtn.addEventListener('click', saveForm);
  deleteBtn.addEventListener('click', confirmDelete);

  // Frequency radios toggle day-of-week select
  document.querySelectorAll('input[name="colFreq"]').forEach(radio => {
    radio.addEventListener('change', () => {
      dowGroup.classList.toggle('hidden', radio.value === 'daily');
    });
  });

  // Debounced inline podcast search
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => doColSearch(searchInput.value.trim()), 350);
  });
}
