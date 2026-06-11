// On WSLg, DISPLAY/WAYLAND_DISPLAY cause headless Chromium to hang indefinitely
// on page.screenshot() while trying to use GPU compositing via the host display.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;

const path = require('path');
const fs = require('fs');
const express = require('express');
const archiver = require('archiver');
const { createJob, getJob, CAPTURES_DIR } = require('./jobs');
const logger = require('./logger');

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/captures', express.static(CAPTURES_DIR));

app.post('/capture', (req, res) => {
  const { urls } = req.body || {};

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

  const job = createJob(urls);
  logger.info(`Created job ${job.id} for ${urls.length} URL(s)`);

  // Fire and forget: respond immediately, processing continues in the background.
  res.status(202).json({ jobId: job.id, status: job.status, total: job.total });
});

app.get('/jobs/:id', (req, res) => {
  const job = getJob(req.params.id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }
  res.json(job);
});

app.get('/jobs/:id/zip', (req, res) => {
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
