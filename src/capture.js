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
// When a scroll makes no forward progress (e.g. X's virtualized list recycles
// DOM nodes and momentarily shrinks scrollHeight, clamping scrollY back), wait
// this long for content to settle and retry, up to MAX_SCROLL_STALLS times
// before concluding we've reached the real bottom.
const SCROLL_STALL_WAIT_MS = 2000;
const MAX_SCROLL_STALLS = 5;
// Time budget for the scroll-loading phase, scaled to the number of scrolls
// requested (a fixed cap would throttle large jobs to however many scrolls fit
// in it). Observed ~1.8s/scroll; 4s/scroll gives headroom for stall retries.
// A floor keeps small jobs from being starved.
const PER_SCROLL_BUDGET_MS = 4000;
const MIN_SCROLL_TIME_MS = 60 * 1000;
function scrollTimeBudget(scrollCount) {
  return Math.max(MIN_SCROLL_TIME_MS, scrollCount * PER_SCROLL_BUDGET_MS);
}
const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 1024;
// Browsers cap rendered image dimensions around 32767px; stay safely under that
// for each stitched image.
const MAX_STITCH_SCREENSHOTS = 28;
// X/Twitter has a static bar across the top of the viewport (~6% of the
// height). Scrolling by less than a full viewport each step leaves an
// overlap that includes this bar, which we crop off every screenshot after
// the first so it only appears once, at the top of the stitched image.
const TWITTER_SCROLL_STEP = Math.round(VIEWPORT_HEIGHT * 0.8);
const TWITTER_OVERLAP = VIEWPORT_HEIGHT - TWITTER_SCROLL_STEP;

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

// The legacy twitter.com domain now often returns a Cloudflare 520; x.com is
// the current canonical host and is reliable. Rewrite twitter.com -> x.com and
// upgrade http -> https so old-style links capture correctly.
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)twitter\.com$/i.test(u.hostname)) {
      u.hostname = u.hostname.replace(/twitter\.com$/i, 'x.com');
    }
    if (u.protocol === 'http:') u.protocol = 'https:';
    return u.toString();
  } catch {
    return url;
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// A blank/solid-color screenshot (e.g. a page that failed to render) has
// near-zero variance across every channel. Used to trigger a retry instead of
// saving an unusable capture.
const BLANK_STDEV_THRESHOLD = 1;

async function isBlankScreenshot(buf) {
  const stats = await sharp(buf).stats();
  return stats.channels.every((c) => c.stdev < BLANK_STDEV_THRESHOLD);
}

// Poll until the page becomes scrollable or timeoutMs elapses. Used for
// X/Twitter SPA tabs (e.g. "with_replies"), which can take longer than the
// initial settle wait to fetch and render their content.
async function waitForScrollable(page, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scrollable = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight + 10);
    if (scrollable) return;
    await page.waitForTimeout(300);
  }
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

