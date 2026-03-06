const crypto        = require('crypto');
const { EventEmitter } = require('events');
const axios         = require('axios');
const FormData      = require('form-data');
const { db, putCached } = require('../db/index');

const AUDIO_LIMIT = 24.5 * 1024 * 1024;

// ── Job event bus — SSE handlers listen here ──────────────────────────────────
const jobEmitter = new EventEmitter();
jobEmitter.setMaxListeners(0); // one listener per active SSE connection — suppress Node warning

// ── Prepared statements: jobs ─────────────────────────────────────────────────
const stmtCreateJob    = db.prepare('INSERT INTO jobs (id, episode_id, status, transcript, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
const stmtGetJob       = db.prepare('SELECT * FROM jobs WHERE id = ?');
const stmtUpdateStatus = db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?');
const stmtSetDone      = db.prepare('UPDATE jobs SET status = ?, transcript = ?, updated_at = ? WHERE id = ?');
const stmtSetError     = db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?');
const stmtCleanJobs    = db.prepare('DELETE FROM jobs WHERE created_at < ?');

// Periodic cleanup — delete jobs older than 30 minutes
setInterval(() => stmtCleanJobs.run(Date.now() - 30 * 60 * 1000), 10 * 60 * 1000).unref();

// ── Concurrency-limited queue ─────────────────────────────────────────────────
const CONCURRENCY = 3;
let running = 0;
const pendingQueue = []; // array of () => Promise<void>

function drain() {
  while (running < CONCURRENCY && pendingQueue.length > 0) {
    const task = pendingQueue.shift();
    running++;
    task().finally(() => { running--; drain(); });
  }
}

function enqueueTranscription(episodeId, jobId) {
  pendingQueue.push(() => transcribeEpisode(episodeId, jobId));
  drain();
}

function createJob(episodeId) {
  const id  = crypto.randomBytes(16).toString('hex');
  const now = Date.now();
  stmtCreateJob.run(id, episodeId, 'pending', null, null, now, now);
  return id;
}

function getJob(jobId) {
  return stmtGetJob.get(jobId) || null;
}

function setJobDone(jobId, transcript) {
  stmtSetDone.run('done', transcript, Date.now(), jobId);
  jobEmitter.emit(jobId, { status: 'done', transcript });
}

async function transcribeEpisode(episodeId, jobId) {
  try {
    stmtUpdateStatus.run('fetching', Date.now(), jobId);
    jobEmitter.emit(jobId, { status: 'fetching' });

    const { data: episode } = await axios.get(
      `https://listen-api.listennotes.com/api/v2/episodes/${episodeId}`,
      { headers: { 'X-ListenAPI-Key': process.env.LISTENNOTES_API_KEY } }
    );

    if (!episode.audio) {
      throw new Error('No audio URL found for this episode. The podcast may not expose a direct MP3 link.');
    }

    stmtUpdateStatus.run('downloading', Date.now(), jobId);
    jobEmitter.emit(jobId, { status: 'downloading' });
    const audioBuffer = await downloadAudio(episode.audio);

    stmtUpdateStatus.run('transcribing', Date.now(), jobId);
    jobEmitter.emit(jobId, { status: 'transcribing' });
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
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
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

    stmtSetDone.run('done', transcript, Date.now(), jobId);
    jobEmitter.emit(jobId, { status: 'done', transcript });

    putCached(episodeId, {
      transcript,
      title:     episode.title,
      podcast:   episode.podcast?.title || null,
      thumbnail: episode.thumbnail || episode.podcast?.thumbnail || null,
    });

  } catch (err) {
    const error = err.response?.data?.error?.message || err.message;
    stmtSetError.run('error', error, Date.now(), jobId);
    jobEmitter.emit(jobId, { status: 'error', error });
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

module.exports = { createJob, getJob, setJobDone, enqueueTranscription, jobEmitter };
