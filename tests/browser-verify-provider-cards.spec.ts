// tests/browser-verify-provider-cards.spec.ts
// Browser verification: provider usage cards render correctly
// Run with: NO_AUTH=1 NO_NGROK=1 node server.js
import { test, expect } from '@playwright/test';
import path from 'path';

const SCREENSHOT_DIR = path.join(__dirname, '..', '.tmp', 'screenshots');
const DASH_URL = 'http://127.0.0.1:9595';

test.describe('Provider usage cards — browser verification', () => {
  test('cards render at top row with correct styling', async ({ page }) => {
    await page.goto(`${DASH_URL}/dash`);
    await page.waitForSelector('.provider-card', { timeout: 15000 });

    const providerGrid = page.locator('#provider-grid');
    await expect(providerGrid).toBeVisible();

    const cards = page.locator('.provider-card');
    const cardCount = await cards.count();
    console.log(`Provider cards: ${cardCount}`);
    expect(cardCount).toBeGreaterThanOrEqual(1);

    // Verify distinct blue-teal tint (not same as server cards)
    const cardBg = await cards.first().evaluate(el => getComputedStyle(el).background);
    console.log(`Card background: ${cardBg.substring(0, 80)}...`);
    expect(cardBg).toContain('240'); // blue-tinted

    // Verify limit bars rendered
    const limitBars = page.locator('.limit-bar__fill');
    const barCount = await limitBars.count();
    console.log(`Limit bars: ${barCount}`);
    expect(barCount).toBeGreaterThan(0);

    // Verify status pills
    const statusPills = page.locator('[class*="status-pill--"]');
    const pillCount = await statusPills.count();
    console.log(`Status pills: ${pillCount}`);
    expect(pillCount).toBeGreaterThanOrEqual(1);

    // Verify cards are above server list in DOM order
    const providerBox = await providerGrid.boundingBox();
    const serverList = page.locator('#server-list');
    const serverBox = await serverList.boundingBox();
    if (providerBox && serverBox) {
      console.log(`Provider Y: ${providerBox.y}, Server Y: ${serverBox.y}`);
      expect(providerBox.y).toBeLessThan(serverBox.y);
    }

    // Full page screenshot
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'dashboard-full.png'),
      fullPage: true
    });
    console.log('Saved: dashboard-full.png');

    // Provider card closeup
    if (cardCount > 0) {
      await cards.first().screenshot({
        path: path.join(SCREENSHOT_DIR, 'provider-card-closeup.png')
      });
      console.log('Saved: provider-card-closeup.png');
    }

    // No console errors
    const errors = [];
    page.on('console', msg => {
      if (msg.type() === 'error') errors.push(msg.text());
    });
    await page.reload();
    await page.waitForSelector('.provider-card', { timeout: 15000 });
    await page.waitForTimeout(500);
    const filtered = errors.filter(e =>
      !e.includes('favicon') && !e.includes('ngrok')
    );
    expect(filtered.length).toBe(0);
    console.log('No console errors ✓');
  });

  test('cards stack vertically on narrow viewport', async ({ page }) => {
    await page.goto(`${DASH_URL}/dash`);
    await page.waitForSelector('.provider-card', { timeout: 15000 });

    // Narrow enough that only 1 card fits per row (13rem ≈ 208px + gap)
    await page.setViewportSize({ width: 320, height: 900 });
    await page.waitForTimeout(500);

    const cards = page.locator('.provider-card');
    const count = await cards.count();
    if (count >= 2) {
      const box1 = await cards.nth(0).boundingBox();
      const box2 = await cards.nth(1).boundingBox();
      if (box1 && box2) {
        // At 320px, only 1 card per row — card 2 must be below card 1
        expect(box2.y).toBeGreaterThan(box1.y + box1.height - 10);
        console.log(`Stacked ✓: card1 Y=${box1.y.toFixed(0)}, card2 Y=${box2.y.toFixed(0)}`);
      }
    }

    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, 'dashboard-narrow.png'),
      fullPage: true
    });
    console.log('Saved: dashboard-narrow.png');
  });
});
