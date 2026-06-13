// Throwaway experiment: scroll 80% of viewport height each step (instead of
// 100%), capture one screenshot per step, then stitch by cropping the
// overlapping top portion off every screenshot after the first (which also
// removes the static top bar from those crops).
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
require('dotenv').config();

const { chromium } = require('playwright');
const sharp = require('sharp');

const URL = process.argv[2] || 'https://x.com/NtnYzhqy';
const STEPS = Number(process.argv[3] || 20);
const OUT = process.argv[4] || '/tmp/scroll-stitch-80.png';

const VIEWPORT_WIDTH = 1280;
const VIEWPORT_HEIGHT = 1024;
const SCROLL_STEP = Math.round(VIEWPORT_HEIGHT * 0.8); // 819
const OVERLAP = VIEWPORT_HEIGHT - SCROLL_STEP; // 205

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT } });

  const { TWITTER_AUTH_TOKEN, TWITTER_CT0 } = process.env;
  if (TWITTER_AUTH_TOKEN && TWITTER_CT0) {
    await context.addCookies([
      { name: 'auth_token', value: TWITTER_AUTH_TOKEN, domain: '.x.com', path: '/' },
      { name: 'ct0', value: TWITTER_CT0, domain: '.x.com', path: '/' },
    ]);
  }

  const page = await context.newPage();
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(2000);

  const screenshots = [await page.screenshot({ type: 'png' })];
  for (let s = 0; s < STEPS - 1; s++) {
    const beforeY = await page.evaluate(() => window.scrollY);
    await page.evaluate((h) => window.scrollBy(0, h), SCROLL_STEP);
    await page.waitForTimeout(1000);
    const afterY = await page.evaluate(() => window.scrollY);
    if (afterY <= beforeY) {
      console.log(`Reached bottom after ${s + 1} scrolls`);
      break;
    }
    screenshots.push(await page.screenshot({ type: 'png' }));
  }

  console.log(`Captured ${screenshots.length} screenshots`);

  // First screenshot full height; subsequent screenshots cropped to drop the
  // top OVERLAP px (duplicate content + static bar), keeping SCROLL_STEP px.
  const heights = screenshots.map((_, i) => (i === 0 ? VIEWPORT_HEIGHT : SCROLL_STEP));
  const totalHeight = heights.reduce((a, b) => a + b, 0);

  const composites = [];
  let top = 0;
  for (let i = 0; i < screenshots.length; i++) {
    let input = screenshots[i];
    if (i > 0) {
      input = await sharp(input).extract({ left: 0, top: OVERLAP, width: VIEWPORT_WIDTH, height: SCROLL_STEP }).toBuffer();
    }
    composites.push({ input, top, left: 0 });
    top += heights[i];
  }

  await sharp({
    create: { width: VIEWPORT_WIDTH, height: totalHeight, channels: 3, background: { r: 255, g: 255, b: 255 } },
  }).composite(composites).png().toFile(OUT);

  console.log(`Saved ${OUT} (${VIEWPORT_WIDTH}x${totalHeight})`);
  await browser.close();
})();
