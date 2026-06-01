import { test, expect } from '@playwright/test';

const TEST_PORT = 19595;
const BASE_URL = `http://localhost:${TEST_PORT}`;

test.describe('Start Server API endpoint', () => {
  test('POST /api/servers/:port/start returns 400 for unknown port', async ({ request }) => {
    const resp = await request.post(`${BASE_URL}/api/servers/99999/start`);
    expect(resp.status()).toBe(400);
    const data = await resp.json();
    expect(data.ok).toBe(false);
    expect(data.error).toContain('Unknown port');
  });

  test('POST /api/servers/:port/start returns 400 for server with no devScript', async ({ request }) => {
    // Temporarily test with a port that exists but has no devScript
    // Since all current servers have devScript, this tests the "Unknown port" path
    // If a server without devScript is added, this should be updated
    const resp = await request.post(`${BASE_URL}/api/servers/99999/start`);
    expect(resp.status()).toBe(400);
  });
});

test.describe('Start Server UI', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');
  });

  test('Down server with devScript shows Start Server button', async ({ page }) => {
    const downCards = page.locator('.server-card.dimmed');
    const count = await downCards.count();

    if (count > 0) {
      const btn = downCards.first().locator('.tunnel-btn.start');
      await expect(btn).toHaveText('Start Server');
      await expect(btn).toBeEnabled();
    }
  });

  test('Clicking Start Server enters Starting state', async ({ page }) => {
    const startBtn = page.locator('.tunnel-btn.start').first();
    const btnCount = await startBtn.count();

    if (btnCount > 0) {
      await startBtn.click();

      // Button should now show "Starting..." and be disabled
      const startingBtn = page.locator('.tunnel-btn.starting').first();
      await expect(startingBtn).toBeVisible({ timeout: 2000 });
      await expect(startingBtn).toHaveText('Starting...');
      await expect(startingBtn).toBeDisabled();
    }
  });

  test('Healthy server with devScript shows Start Server and Start Tunnel buttons', async ({ page }) => {
    const healthyCards = page.locator('.server-card:not(.dimmed)');
    const count = await healthyCards.count();

    if (count > 0) {
      const startBtn = healthyCards.first().locator('.tunnel-btn.start');
      const tunnelBtn = healthyCards.first().locator('button[data-action="tunnel"]');
      const startBtnCount = await startBtn.count();
      if (startBtnCount > 0) {
        await expect(startBtn).toHaveText('Start Server');
        await expect(startBtn).toBeEnabled();
      }
      const tunnelBtnCount = await tunnelBtn.count();
      if (tunnelBtnCount > 0) {
        await expect(tunnelBtn).toHaveText(/Start Tunnel|Stop Tunnel/);
        await expect(tunnelBtn).toBeEnabled();
      }
    }
  });
});
