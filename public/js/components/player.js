// ── DOM refs ────────────────────────────────────────────────────────────────
const playerBar       = document.getElementById('audioPlayer');
const audioEl         = document.getElementById('audioElement');
const playerThumb     = document.getElementById('playerThumb');
const playerTitle     = document.getElementById('playerTitle');
const playerPodcast   = document.getElementById('playerPodcast');
const playerPlayPause = document.getElementById('playerPlayPause');
const playerRewind    = document.getElementById('playerRewind');
const playerForward   = document.getElementById('playerForward');
const playerSeek      = document.getElementById('playerSeek');
const playerCurrent   = document.getElementById('playerCurrent');
const playerDuration  = document.getElementById('playerDuration');
const playerSpeed     = document.getElementById('playerSpeed');
const playerClose     = document.getElementById('playerClose');

// ── State ────────────────────────────────────────────────────────────────────
let currentEpisode = null;
let seeking = false;

// ── Helpers ──────────────────────────────────────────────────────────────────
function fmtTime(secs) {
  if (!isFinite(secs) || secs < 0) return '0:00';
  const s = Math.floor(secs);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function syncPlayPause() {
  playerPlayPause.textContent = audioEl.paused ? '▶' : '⏸';
}

// ── Public API ───────────────────────────────────────────────────────────────

/** Load an episode object from the knowledge base into the player and start playing. */
export function loadEpisode(episode) {
  currentEpisode = episode;
  audioEl.src = episode.audioUrl;
  playerThumb.src = episode.thumbnail || '';
  playerThumb.style.visibility = episode.thumbnail ? 'visible' : 'hidden';
  playerTitle.textContent   = episode.title;
  playerPodcast.textContent = episode.podcast;
  playerSeek.value = 0;
  playerCurrent.textContent  = '0:00';
  playerDuration.textContent = '0:00';
  playerBar.classList.remove('hidden');
  audioEl.play().catch(() => {}); // browsers may block autoplay until user gesture
  syncPlayPause();
}

/** Seek the currently loaded episode to `seconds` and resume playback. */
export function seekTo(seconds) {
  if (!currentEpisode || !isFinite(seconds)) return;
  audioEl.currentTime = Math.max(0, seconds);
  if (audioEl.paused) audioEl.play().catch(() => {});
  syncPlayPause();
}

/** Returns the ID of the currently loaded episode, or null. */
export function getCurrentEpisodeId() {
  return currentEpisode?.id ?? null;
}

// ── Init ─────────────────────────────────────────────────────────────────────
export function initPlayer() {
  // Play / pause
  audioEl.addEventListener('play',  syncPlayPause);
  audioEl.addEventListener('pause', syncPlayPause);
  audioEl.addEventListener('ended', syncPlayPause);

  // Progress updates
  audioEl.addEventListener('timeupdate', () => {
    if (seeking) return;
    const cur = audioEl.currentTime;
    const dur = audioEl.duration;
    if (isFinite(dur) && dur > 0) {
      playerSeek.max   = Math.floor(dur);
      playerSeek.value = Math.floor(cur);
    }
    playerCurrent.textContent = fmtTime(cur);
  });

  audioEl.addEventListener('loadedmetadata', () => {
    const dur = audioEl.duration;
    if (isFinite(dur)) {
      playerSeek.max = Math.floor(dur);
      playerDuration.textContent = fmtTime(dur);
    }
  });

  audioEl.addEventListener('durationchange', () => {
    const dur = audioEl.duration;
    if (isFinite(dur)) {
      playerSeek.max = Math.floor(dur);
      playerDuration.textContent = fmtTime(dur);
    }
  });

  // Controls
  playerPlayPause.addEventListener('click', () => {
    if (audioEl.paused) audioEl.play().catch(() => {});
    else audioEl.pause();
  });

  playerRewind.addEventListener('click', () => {
    audioEl.currentTime = Math.max(0, audioEl.currentTime - 15);
  });

  playerForward.addEventListener('click', () => {
    audioEl.currentTime = Math.min(audioEl.duration || 0, audioEl.currentTime + 30);
  });

  // Scrubbing — prevent timeupdate race while dragging
  playerSeek.addEventListener('mousedown',  () => { seeking = true; });
  playerSeek.addEventListener('touchstart', () => { seeking = true; }, { passive: true });
  playerSeek.addEventListener('input', () => {
    playerCurrent.textContent = fmtTime(playerSeek.value);
  });
  playerSeek.addEventListener('change', () => {
    audioEl.currentTime = Number(playerSeek.value);
    seeking = false;
  });

  playerSpeed.addEventListener('change', () => {
    audioEl.playbackRate = parseFloat(playerSpeed.value);
  });

  playerClose.addEventListener('click', () => {
    audioEl.pause();
    audioEl.src = '';
    currentEpisode = null;
    playerBar.classList.add('hidden');
    syncPlayPause();
  });
}
