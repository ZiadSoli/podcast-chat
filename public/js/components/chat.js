import { state } from '../state.js';
import { escHtml, scrollBottom } from '../utils.js';
import { sendChatMessage } from '../api.js';
import { redirectIfUnauth } from './auth.js';
import { seekTo } from './player.js';
import { marked } from 'https://esm.sh/marked';

marked.use({ gfm: true, breaks: true });

// ── Timestamp linkification ───────────────────────────────────────────────────
// Converts [M:SS] or [H:MM:SS] patterns inside rendered HTML into clickable
// buttons that call seekTo() on the audio player.
function linkifyTimestamps(html) {
  return html.replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (match, ts) => {
    const parts = ts.split(':').map(Number);
    const secs = parts.length === 3
      ? parts[0] * 3600 + parts[1] * 60 + parts[2]
      : parts[0] * 60 + parts[1];
    return `<button class="ts-link" data-seconds="${secs}" title="Jump to ${ts}">${match}</button>`;
  });
}

const chatMessages = document.getElementById('chatMessages');
const chatInput    = document.getElementById('chatInput');
const sendBtn      = document.getElementById('sendBtn');
const clearChatBtn = document.getElementById('clearChatBtn');

export function renderChat() {
  if (state.chatHistory.length === 0) {
    chatMessages.innerHTML = `
      <div class="message assistant-message">
        <div class="message-content">Add podcast episodes to your knowledge base, then ask me anything about them.</div>
      </div>`;
    return;
  }

  chatMessages.innerHTML = state.chatHistory.map(msg => {
    const content = msg.role === 'assistant'
      ? linkifyTimestamps(marked.parse(msg.content))
      : escHtml(msg.content);
    return `
    <div class="message ${msg.role === 'user' ? 'user-message' : 'assistant-message'}">
      <div class="msg-role">${msg.role === 'user' ? 'You' : 'Assistant'}</div>
      <div class="message-content">${content}</div>
    </div>`;
  }).join('');

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

export function updateSendBtn() {
  sendBtn.disabled = state.chatting || chatInput.value.trim().length === 0;
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
    const res = await sendChatMessage(
      state.chatHistory,
      state.episodes.map(e => ({ title: e.title, podcast: e.podcast, transcript: e.transcript }))
    );

    if (redirectIfUnauth(res)) { bubble.remove(); return; }
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

export function initChat() {
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

  // Timestamp links in assistant messages → seek audio player
  chatMessages.addEventListener('click', e => {
    const btn = e.target.closest('.ts-link');
    if (btn) seekTo(parseInt(btn.dataset.seconds, 10));
  });
}
