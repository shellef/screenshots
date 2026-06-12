const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { captureUrl } = require('./capture');
const { cleanupCaptures } = require('./cleanup');
const logger = require('./logger');

const CAPTURES_DIR = path.join(__dirname, '..', 'captures');

const jobs = new Map();

function createJob(urls, user) {
  const id = randomUUID();
  const job = {
    id,
    status: 'pending',
    user: user || null,
    createdAt: new Date().toISOString(),
    completedAt: null,
    total: urls.length,
    completed: 0,
    results: [],
    cancelRequested: false,
    _browser: null,
  };
  jobs.set(id, job);

  // Fire and forget: processing happens in the background.
  processJob(job, urls).catch((err) => {
    logger.error(`Job ${id} failed unexpectedly: ${err.message}`);
    job.status = 'failed';
    job.error = err.message;
    job.completedAt = new Date().toISOString();
  });

  return job;
}

async function processJob(job, urls) {
  job.status = 'running';

  try {
    await cleanupCaptures(CAPTURES_DIR);
  } catch (err) {
    logger.error(`Cleanup failed: ${err.message}`);
  }

  const jobDir = path.join(CAPTURES_DIR, job.id);
  await fs.mkdir(jobDir, { recursive: true });

  const browser = await chromium.launch({
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  job._browser = browser;
  try {
    for (let i = 0; i < urls.length; i++) {
      if (job.cancelRequested) break;

      const url = urls[i];
      try {
        const result = await captureUrl(browser, url, jobDir, i, {
          isCancelled: () => job.cancelRequested,
        });
        if (result === null) break; // cancelled mid-capture
        job.results.push(result);
      } catch (err) {
        if (job.cancelRequested) break;
        logger.error(`Unexpected error capturing ${url}: ${err.message}`);
        job.results.push({ requestedUrl: url, status: 'error', error: err.message });
      }
      job.completed += 1;
    }
  } finally {
    job._browser = null;
    await browser.close().catch(() => {});
  }

  job.status = job.cancelRequested ? 'cancelled' : 'completed';
  job.completedAt = new Date().toISOString();
  logger.info(`Job ${job.id} ${job.status}`, { user: job.user, total: job.total, completed: job.completed });
}

function getJob(id) {
  return jobs.get(id);
}

function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) return null;

  if (job.status === 'pending' || job.status === 'running') {
    job.cancelRequested = true;
    // Abort the in-flight capture immediately rather than waiting for it to finish.
    if (job._browser) {
      job._browser.close().catch(() => {});
    }
  }

  return job;
}

module.exports = { createJob, getJob, cancelJob, CAPTURES_DIR };
