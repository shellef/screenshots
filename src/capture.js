const fs = require('fs/promises');
const path = require('path');
const logger = require('./logger');

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const NAV_TIMEOUT_MS = 30000;
const SCREENSHOT_TIMEOUT_MS = 30000;
// Hard ceiling on a single capture attempt (nav + settle + screenshot + html).
// Without this, a page that hangs on screenshot (huge/infinite-scroll pages,
// stuck media, etc.) can block the whole job indefinitely.
const ATTEMPT_TIMEOUT_MS = 90000;

function sanitizeForPath(str, maxLen = 80) {
  return str.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, maxLen);
}

function safeHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return 'invalid-url';
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureUrl(browser, url, outputDir, index) {
  const folderName = `${String(index).padStart(3, '0')}-${sanitizeForPath(safeHostname(url))}`;
  const captureDir = path.join(outputDir, folderName);
  await fs.mkdir(captureDir, { recursive: true });

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    let context;
    try {
      context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      const attemptPromise = (async () => {
        const response = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });

        // Give dynamic / lazy-loaded content a moment to settle before capturing.
        await page.waitForTimeout(2000);

        const finalUrl = page.url();
        const title = await page.title();
        const html = await page.content();
        const capturedAt = new Date().toISOString();

        await page.screenshot({
          path: path.join(captureDir, 'screenshot.png'),
          fullPage: true,
          timeout: SCREENSHOT_TIMEOUT_MS,
        });
        await fs.writeFile(path.join(captureDir, 'page.html'), html, 'utf-8');

        return {
          requestedUrl: url,
          finalUrl,
          title,
          httpStatus: response ? response.status() : null,
          capturedAt,
          attempt,
          status: 'success',
          folder: folderName,
        };
      })();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Capture attempt timed out after ${ATTEMPT_TIMEOUT_MS}ms`)), ATTEMPT_TIMEOUT_MS);
      });

      const metadata = await Promise.race([attemptPromise, timeoutPromise]);
      await fs.writeFile(path.join(captureDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

      await context.close();
      logger.info(`Captured ${url}`, { folder: folderName, httpStatus: metadata.httpStatus });
      return metadata;
    } catch (err) {
      lastError = err;
      logger.warn(`Capture attempt ${attempt} failed for ${url}: ${err.message}`);
      if (context) {
        // context.close() can itself hang if the browser is wedged (e.g. after
        // a screenshot timeout); don't let it block the next attempt forever.
        await Promise.race([
          context.close().catch(() => {}),
          delay(5000),
        ]);
      }
      if (attempt <= MAX_RETRIES) {
        await delay(RETRY_DELAY_MS * attempt);
      }
    }
  }

  const metadata = {
    requestedUrl: url,
    finalUrl: null,
    title: null,
    httpStatus: null,
    capturedAt: new Date().toISOString(),
    attempts: MAX_RETRIES + 1,
    status: 'error',
    error: lastError ? lastError.message : 'unknown error',
    folder: folderName,
  };
  await fs.writeFile(path.join(captureDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');
  logger.error(`Failed to capture ${url} after ${MAX_RETRIES + 1} attempts`, { error: metadata.error });
  return metadata;
}

module.exports = { captureUrl };
