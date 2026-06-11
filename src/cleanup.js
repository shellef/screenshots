const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000; // 1 month
const MAX_TOTAL_BYTES = 1 * 1024 * 1024 * 1024; // 1 GB

async function dirSize(dirPath) {
  let total = 0;
  const entries = await fs.readdir(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      total += await dirSize(fullPath);
    } else {
      const stat = await fs.stat(fullPath);
      total += stat.size;
    }
  }
  return total;
}

/**
 * Removes old/excess job directories from capturesDir:
 *  - any job folder older than MAX_AGE_MS (by mtime) is deleted
 *  - if the total size of capturesDir still exceeds MAX_TOTAL_BYTES,
 *    the oldest remaining job folders are deleted until it's under the limit
 */
async function cleanupCaptures(capturesDir) {
  let entries;
  try {
    entries = await fs.readdir(capturesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT') return;
    throw err;
  }

  const jobDirs = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const fullPath = path.join(capturesDir, entry.name);
    const stat = await fs.stat(fullPath);
    jobDirs.push({ name: entry.name, path: fullPath, mtimeMs: stat.mtimeMs });
  }

  const now = Date.now();
  const remaining = [];
  for (const dir of jobDirs) {
    if (now - dir.mtimeMs > MAX_AGE_MS) {
      await fs.rm(dir.path, { recursive: true, force: true });
      logger.info(`Cleanup: removed old capture ${dir.name} (older than 30 days)`);
    } else {
      remaining.push(dir);
    }
  }

  // Oldest first, so they get deleted first if we're over the size limit.
  remaining.sort((a, b) => a.mtimeMs - b.mtimeMs);

  let totalSize = 0;
  for (const dir of remaining) {
    dir.size = await dirSize(dir.path);
    totalSize += dir.size;
  }

  for (const dir of remaining) {
    if (totalSize <= MAX_TOTAL_BYTES) break;
    await fs.rm(dir.path, { recursive: true, force: true });
    totalSize -= dir.size;
    logger.info(`Cleanup: removed capture ${dir.name} (over 1GB total storage limit)`);
  }
}

module.exports = { cleanupCaptures, MAX_AGE_MS, MAX_TOTAL_BYTES };
