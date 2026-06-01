import { test, expect } from '@playwright/test';

const BASE_URL = 'http://localhost:9595';
const SCREENSHOT_DIR = 'test-screenshots';

test.describe('Start Server Feature - Visual Verification', () => {

  test('01 - Dashboard shows Start button for down server', async ({ page }) => {
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');

    // Wait for server cards to render
    const cards = page.locator('.server-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Find the Openchamber card (should be down since no server on 57123)
    const ocCard = page.locator('.server-card').filter({ hasText: 'Openchamber' });
    await expect(ocCard).toBeVisible();

    // Verify it has a Start Server button (not disabled Tunnel)
    const startBtn = ocCard.locator('.tunnel-btn.start');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveText('Start Server');
    await expect(startBtn).toBeEnabled();

    // Screenshot: down server with Start button
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/01-down-server-start-button.png`,
      fullPage: true
    });
  });

  test('02 - Click Start enters Starting state', async ({ page }) => {
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');

    const ocCard = page.locator('.server-card').filter({ hasText: 'Openchamber' });
    await expect(ocCard).toBeVisible();

    const startBtn = ocCard.locator('.tunnel-btn.start');
    await expect(startBtn).toBeVisible();
    await startBtn.click();

    // Wait for the "Starting..." button to appear (the card gets rebuilt by fetchState)
    const startingBtn = page.locator('.server-card').filter({ hasText: 'Openchamber' }).locator('.tunnel-btn.starting');
    await expect(startingBtn).toBeVisible({ timeout: 3000 });
    await expect(startingBtn).toHaveText('Starting...');
    await expect(startingBtn).toBeDisabled();

    // Small wait for DOM to settle after re-render
    await page.waitForTimeout(500);

    // Verify the Openchamber card is still present before screenshot
    await expect(page.locator('.server-card').filter({ hasText: 'Openchamber' })).toBeVisible();

    // Screenshot: Starting... state
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/02-starting-state.png`,
      fullPage: true
    });
  });

  test('03 - Server comes online after Start', async ({ page }) => {
    // First start the server via API
    const apiResp = await page.request.post(`${BASE_URL}/api/servers/57123/start`);
    const apiData = await apiResp.json();
    expect(apiData.ok).toBe(true);

    // Wait for the server to come online (up to 15s)
    await page.waitForTimeout(12000);

    // Now load the dashboard
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');

    const ocCard = page.locator('.server-card').filter({ hasText: 'Openchamber' });
    await expect(ocCard).toBeVisible();

    // The health dot should be green (ok)
    const healthDot = ocCard.locator('.health-dot.ok');
    await expect(healthDot).toBeVisible({ timeout: 10000 });

    // The Start Server button should still be present, and a Start Tunnel button should also appear
    const startBtn = ocCard.locator('.tunnel-btn.start');
    await expect(startBtn).toBeVisible();
    await expect(startBtn).toHaveText('Start Server');

    const tunnelBtn = ocCard.locator('button[data-action="tunnel"]');
    await expect(tunnelBtn).toBeVisible();
    await expect(tunnelBtn).toHaveText('Start Tunnel');

    // Screenshot: server online with Start Server + Start Tunnel buttons
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/03-server-online-tunnel-button.png`,
      fullPage: true
    });
  });

  test('04 - Full dashboard with mixed states', async ({ page }) => {
    // Server should be up from previous test
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');

    const cards = page.locator('.server-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Screenshot: full dashboard overview
    await page.screenshot({
      path: `${SCREENSHOT_DIR}/04-full-dashboard-overview.png`,
      fullPage: true
    });
  });
});
