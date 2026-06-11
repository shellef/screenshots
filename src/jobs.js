const { randomUUID } = require('crypto');
const path = require('path');
const fs = require('fs/promises');
const { chromium } = require('playwright');
const { captureUrl } = require('./capture');
const { cleanupCaptures } = require('./cleanup');
const logger = require('./logger');

const CAPTURES_DIR = path.join(__dirname, '..', 'captures');

const jobs = new Map();

function createJob(urls) {
  const id = randomUUID();
  const job = {
    id,
    status: 'pending',
    createdAt: new Date().toISOString(),
    completedAt: null,
    total: urls.length,
    completed: 0,
    results: [],
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
  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const result = await captureUrl(browser, url, jobDir, i);
        job.results.push(result);
      } catch (err) {
        logger.error(`Unexpected error capturing ${url}: ${err.message}`);
        job.results.push({ requestedUrl: url, status: 'error', error: err.message });
      }
      job.completed += 1;
    }
  } finally {
    await browser.close();
  }

  job.status = 'completed';
  job.completedAt = new Date().toISOString();
  logger.info(`Job ${job.id} completed`, { total: job.total, completed: job.completed });
}

function getJob(id) {
  return jobs.get(id);
}

module.exports = { createJob, getJob, CAPTURES_DIR };
