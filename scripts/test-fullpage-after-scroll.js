// Throwaway test: scroll N times, wait, then take a fullPage screenshot
// without scrolling back to top, to see whether the virtualized timeline
// keeps enough rendered DOM for fullPage to capture it all.
delete process.env.DISPLAY;
delete process.env.WAYLAND_DISPLAY;
require('dotenv').config();

const { chromium } = require('playwright');

const URL = process.argv[2] || 'https://x.com/NtnYzhqy';
const SCROLLS = Number(process.argv[3] || 20);
const OUT = process.argv[4] || '/tmp/fullpage-after-scroll.png';

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 1024 } });

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

  for (let i = 0; i < SCROLLS; i++) {
    await page.evaluate((h) => window.scrollBy(0, h), 1024);
    await page.waitForTimeout(1000);
  }

  console.log('Waiting a few seconds for content to settle...');
  await page.waitForTimeout(3000);

  const scrollY = await page.evaluate(() => window.scrollY);
  const scrollHeight = await page.evaluate(() => document.documentElement.scrollHeight);
  console.log(`scrollY=${scrollY} scrollHeight=${scrollHeight}`);

  await page.screenshot({ path: OUT, fullPage: true, timeout: 60000 });
  console.log(`Saved ${OUT}`);

  await browser.close();
})();
