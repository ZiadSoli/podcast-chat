const axios = require('axios');

// ── Strip HTML tags for use as fallback or plain-text input ──────────────────
function stripHtml(raw) {
  return (raw || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// ── Generate a 2-3 sentence AI summary of a podcast episode ──────────────────
// Falls back to a truncated plain-text description if the API call fails,
// so a missing key or transient error never blocks episode queuing.
async function summarizeEpisode(title, description) {
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  const plain = stripHtml(description);

  if (!ANTHROPIC_API_KEY || !plain) {
    return plain.slice(0, 300) || null;
  }

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      {
        model: 'claude-haiku-4-5',
        max_tokens: 200,
        system: 'You summarize podcast episodes. Given an episode title and its description, write a concise 2-3 sentence summary in plain text. No bullet points, no markdown, no intro phrases like "In this episode". Just the summary.',
        messages: [
          {
            role: 'user',
            content: `Title: ${title}\n\nDescription: ${plain.slice(0, 2000)}`,
          },
        ],
      },
      {
        headers: {
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        timeout: 15_000,
      }
    );

    return data.content?.[0]?.text?.trim() || plain.slice(0, 300);
  } catch (err) {
    const detail = err.response?.data?.error?.message || err.message;
    console.warn(`[summarize] Claude API error for "${title}": ${detail}`);
    return plain.slice(0, 300) || null;
  }
}

module.exports = { summarizeEpisode };
