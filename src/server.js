// On WSLg, DISPLAY/WAYLAND_DISPLAY cause headless Chromium to hang indefinitely
// on page.screenshot() while trying to use GPU compositing via the host display.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const express = require('express');
const session = require('express-session');
const archiver = require('archiver');
const { createJob, getJob, cancelJob, CAPTURES_DIR } = require('./jobs');
const { router: authRouter, requireAuth } = require('./auth');
const logger = require('./logger');

const app = express();
app.set('trust proxy', 1);
app.use(express.json());
app.use(session({
  secret: process.env.SESSION_SECRET_KEY || 'dev-secret-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.EXTERNAL_URL ? process.env.EXTERNAL_URL.startsWith('https://') : false,
    maxAge: 30 * 24 * 60 * 60 * 1000, // 30 days
  },
}));

app.use(authRouter);

app.use(requireAuth, express.static(path.join(__dirname, '..', 'public')));
app.use('/captures', requireAuth, express.static(CAPTURES_DIR));

app.post('/capture', requireAuth, (req, res) => {
  const { urls, scrollCount } = req.body || {};

  if (!Array.isArray(urls) || urls.length === 0) {
    return res.status(400).json({ error: 'Request body must include a non-empty "urls" array.' });
  }

  for (const url of urls) {
    if (typeof url !== 'string') {
      return res.status(400).json({ error: 'All entries in "urls" must be strings.' });
    }
    try {
      const parsed = new URL(url);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return res.status(400).json({ error: `Unsupported URL scheme: ${url}` });
      }
    } catch {
      return res.status(400).json({ error: `Invalid URL: ${url}` });
    }
  }

  let scrollCountNum = 0;
  if (scrollCount !== undefined) {
    scrollCountNum = Number(scrollCount);
    if (!Number.isInteger(scrollCountNum) || scrollCountNum < 0 || scrollCountNum > 100) {
      return res.status(400).json({ error: '"scrollCount" must be an integer between 0 and 100.' });
    }
  }

  const user = req.session && req.session.user ? req.session.user : null;
  const job = createJob(urls, user, scrollCountNum);
  logger.info(`Created job ${job.id} for ${urls.length} URL(s)`, { user });

  // Fire and forget: respond immediately, processing continues in the background.
  res.status(202).json({ jobId: job.id, status: job.status, total: job.total });
});

app.get('/jobs/:id', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  const { _browser, ...jobJson } = job;
  res.json(jobJson);
});

app.post('/jobs/:id/cancel', requireAuth, (req, res) => {
  const job = cancelJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  const { _browser, ...jobJson } = job;
  res.json(jobJson);
});

app.get('/jobs/:id/zip', requireAuth, (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const jobDir = path.join(CAPTURES_DIR, job.id);
  if (!fs.existsSync(jobDir)) {
    return res.status(404).json({ error: 'No captures found for this job' });
  }

  res.attachment(`captures-${job.id}.zip`);

  const archive = archiver('zip', { zlib: { level: 9 } });
  archive.on('error', (err) => {
    logger.error(`Zip error for job ${job.id}: ${err.message}`);
    res.status(500).end();
  });

  archive.pipe(res);
  archive.directory(jobDir, false);
  archive.finalize();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  logger.info(`Server listening on port ${PORT}`);
});
