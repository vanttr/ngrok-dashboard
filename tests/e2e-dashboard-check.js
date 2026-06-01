// e2e-dashboard-check.js — visual check for duplicate cards and flicker
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const screenshotDir = path.join(__dirname, '..', 'test-results', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

function shot(page, name) {
  const p = path.join(screenshotDir, `dash-${name}.png`);
  console.log(`   Screenshot: dash-${name}.png`);
  return page.screenshot({ path: p, fullPage: false });
}

async function getCards(page) {
  return page.locator('.server-card').evaluateAll(els => els.map(e => e.innerText.substring(0, 50)));
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 200 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  await page.goto('http://localhost:9595/dash', { waitUntil: 'networkidle' });
  await page.waitForSelector('.server-card', { timeout: 10000 });
  await page.waitForTimeout(1000);

  const cardsBefore = await getCards(page);
  console.log(`Cards on initial load (${cardsBefore.length}):`, JSON.stringify(cardsBefore, null, 2));
  await shot(page, '01-initial');

  console.log('\nWaiting 11s for poll cycle 1...');
  await page.waitForTimeout(11000);
  const cardsAfter1 = await getCards(page);
  console.log(`Cards after poll 1 (${cardsAfter1.length}):`, JSON.stringify(cardsAfter1, null, 2));
  await shot(page, '02-after-poll1');

  console.log('\nWaiting 11s for poll cycle 2...');
  await page.waitForTimeout(11000);
  const cardsAfter2 = await getCards(page);
  console.log(`Cards after poll 2 (${cardsAfter2.length}):`, JSON.stringify(cardsAfter2, null, 2));
  await shot(page, '03-after-poll2');

  console.log('\n=== SUMMARY ===');
  const stable = cardsBefore.length === cardsAfter1.length && cardsAfter1.length === cardsAfter2.length;
  console.log(`Card count: ${cardsBefore.length} → ${cardsAfter1.length} → ${cardsAfter2.length}`);
  console.log(`No accumulation: ${stable ? 'PASS' : 'FAIL (counts changed)'}`);

  await browser.close();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
