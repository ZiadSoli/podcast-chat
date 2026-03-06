require('dotenv').config();
const express  = require('express');
const axios    = require('axios');
const FormData = require('form-data');
const path     = require('path');
const fs       = require('fs');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const LISTENNOTES_API_KEY = process.env.LISTENNOTES_API_KEY;
const ANTHROPIC_API_KEY   = process.env.ANTHROPIC_API_KEY;
const OPENAI_API_KEY      = process.env.OPENAI_API_KEY;
const PORT = process.env.PORT || 3000;

const LISTENNOTES_BASE = 'https://listen-api.listennotes.com/api/v2';
const listennotes = (endpoint, params = {}) =>
  axios.get(`${LISTENNOTES_BASE}${endpoint}`, {
    headers: { 'X-ListenAPI-Key': LISTENNOTES_API_KEY },
    params,
  });

// ── Transcript cache (persisted to disk) ─────────────────────────────────────
const DATA_DIR    = path.join(__dirname, 'data');
const CACHE_FILE  = path.join(DATA_DIR, 'transcripts.json');
const CACHE_TTL   = 5 * 24 * 60 * 60 * 1000; // 5 days in ms
let transcriptCache = {};

function loadCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (fs.existsSync(CACHE_FILE)) {
      const raw  = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
      const cutoff = Date.now() - CACHE_TTL;
      let expired = 0;

      for (const [id, entry] of Object.entries(raw)) {
        if (entry.cachedAt && entry.cachedAt >= cutoff) {
          transcriptCache[id] = entry;
        } else {
          expired++;
        }
      }

      const kept = Object.keys(transcriptCache).length;
      console.log(`  Transcript cache: ${kept} episode(s) loaded${expired ? `, ${expired} expired and removed` : ''}`);

      // Persist the pruned cache back to disk
      if (expired > 0) saveCache();
    }
  } catch (err) {
    console.warn('  Could not load transcript cache:', err.message);
    transcriptCache = {};
  }
}

function saveCache() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(transcriptCache, null, 2), 'utf8');
  } catch (err) {
    console.warn('Could not save transcript cache:', err.message);
  }
}

loadCache();

// ── Transcription job store ──────────────────────────────────────────────────
const jobs = new Map();
let jobSeq = 0;

function createJob() {
  const id = `job_${++jobSeq}_${Date.now()}`;
  jobs.set(id, { status: 'pending', transcript: null, error: null, createdAt: Date.now() });
  // Prune jobs older than 30 minutes
  for (const [jid, j] of jobs) {
    if (Date.now() - j.createdAt > 30 * 60 * 1000) jobs.delete(jid);
  }
  return id;
}

// ── Background transcription ─────────────────────────────────────────────────
const AUDIO_LIMIT = 24.5 * 1024 * 1024; // 24.5 MB — Whisper max is 25 MB

async function transcribeEpisode(episodeId, jobId) {
  const job = jobs.get(jobId);

  try {
    // 1. Fetch episode metadata from ListenNotes
    job.status = 'fetching';
    const { data: episode } = await listennotes(`/episodes/${episodeId}`);

    if (!episode.audio) {
      throw new Error('No audio URL found for this episode. The podcast may not expose a direct MP3 link.');
    }

    // 2. Stream audio, collect up to AUDIO_LIMIT bytes
    job.status = 'downloading';
    const audioBuffer = await downloadAudio(episode.audio);

    // 3. Transcribe with Whisper
    job.status = 'transcribing';
    const form = new FormData();
    form.append('file', audioBuffer, {
      filename: 'audio.mp3',
      contentType: 'audio/mpeg',
      knownLength: audioBuffer.length,
    });
    form.append('model', 'whisper-1');
    form.append('response_format', 'text');

    const whisperRes = await axios.post(
      'https://api.openai.com/v1/audio/transcriptions',
      form,
      {
        headers: {
          Authorization: `Bearer ${OPENAI_API_KEY}`,
          ...form.getHeaders(),
        },
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600_000,
      }
    );

    const transcript = typeof whisperRes.data === 'string'
      ? whisperRes.data
      : whisperRes.data.text || JSON.stringify(whisperRes.data);

    job.status     = 'done';
    job.transcript = transcript;

    // ── Persist to disk so future sessions skip re-transcription ──
    transcriptCache[episodeId] = {
      transcript,
      title:     episode.title,
      podcast:   episode.podcast?.title || null,
      thumbnail: episode.thumbnail || episode.podcast?.thumbnail || null,
      cachedAt:  Date.now(),
    };
    saveCache();

  } catch (err) {
    job.status = 'error';
    job.error  = err.response?.data?.error?.message || err.message;
  }
}

