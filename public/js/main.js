import { initAuth } from './components/auth.js';
import { initSearch, renderSearchResults } from './components/search.js';
import { initKnowledgeBase, addEpisode, renderKb } from './components/knowledge-base.js';
import { initChat, renderChat, updateSendBtn } from './components/chat.js';
import { checkHealth } from './api.js';

// ── Layout / mobile tabs ──────────────────────────────────────────
const isMobile = () => window.innerWidth <= 900;

function switchTab(panelId) {
  if (!isMobile()) return;
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('mobile-active'));
  document.getElementById(panelId)?.classList.add('mobile-active');
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.panel === panelId);
  });
  if (panelId === 'chatPanel') {
    const chatMessages = document.getElementById('chatMessages');
    if (chatMessages) requestAnimationFrame(() => { chatMessages.scrollTop = chatMessages.scrollHeight; });
  }
}

function initLayout() {
  if (isMobile()) {
    const hasActive = document.querySelector('.panel.mobile-active');
    if (!hasActive) switchTab('searchPanel');
  } else {
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('mobile-active'));
  }
}

// ── API health badge ──────────────────────────────────────────────
async function initHealth() {
  try {
    const res = await checkHealth();
    const { listennotes, anthropic, openai } = await res.json();
    document.getElementById('apiStatus').innerHTML = `
      <span class="${listennotes ? 'ok' : 'miss'}"><span class="dot"></span> ListenNotes</span>
      <span class="${anthropic  ? 'ok' : 'miss'}"><span class="dot"></span> Anthropic</span>
      <span class="${openai     ? 'ok' : 'miss'}"><span class="dot"></span> OpenAI</span>
    `;
  } catch (_) {}
}

// ── Wire components ───────────────────────────────────────────────
initSearch({ onAddEpisode: id => addEpisode(id) });
initKnowledgeBase({ onEpisodeAdded: () => { if (isMobile()) switchTab('kbPanel'); } });
initChat();

// Tab buttons
document.querySelectorAll('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => switchTab(btn.dataset.panel));
});
window.addEventListener('resize', initLayout);

// ── Boot ──────────────────────────────────────────────────────────
(async () => {
  const authed = await initAuth();
  if (!authed) return;

  initHealth();
  renderKb();
  renderChat();
  renderSearchResults();
  updateSendBtn();
  initLayout();
})();
