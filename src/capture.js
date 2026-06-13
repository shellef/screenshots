const fs = require('fs/promises');
const path = require('path');
const sharp = require('sharp');
const logger = require('./logger');

const MAX_RETRIES = 2;
const RETRY_DELAY_MS = 2000;
const NAV_TIMEOUT_MS = 30000;
const SCREENSHOT_TIMEOUT_MS = 30000;
// Hard ceiling on a single capture attempt (nav + settle + screenshot + html).
// Without this, a page that hangs on screenshot (huge/infinite-scroll pages,
// stuck media, etc.) can block the whole job indefinitely.
const ATTEMPT_TIMEOUT_MS = 90000;
const SCROLL_WAIT_MS = 1500;
// Extra time allowed for the scroll-loading phase on infinite-scroll pages.
const MAX_SCROLL_TIME_MS = 10 * 60 * 1000;
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 1024;
// Browsers cap rendered image dimensions around 32767px; stay safely under that
// for each stitched image.
const MAX_STITCH_SCREENSHOTS = 28;

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

const TWITTER_HOSTS = new Set(['x.com', 'www.x.com', 'twitter.com', 'www.twitter.com']);

// Logged-out X/Twitter pages often render a non-scrollable "teaser" with only
// a handful of tweets. Injecting auth cookies lets us capture as a logged-in
// user, which gives the full scrollable timeline.
async function addTwitterAuthCookies(context, url) {
  const { TWITTER_AUTH_TOKEN, TWITTER_CT0 } = process.env;
  if (!TWITTER_AUTH_TOKEN || !TWITTER_CT0) return;
  if (!TWITTER_HOSTS.has(safeHostname(url))) return;

  await context.addCookies([
    { name: 'auth_token', value: TWITTER_AUTH_TOKEN, domain: '.x.com', path: '/' },
    { name: 'ct0', value: TWITTER_CT0, domain: '.x.com', path: '/' },
    { name: 'auth_token', value: TWITTER_AUTH_TOKEN, domain: '.twitter.com', path: '/' },
    { name: 'ct0', value: TWITTER_CT0, domain: '.twitter.com', path: '/' },
  ]);
}

async function captureUrl(browser, url, outputDir, index, { isCancelled, scrollCount = 0 } = {}) {
  const folderName = `${String(index).padStart(3, '0')}-${sanitizeForPath(safeHostname(url))}`;
  const captureDir = path.join(outputDir, folderName);
  await fs.mkdir(captureDir, { recursive: true });

  let lastError;
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt++) {
    if (isCancelled && isCancelled()) {
      return null;
    }
    let context;
    try {
      context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });
      await addTwitterAuthCookies(context, url);
      const page = await context.newPage();
      page.setDefaultTimeout(NAV_TIMEOUT_MS);

      const attemptPromise = (async () => {
        const response = await page.goto(url, { waitUntil: 'load', timeout: NAV_TIMEOUT_MS });

        // Give dynamic / lazy-loaded content a moment to settle before capturing.
        await page.waitForTimeout(2000);

        const isScrollable = scrollCount > 0 && await page.evaluate(
          () => document.documentElement.scrollHeight > window.innerHeight + 10
        );

        if (isScrollable) {
          // Infinite-scroll / virtualized pages only render content near the
          // current scroll position, so we capture one viewport screenshot per
          // scroll step and stitch them together rather than relying on a
          // full-page screenshot (which would mostly show blank placeholders).
          const screenshots = [await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS })];
          const scrollDeadline = Date.now() + MAX_SCROLL_TIME_MS;
          for (let s = 0; s < scrollCount; s++) {
            if (Date.now() > scrollDeadline) break;
            if (isCancelled && isCancelled()) return null;
            const beforeY = await page.evaluate(() => window.scrollY);
            await page.evaluate((h) => window.scrollBy(0, h), VIEWPORT_HEIGHT);
            await page.waitForTimeout(SCROLL_WAIT_MS);
            const afterY = await page.evaluate(() => window.scrollY);
            if (afterY <= beforeY) break; // reached the bottom, no further movement
            screenshots.push(await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS }));
          }
          await page.evaluate(() => window.scrollTo(0, 0));

          const finalUrl = page.url();
          const title = await page.title();
          const html = await page.content();
          const capturedAt = new Date().toISOString();

          // Split into multiple stitched images if there are too many
          // screenshots for a single image to stay within renderable limits.
          const screenshotFiles = [];
          for (let chunkStart = 0; chunkStart < screenshots.length; chunkStart += MAX_STITCH_SCREENSHOTS) {
            const chunk = screenshots.slice(chunkStart, chunkStart + MAX_STITCH_SCREENSHOTS);
            const fileName = chunkStart === 0 ? 'screenshot.png' : `screenshot-${chunkStart / MAX_STITCH_SCREENSHOTS + 1}.png`;
            const stitched = sharp({
              create: {
                width: VIEWPORT_WIDTH,
                height: VIEWPORT_HEIGHT * chunk.length,
                channels: 3,
                background: { r: 255, g: 255, b: 255 },
              },
            }).composite(chunk.map((buf, i) => ({ input: buf, top: i * VIEWPORT_HEIGHT, left: 0 })));
            await stitched.png().toFile(path.join(captureDir, fileName));
            screenshotFiles.push(fileName);
          }
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
            scrolls: screenshots.length - 1,
            screenshots: screenshotFiles,
          };
        }

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
          screenshots: ['screenshot.png'],
        };
      })();

      const attemptTimeoutMs = ATTEMPT_TIMEOUT_MS + (scrollCount > 0 ? MAX_SCROLL_TIME_MS : 0);
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error(`Capture attempt timed out after ${attemptTimeoutMs}ms`)), attemptTimeoutMs);
      });

      const metadata = await Promise.race([attemptPromise, timeoutPromise]);
      await fs.writeFile(path.join(captureDir, 'metadata.json'), JSON.stringify(metadata, null, 2), 'utf-8');

      await context.close();
      logger.info(`Captured ${url}`, { folder: folderName, httpStatus: metadata.httpStatus });
      return metadata;
    } catch (err) {
      lastError = err;
      if (context) {
        // context.close() can itself hang if the browser is wedged (e.g. after
        // a screenshot timeout); don't let it block the next attempt forever.
        await Promise.race([
          context.close().catch(() => {}),
          delay(5000),
        ]);
      }
      if (isCancelled && isCancelled()) {
        return null;
      }
      logger.warn(`Capture attempt ${attempt} failed for ${url}: ${err.message}`);
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
