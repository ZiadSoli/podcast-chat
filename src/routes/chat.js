const express  = require('express');
const axios    = require('axios');
const { stmtCount } = require('../db/index');
const { requireAuth } = require('../middleware/auth');

const router = express.Router();

router.post('/chat', requireAuth, async (req, res) => {
  const { messages, episodes } = req.body;
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
  if (!messages?.length)              return res.status(400).json({ error: 'messages array is required.' });

  const MAX_CHARS = 12_000;
  const knowledgeBase = (episodes || [])
    .filter(e => e.transcript)
    .map(e => {
      const content   = e.transcript.slice(0, MAX_CHARS);
      const truncated = e.transcript.length > MAX_CHARS ? ' [truncated]' : '';
      return `### Episode: "${e.title}"${e.podcast ? ` (${e.podcast})` : ''}\n${content}${truncated}`;
    })
    .join('\n\n---\n\n');

  const systemPrompt = knowledgeBase.length > 0
    ? `You are a helpful assistant that answers questions about podcast episodes. Use the provided transcripts as your primary knowledge source. If the answer isn't in the transcripts, say so and offer general knowledge if appropriate.\n\nTranscripts:\n\n${knowledgeBase}`
    : 'You are a helpful assistant. No podcast transcripts have been loaded yet — ask the user to select and transcribe some episodes first.';

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: 'claude-opus-4-6', max_tokens: 1536, system: systemPrompt, messages },
      { headers: { 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    res.json({ reply: data.content[0].text });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

router.get('/health', requireAuth, (req, res) => {
  res.json({
    status:      'ok',
    listennotes: !!process.env.LISTENNOTES_API_KEY,
    anthropic:   !!process.env.ANTHROPIC_API_KEY,
    openai:      !!process.env.OPENAI_API_KEY,
    cachedEpisodes: stmtCount.get().n,
  });
});

module.exports = router;