async function captureUrl(browser, url, outputDir, index, { isCancelled, scrollCount = 0, onStitch } = {}) {
  url = normalizeUrl(url);
  const folderName = `${String(index + 1).padStart(3, '0')}-${sanitizeForPath(safeHostname(url))}`;
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

        // X/Twitter pages are always scrollable, but right after load
        // scrollHeight may not yet reflect that (tweets are still being
        // fetched), so don't rely on the scrollHeight check for them.
        const isTwitter = TWITTER_HOSTS.has(safeHostname(url));

        // Give dynamic / lazy-loaded content a moment to settle before
        // capturing. X is a client-rendered SPA that can take much longer
        // than that to paint (especially logged-in on a slow host), so for it
        // wait until tweet articles actually appear in the DOM.
        await page.waitForTimeout(2000);
        if (isTwitter) {
          await page.waitForSelector('article', { timeout: 15000 }).catch(() => {});
          await page.waitForTimeout(1000);
        }
        // X/Twitter pages always go through the per-viewport capture path
        // below (even with scrollCount=0, producing a single screenshot):
        // `fullPage: true` resizes the page to its full scrollHeight, which
        // breaks X's viewport-sized layout and renders blank.
        const isScrollable = isTwitter || (scrollCount > 0 && await page.evaluate(
          () => document.documentElement.scrollHeight > window.innerHeight + 10
        ));

        if (isScrollable) {
          // Infinite-scroll / virtualized pages only render content near the
          // current scroll position, so we capture one viewport screenshot per
          // scroll step and stitch them together rather than relying on a
          // full-page screenshot (which would mostly show blank placeholders).
          const scrollStep = isTwitter ? TWITTER_SCROLL_STEP : VIEWPORT_HEIGHT;

          // X/Twitter SPA tabs (e.g. "with_replies") may still be fetching
          // content at this point; give them extra time to become scrollable.
          if (isTwitter) {
            await waitForScrollable(page, 8000);
          }

          // Crop a raw viewport buffer into a frame {buf, height}.
          // For Twitter, every frame after the first overlaps the previous one
          // by TWITTER_OVERLAP px (the static top bar), so we crop it off.
          const toFrame = async (buf, isFirst) => {
            if (!isTwitter || isFirst) return { buf, height: VIEWPORT_HEIGHT };
            const cropped = await sharp(buf)
              .extract({ left: 0, top: TWITTER_OVERLAP, width: VIEWPORT_WIDTH, height: TWITTER_SCROLL_STEP })
              .toBuffer();
            return { buf: cropped, height: TWITTER_SCROLL_STEP };
          };

          // Stitch a chunk of frames into a single PNG and save it.
          const flushChunk = async (chunk, stitchIndex) => {
            const fileName = stitchIndex === 0 ? 'screenshot.png' : `screenshot-${stitchIndex + 1}.png`;
            const chunkHeight = chunk.reduce((sum, f) => sum + f.height, 0);
            const composites = [];
            let top = 0;
            for (const frame of chunk) {
              composites.push({ input: frame.buf, top, left: 0 });
              top += frame.height;
            }
            await sharp({
              create: { width: VIEWPORT_WIDTH, height: chunkHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
            }).composite(composites).png().toFile(path.join(captureDir, fileName));
            return fileName;
          };

          const firstBuf = await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS });
          if (await isBlankScreenshot(firstBuf)) {
            throw new Error('Screenshot appears blank');
          }

          const screenshotFiles = [];
          let chunk = [await toFrame(firstBuf, true)];
          let totalScrolls = 0;
          let stalls = 0;
          const scrollDeadline = Date.now() + scrollTimeBudget(scrollCount);

          for (let s = 0; s < scrollCount; s++) {
            if (Date.now() > scrollDeadline) {
              logger.warn(`Scroll stopped: deadline exceeded after ${totalScrolls} scrolls`, { url });
              break;
            }
            if (isCancelled && isCancelled()) return null;
            const beforeY = await page.evaluate(() => window.scrollY);
            await page.evaluate((h) => window.scrollBy(0, h), scrollStep);
            await page.waitForTimeout(SCROLL_WAIT_MS);
            const afterY = await page.evaluate(() => window.scrollY);

            // No forward progress can mean the real bottom, OR (on X's
            // virtualized timeline) a transient scrollHeight shrink during DOM
            // recycling that clamps scrollY backwards. Distinguish the two by
            // waiting for more content to load and retrying; only give up after
            // several consecutive stalls.
            if (afterY <= beforeY) {
              stalls++;
              if (stalls >= MAX_SCROLL_STALLS) {
                logger.warn(`Scroll stopped: ${stalls} consecutive stalls at scrollY=${afterY} after ${totalScrolls} scrolls`, { url });
                break;
              }
              await page.waitForTimeout(SCROLL_STALL_WAIT_MS);
              s--; // don't consume a scroll step on a stall retry
              continue;
            }
            stalls = 0;
            totalScrolls++;
            chunk.push(await toFrame(await page.screenshot({ type: 'png', timeout: SCREENSHOT_TIMEOUT_MS }), false));

            // Flush completed chunk immediately so the caller can report progress.
            if (chunk.length === MAX_STITCH_SCREENSHOTS) {
              const fileName = await flushChunk(chunk, screenshotFiles.length);
              screenshotFiles.push(fileName);
              if (onStitch) onStitch(fileName, [...screenshotFiles], folderName);
              chunk = [];
            }
          }

          // Flush any remaining frames.
          if (chunk.length > 0) {
            const fileName = await flushChunk(chunk, screenshotFiles.length);
            screenshotFiles.push(fileName);
            if (onStitch) onStitch(fileName, [...screenshotFiles], folderName);
          }

          await page.evaluate(() => window.scrollTo(0, 0));

          const finalUrl = page.url();
          const title = await page.title();
          const html = await page.content();
          const capturedAt = new Date().toISOString();

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
            scrolls: totalScrolls,
            screenshots: screenshotFiles,
          };
        }

        const finalUrl = page.url();
        const title = await page.title();
        const html = await page.content();
        const capturedAt = new Date().toISOString();

        const screenshotBuf = await page.screenshot({
          type: 'png',
          fullPage: true,
          timeout: SCREENSHOT_TIMEOUT_MS,
        });
        if (await isBlankScreenshot(screenshotBuf)) {
          throw new Error('Screenshot appears blank');
        }
        await fs.writeFile(path.join(captureDir, 'screenshot.png'), screenshotBuf);
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

      const attemptTimeoutMs = ATTEMPT_TIMEOUT_MS + (scrollCount > 0 ? scrollTimeBudget(scrollCount) : 0);
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
