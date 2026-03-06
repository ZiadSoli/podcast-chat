require('dotenv').config({ path: require('path').join(__dirname, '.env') });
const express = require('express');
const path    = require('path');

const { sessionMiddleware } = require('./src/middleware/auth');
const authRoutes         = require('./src/routes/auth');
const searchRoutes       = require('./src/routes/search');
const transcribeRoutes   = require('./src/routes/transcribe');
const chatRoutes         = require('./src/routes/chat');
const collectionsRoutes  = require('./src/routes/collections');
const { startScheduler } = require('./src/services/scheduler');

const app  = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.use(sessionMiddleware);

app.use('/',    authRoutes);
app.use('/api', searchRoutes);
app.use('/api', transcribeRoutes);
app.use('/api', chatRoutes);
app.use('/api', collectionsRoutes);

app.listen(PORT, () => {
  startScheduler();
  console.log(`\nPodcast Chat running at http://localhost:${PORT}`);
  console.log(`  PodcastIndex: ${process.env.PODCASTINDEX_API_KEY ? 'set' : 'MISSING'}`);
  console.log(`  Anthropic:    ${process.env.ANTHROPIC_API_KEY    ? 'set' : 'MISSING'}`);
  console.log(`  OpenAI:       ${process.env.OPENAI_API_KEY        ? 'set' : 'MISSING'}`);
  console.log(`  Email:        ${process.env.RESEND_API_KEY         ? 'Resend configured' : 'DEV MODE (links logged to console)'}`);
  console.log(`  Base URL:     ${process.env.BASE_URL || `http://localhost:${PORT}`}\n`);
});
