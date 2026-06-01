// e2e-calculate.js — targeted calculate button test using a saved scenario
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const HUB_PROXY = 'http://localhost:9595';
const screenshotDir = path.join(__dirname, '..', 'test-results', 'screenshots');
fs.mkdirSync(screenshotDir, { recursive: true });

function shot(page, name) {
  const p = path.join(screenshotDir, `calc-${name}.png`);
  console.log(`   Screenshot: calc-${name}.png`);
  return page.screenshot({ path: p, fullPage: false });
}

async function run() {
  await fetch('http://localhost:9595/api/target', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: 8099 })
  });
  console.log('Hub set as target.');

  const browser = await chromium.launch({ headless: false, slowMo: 350 });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();

  const consoleErrors = [];
  page.on('console', msg => { if (msg.type() === 'error') consoleErrors.push(msg.text()); });
  page.on('pageerror', err => consoleErrors.push(`pageerror: ${err.message}`));

  const calcRequests = [];
  const calcResponses = [];
  page.on('request', req => {
    if (req.url().includes('homeloan/calculate')) {
      calcRequests.push(`${req.method()} ${req.url()}`);
      console.log(`   --> POST ${req.url()}`);
    }
  });
  page.on('response', async resp => {
    if (resp.url().includes('homeloan/calculate')) {
      const body = await resp.text().catch(() => '');
      calcResponses.push({ status: resp.status(), body: body.substring(0, 400) });
      console.log(`   <-- ${resp.status()} (${body.length} bytes)`);
    }
  });

  // ---- Navigate to Hub ----
  console.log('\n1. Opening Hub through proxy...');
  await page.goto(HUB_PROXY + '/', { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);

  // ---- Navigate to FinanceTracker -> Property Loan ----
  console.log('2. Opening FinanceTracker...');
  await page.locator('[hx-get*="app=ft"]').first().click();
  await page.waitForTimeout(1500);

  console.log('3. Opening Property Loan...');
  await page.locator('[hx-get*="homeloan/init"]').first().click();
  await page.waitForTimeout(1500);
  await shot(page, '01-form-initial');

  // ---- Load saved scenario ----
  console.log('4. Loading saved scenario...');
  const scenarioSelect = page.locator('select').first();
  const options = await scenarioSelect.locator('option').allTextContents();
  const realOptions = options.filter(o => !o.includes('Load saved'));
  console.log(`   Scenarios available: ${JSON.stringify(realOptions)}`);

  if (realOptions.length > 0) {
    await scenarioSelect.selectOption({ label: realOptions[0] });
    await page.waitForTimeout(2000);
    await shot(page, '02-scenario-loaded');
    const price = await page.locator('input[name="property_price"]').inputValue().catch(() => '?');
    const deposit = await page.locator('input[name="deposit_pct"]').inputValue().catch(() => '?');
    console.log(`   Loaded: price=${price}, deposit_pct=${deposit}`);
  } else {
    await page.locator('input[name="property_price"]').fill('750000');
    await page.waitForTimeout(300);
  }

  await shot(page, '03-before-calculate');

  // ---- Click the submit button INSIDE the form (not the form itself) ----
  // hx-post is on the <form id="ft-hl-form">, submit button is inside it
  console.log('\n5. Clicking the submit button inside #ft-hl-form...');
  const submitBtn = page.locator('#ft-hl-form button[type="submit"]').first();
  const submitCount = await submitBtn.count();
  console.log(`   Submit button found: ${submitCount}`);

  if (submitCount > 0) {
    const btnText = await submitBtn.innerText();
    console.log(`   Button text: "${btnText}"`);
    await submitBtn.scrollIntoViewIfNeeded();
    await page.waitForTimeout(300);
    await submitBtn.click();
    await page.waitForTimeout(3500);
  } else {
    // Fallback: trigger form submit via keyboard Enter on a focused input
    console.log('   Submit button not found — trying Enter key on form');
    await page.locator('#ft-hl-form input').first().press('Enter');
    await page.waitForTimeout(3500);
  }

  await shot(page, '04-after-calculate');

  // ---- Results ----
  const results = await page.locator('#ft-hl-results').innerText().catch(() => '(not found)');
  const isPlaceholder = results.trim() === 'Fill in the form and click Calculate to see results.';

  console.log(`\nResults (first 400 chars):\n${results.substring(0, 400)}`);
  console.log(`\n=== SUMMARY ===`);
  console.log(`Console errors: ${consoleErrors.length > 0 ? consoleErrors.join('; ') : 'none'}`);
  console.log(`POST requests sent: ${calcRequests.length}`);
  console.log(`Responses received: ${calcResponses.length}`);

  if (calcRequests.length === 0) {
    console.log('RESULT: FAIL — no POST sent');
  } else if (isPlaceholder) {
    console.log('RESULT: POST sent but results not populated');
    if (calcResponses.length > 0) {
      console.log(`Backend response preview: ${calcResponses[0].body.substring(0, 200)}`);
    }
  } else {
    console.log('RESULT: PASS — Calculate returned results');
  }

  await fetch('http://localhost:9595/api/target', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ port: null })
  });
  await browser.close();
}

run().catch(err => { console.error('FATAL:', err.message); process.exit(1); });
