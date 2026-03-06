import { state } from '../state.js';
import { escHtml, scrollBottom } from '../utils.js';
import { sendChatMessage } from '../api.js';
import { redirectIfUnauth } from './auth.js';
import { marked } from 'https://esm.sh/marked';

marked.use({ gfm: true, breaks: true });

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

  chatMessages.innerHTML = state.chatHistory.map(msg => `
    <div class="message ${msg.role === 'user' ? 'user-message' : 'assistant-message'}">
      <div class="msg-role">${msg.role === 'user' ? 'You' : 'Assistant'}</div>
      <div class="message-content">${msg.role === 'assistant' ? marked.parse(msg.content) : escHtml(msg.content)}</div>
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
}