async function downloadAudio(url) {
  const chunks = [];
  let total = 0;

  const response = await axios.get(url, {
    responseType: 'stream',
    timeout: 90_000,
    headers: { Range: `bytes=0-${Math.ceil(AUDIO_LIMIT) - 1}` },
    validateStatus: s => s >= 200 && s < 300,
  });

  await new Promise((resolve, reject) => {
    response.data.on('data', chunk => {
      if (total < AUDIO_LIMIT) {
        chunks.push(chunk);
        total += chunk.length;
      }
      if (total >= AUDIO_LIMIT) {
        response.data.destroy();
        resolve();
      }
    });
    response.data.on('end', resolve);
    response.data.on('error', reject);
    response.data.on('close', resolve);
  });

  return Buffer.concat(chunks);
}

// ── Routes ───────────────────────────────────────────────────────────────────

// Search podcasts or episodes
app.get('/api/search', async (req, res) => {
  const { q, offset = 0, type = 'podcast' } = req.query;
  if (!q) return res.status(400).json({ error: 'Query parameter "q" is required.' });
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  try {
    const { data } = await listennotes('/search', { q, type, language: 'English', sort_by_date: 0, offset });
    res.json(data);
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// Get episodes for a podcast
app.get('/api/podcast/:id/episodes', async (req, res) => {
  const { id } = req.params;
  const { next_episode_pub_date } = req.query;
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  try {
    const params = { sort: 'recent_first' };
    if (next_episode_pub_date) params.next_episode_pub_date = next_episode_pub_date;

    const { data } = await listennotes(`/podcasts/${id}`, params);
    res.json({
      podcast: {
        id:             data.id,
        title:          data.title,
        publisher:      data.publisher,
        thumbnail:      data.thumbnail,
        total_episodes: data.total_episodes,
      },
      episodes: (data.episodes || []).map(ep => ({
        id:               ep.id,
        title:            ep.title,
        thumbnail:        ep.thumbnail || data.thumbnail,
        pub_date_ms:      ep.pub_date_ms,
        audio_length_sec: ep.audio_length_sec,
        cached:           !!transcriptCache[ep.id],   // ← tell the UI if already cached
      })),
      next_episode_pub_date: data.next_episode_pub_date,
    });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.message || err.message });
  }
});

// Start transcription job (or return cached transcript immediately)
app.post('/api/transcribe/:episodeId', (req, res) => {
  if (!OPENAI_API_KEY)      return res.status(500).json({ error: 'OPENAI_API_KEY is not configured.' });
  if (!LISTENNOTES_API_KEY) return res.status(500).json({ error: 'LISTENNOTES_API_KEY is not configured.' });

  const { episodeId } = req.params;
  const jobId = createJob();

  // Cache hit — resolve the job immediately, no Whisper call needed
  if (transcriptCache[episodeId]) {
    const cached = transcriptCache[episodeId];
    const job = jobs.get(jobId);
    job.status     = 'done';
    job.transcript = cached.transcript;
    return res.json({ jobId, cached: true });
  }

  // Cache miss — start background transcription
  res.json({ jobId, cached: false });
  transcribeEpisode(episodeId, jobId).catch(() => {});
});

// Poll transcription job
app.get('/api/transcribe/job/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  const { transcript, ...rest } = job;
  res.json(job.status === 'done' ? job : rest);
});

// Chat
app.post('/api/chat', async (req, res) => {
  const { messages, episodes } = req.body;
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY is not configured.' });
  if (!messages?.length)  return res.status(400).json({ error: 'messages array is required.' });

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
      { headers: { 'x-api-key': ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' } }
    );
    res.json({ reply: data.content[0].text });
  } catch (err) {
    res.status(err.response?.status || 500).json({ error: err.response?.data?.error?.message || err.message });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status:      'ok',
    listennotes: !!LISTENNOTES_API_KEY,
    anthropic:   !!ANTHROPIC_API_KEY,
    openai:      !!OPENAI_API_KEY,
    cachedEpisodes: Object.keys(transcriptCache).length,
  });
});

app.listen(PORT, () => {
  console.log(`\nPodcast Chat running at http://localhost:${PORT}`);
  console.log(`  ListenNotes: ${LISTENNOTES_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  Anthropic:   ${ANTHROPIC_API_KEY   ? 'set' : 'MISSING'}`);
  console.log(`  OpenAI:      ${OPENAI_API_KEY       ? 'set' : 'MISSING'}\n`);
});
