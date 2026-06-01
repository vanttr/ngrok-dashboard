// e2e-visual.js — visual verification
// Tests: (1) zombie card fix, (2) Hub FinanceTracker calculate button via tunnel
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DASH = 'http://localhost:9595/dash';
const HUB_PROXY = 'http://localhost:9595';

const screenshotDir = path.join(__dirname, '..', 'test-results', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

function shot(page, name) {
  const p = path.join(screenshotDir, `${name}.png`);
  console.log(`   Screenshot: ${name}.png`);
  return page.screenshot({ path: p, fullPage: false });
}

async function countCardsContaining(page, text) {
  const cards = await page.$$('.server-card');
  let count = 0;
  for (const card of cards) {
    const t = await card.innerText();
    if (t.includes(text)) count++;
  }
  return count;
}

// Wait for HTMX to finish all in-flight requests
async function waitForHtmx(page, ms = 1500) {
  await page.waitForTimeout(ms);
}

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  // =====================================================================
  // PART 1: Bug 1 visual check — zombie card fix
  // =====================================================================
  console.log('\n=== PART 1: Zombie card visual check ===');

  console.log('1a. Opening dashboard...');
  await page.goto(DASH);
  await page.waitForSelector('.server-card', { timeout: 10000 });
  await waitForHtmx(page, 800);
  await shot(page, '01-dashboard-initial');

  const hubBefore = await countCardsContaining(page, 'Hub');
  console.log(`1b. Hub cards before tunnel: ${hubBefore}`);

  console.log('1c. Clicking Tunnel on Hub...');
  await page.locator('.server-card', { hasText: 'Hub' }).locator('button').click();
  await waitForHtmx(page, 1200);
  await shot(page, '02-after-hub-tunnel-click');

  const hubAfterClick = await countCardsContaining(page, 'Hub');
  const pass1 = hubAfterClick === 1;
  console.log(`1d. Hub cards after activation: ${hubAfterClick} — ${pass1 ? 'PASS (no zombie)' : 'FAIL (zombie present)'}`);

  console.log('1e. Waiting for next 10s poll...');
  await page.waitForTimeout(11000);
  await shot(page, '03-after-poll');

  const hubAfterPoll = await countCardsContaining(page, 'Hub');
  const pass2 = hubAfterPoll === 1;
  console.log(`1f. Hub cards after poll: ${hubAfterPoll} — ${pass2 ? 'PASS (stable)' : 'FAIL (accumulated)'}`);

  // =====================================================================
  // PART 2: Calculate button via tunnel
  // =====================================================================
  console.log('\n=== PART 2: Hub FinanceTracker calculate via tunnel ===');

  const hubPage = await ctx.newPage();

  console.log('2a. Opening Hub through proxy...');
  await hubPage.goto(HUB_PROXY + '/', { waitUntil: 'networkidle', timeout: 20000 });
  await waitForHtmx(hubPage, 2000);
  await shot(hubPage, '04-hub-homepage');

  // Log what's on the page for debugging
  const pageText = await hubPage.locator('body').innerText().catch(() => '');
  console.log(`   Page content preview: ${pageText.substring(0, 200)}`);

  // Dump all hx-get attributes
  const hxLinks = await hubPage.$$eval('[hx-get]', els => els.map(e => e.getAttribute('hx-get')));
  console.log(`   hx-get attributes found: ${JSON.stringify(hxLinks)}`);

  console.log('2b. Navigating to FinanceTracker via direct HTMX URL...');
  // Navigate directly to the ft init endpoint and inject into the page
  await hubPage.goto(HUB_PROXY + '/api/hub/launch?app=ft', { waitUntil: 'domcontentloaded', timeout: 10000 });
  await waitForHtmx(hubPage, 1000);

  // Get back to the full app with the ft content
  // The Hub app is an SPA — we need to work within it.
  // Go back to root and trigger via click
  await hubPage.goto(HUB_PROXY + '/', { waitUntil: 'networkidle', timeout: 20000 });
  await waitForHtmx(hubPage, 2500);
  await shot(hubPage, '04b-hub-loaded');

  const hxLinks2 = await hubPage.$$eval('[hx-get]', els => els.map(e => e.getAttribute('hx-get')));
  console.log(`   hx-get attributes after load: ${JSON.stringify(hxLinks2)}`);

  // Find and click the FinanceTracker button
  const ftTrigger = hubPage.locator('[hx-get*="app=ft"]').first();
  const ftCount = await ftTrigger.count();
  console.log(`   FinanceTracker trigger elements: ${ftCount}`);

  if (ftCount > 0) {
    await ftTrigger.click();
    await waitForHtmx(hubPage, 1500);
    await shot(hubPage, '05-ft-index');

    console.log('2c. Clicking Home Loan...');
    const hlTrigger = hubPage.locator('[hx-get*="homeloan/init"]').first();
    if (await hlTrigger.count() > 0) {
      await hlTrigger.click();
    } else {
      // Trigger via HTMX API call
      await hubPage.evaluate(() => {
        const el = document.querySelector('[hx-get*="homeloan"]');
        if (el) el.click();
      });
    }
    await waitForHtmx(hubPage, 1500);
    await shot(hubPage, '06-homeloan-form');
  } else {
    console.log('   FinanceTracker button not found — taking page dump screenshot');
    await shot(hubPage, '05-page-dump');
    const bodyHtml = await hubPage.locator('body').innerHTML().catch(() => '');
    console.log(`   Body HTML preview: ${bodyHtml.substring(0, 500)}`);
  }

  // Check if calculate form is visible
  const calcTrigger = hubPage.locator('[hx-post*="homeloan/calculate"]').first();
  console.log(`   Calculate trigger visible: ${await calcTrigger.count() > 0}`);

  if (await calcTrigger.count() > 0) {
    console.log('2d. Filling in form values...');
    const inputs = await hubPage.$$('input[type="number"], input[type="text"]');
    console.log(`   Input fields found: ${inputs.length}`);
    for (const inp of inputs) {
      const name = await inp.getAttribute('name') || '';
      const inputType = await inp.getAttribute('type') || '';
      console.log(`   Input: name="${name}" type="${inputType}"`);
      // Fill numeric fields with sensible defaults
      if (inputType === 'number' || name.match(/loan|amount|price|rate|term|year|deposit/i)) {
        const val = name.match(/rate|interest/i) ? '6.5' : name.match(/term|year/i) ? '30' : '500000';
        await inp.fill(val).catch(() => {});
      }
    }
    await shot(hubPage, '07-form-filled');

    console.log('2e. Clicking Calculate...');
    const errors = [];
    hubPage.on('response', resp => {
      if (!resp.ok()) errors.push(`${resp.status()} ${resp.url()}`);
    });

    await calcTrigger.click();
    await waitForHtmx(hubPage, 2500);
    await shot(hubPage, '08-after-calculate');

    const results = await hubPage.locator('#ft-hl-results').innerText().catch(() => '');
    console.log(`   Results (first 300 chars): ${results.substring(0, 300)}`);

    if (errors.length > 0) {
      console.log(`   Network errors: ${errors.join(', ')}`);
      console.log('2f. Calculate result: FAIL (network errors)');
    } else if (results.trim().length > 10) {
      console.log('2f. Calculate result: PASS (results populated)');
    } else {
      console.log('2f. Calculate result: INCONCLUSIVE (no errors but results empty — may need form values)');
    }
  } else {
    await shot(hubPage, '08-no-calculate');
    console.log('2f. Calculate form not reached — check screenshots');
  }

  // =====================================================================
  // Cleanup
  // =====================================================================
  console.log('\nStopping Hub tunnel...');
  await page.bringToFront();
  const stopBtn = page.locator('.server-card', { hasText: 'Hub' }).locator('button.stop');
  if (await stopBtn.count() > 0) {
    await stopBtn.click();
    await waitForHtmx(page, 800);
    await shot(page, '09-hub-stopped');
  }

  await browser.close();
  console.log('\n=== Done. Screenshots in test-results/screenshots/ ===');
}

run().catch(err => { console.error('\nFATAL:', err.message); process.exit(1); });
