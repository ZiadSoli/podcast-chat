const express  = require('express');
const { getCached } = require('../db/index');
const { requireAuth } = require('../middleware/auth');
const { createJob, getJob, setJobDone, enqueueTranscription, jobEmitter } = require('../services/transcription');

const router = express.Router();

router.post('/transcribe/:episodeId', requireAuth, (req, res) => {
  if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'OPENAI_API_KEY is not configured.' });
  if (!process.env.PODCASTINDEX_API_KEY || !process.env.PODCASTINDEX_API_SECRET)
    return res.status(500).json({ error: 'PODCASTINDEX_API_KEY / PODCASTINDEX_API_SECRET not configured.' });

  const { episodeId } = req.params;
  const jobId = createJob(episodeId);

  const cached = getCached(episodeId);
  if (cached) {
    setJobDone(jobId, cached.transcript);
    return res.json({ jobId, cached: true });
  }

  res.json({ jobId, cached: false });
  enqueueTranscription(episodeId, jobId);
});

// SSE endpoint — must be registered before the polling route so Express doesn't
// match /transcribe/job/:jobId first with jobId="abc123/stream"
router.get('/transcribe/job/:jobId/stream', requireAuth, (req, res) => {
  const { jobId } = req.params;
  const job = getJob(jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const send = data => res.write(`data: ${JSON.stringify(data)}\n\n`);

  // Send current state immediately — client catches up if job already progressed
  const { transcript, ...rest } = job;
  send(job.status === 'done' ? job : rest);

  // Already in a terminal state — nothing more to push
  if (job.status === 'done' || job.status === 'error') return res.end();

  // Keepalive comment every 15s — prevents proxies dropping idle connections
  const keepalive = setInterval(() => res.write(': keepalive\n\n'), 15_000);

  const onUpdate = data => {
    send(data);
    if (data.status === 'done' || data.status === 'error') { cleanup(); res.end(); }
  };

  const cleanup = () => { clearInterval(keepalive); jobEmitter.off(jobId, onUpdate); };

  jobEmitter.on(jobId, onUpdate);
  req.on('close', cleanup); // client disconnected — remove listener to avoid leaks
});

// Polling endpoint — kept for debugging / fallback
router.get('/transcribe/job/:jobId', requireAuth, (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found or expired.' });
  const { transcript, ...rest } = job;
  res.json(job.status === 'done' ? job : rest);
});

module.exports = router;
