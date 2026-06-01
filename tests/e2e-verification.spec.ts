import { test, expect } from '@playwright/test';

const TEST_PORT = 19595;
const BASE_URL = `http://localhost:${TEST_PORT}`;

test.describe('E2E Verification: Socket Hang Up Fix', () => {
  test.beforeEach(async ({ page }) => {
    // Navigate to dashboard
    await page.goto(`${BASE_URL}/dash`);
    await page.waitForLoadState('networkidle');
  });

  test('Dashboard renders all servers with correct names and ports', async ({ page }) => {
    // Verify dashboard title
    await expect(page).toHaveTitle(/Tunnel Switcher/);

    // Wait for server cards to load
    const cards = page.locator('.server-card');
    await expect(cards.first()).toBeVisible({ timeout: 10000 });

    // Should have 7 servers
    const count = await cards.count();
    expect(count).toBe(7);

    // Verify Vanforms shows as port 8086
    const vanformsCard = page.locator('.server-card').filter({ hasText: 'Vanforms' });
    await expect(vanformsCard).toBeVisible();
    await expect(vanformsCard.locator('.port-badge')).toHaveText(':8086');

    // Verify Hub shows as port 8099
    const hubCard = page.locator('.server-card').filter({ hasText: 'Hub' });
    await expect(hubCard).toBeVisible();
    await expect(hubCard.locator('.port-badge')).toHaveText(':8099');

    // Screenshot: initial dashboard state
    await page.screenshot({ 
      path: 'test-screenshots/01-dashboard-initial.png',
      fullPage: true 
    });
  });

  test('Activating Vanforms (port 8086) works without socket hang up', async ({ page }) => {
    // Find Vanforms card and click Tunnel button
    const vanformsCard = page.locator('.server-card').filter({ hasText: 'Vanforms' });
    await expect(vanformsCard).toBeVisible();

    const tunnelBtn = vanformsCard.locator('button[data-action="tunnel"]');
    await expect(tunnelBtn).toBeEnabled();
    await tunnelBtn.click();

    // Wait for activation
    await page.waitForTimeout(1000);

    // Verify card shows as active
    await expect(vanformsCard).toHaveClass(/active/);
    await expect(vanformsCard.locator('.active-badge')).toBeVisible();

    // Screenshot: Vanforms activated
    await page.screenshot({ 
      path: 'test-screenshots/02-vanforms-activated.png',
      fullPage: true 
    });

    // Test proxy by fetching root path
    const proxyResponse = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url);
        const text = await resp.text();
        return { 
          status: resp.status, 
          text: text.substring(0, 500),
          hasError: text.includes('socket hang up') || text.includes('Cannot reach')
        };
      } catch (err) {
        return { error: err.message };
      }
    }, `${BASE_URL}/`);

    // Verify no socket hang up error
    expect(proxyResponse.hasError).toBe(false);
    expect(proxyResponse.status).toBe(200);
    
    // Vanforms should return HTML with "Sign in" or "vanforms"
    expect(proxyResponse.text.toLowerCase()).toMatch(/sign in|vanforms|login/);

    // Screenshot: proxy response (we can't screenshot the proxied page directly, 
    // but we verified it works)
    console.log('✓ Vanforms proxy works - no socket hang up');
  });

  test('Activating Hub (port 8099) works without socket hang up', async ({ page }) => {
    // Find Hub card and click Tunnel button
    const hubCard = page.locator('.server-card').filter({ hasText: 'Hub' });
    await expect(hubCard).toBeVisible();

    const tunnelBtn = hubCard.locator('button[data-action="tunnel"]');
    await expect(tunnelBtn).toBeEnabled();
    await tunnelBtn.click();

    // Wait for activation
    await page.waitForTimeout(1000);

    // Verify card shows as active
    await expect(hubCard).toHaveClass(/active/);
    await expect(hubCard.locator('.active-badge')).toBeVisible();

    // Screenshot: Hub activated
    await page.screenshot({ 
      path: 'test-screenshots/03-hub-activated.png',
      fullPage: true 
    });

    // Test proxy by fetching root path
    const proxyResponse = await page.evaluate(async (url) => {
      try {
        const resp = await fetch(url);
        const text = await resp.text();
        return { 
          status: resp.status, 
          text: text.substring(0, 500),
          hasError: text.includes('socket hang up') || text.includes('Cannot reach')
        };
      } catch (err) {
        return { error: err.message };
      }
    }, `${BASE_URL}/`);

    // Verify no socket hang up error
    expect(proxyResponse.hasError).toBe(false);
    expect(proxyResponse.status).toBe(200);
    
    // Hub should return HTML (large page with FinanceTracker)
    expect(proxyResponse.text.toLowerCase()).toMatch(/hub|finance|tracker/);

    console.log('✓ Hub proxy works - no socket hang up');
  });

  test('Switching between servers works correctly', async ({ page }) => {
    // Activate Vanforms first
    const vanformsCard = page.locator('.server-card').filter({ hasText: 'Vanforms' });
    await vanformsCard.locator('button[data-action="tunnel"]').click();
    await page.waitForTimeout(1000);

    // Verify Vanforms is active
    await expect(vanformsCard).toHaveClass(/active/);

    // Now activate Hub (should switch)
    const hubCard = page.locator('.server-card').filter({ hasText: 'Hub' });
    await hubCard.locator('button[data-action="tunnel"]').click();
    await page.waitForTimeout(1000);

    // Verify Hub is now active, Vanforms is not
    await expect(hubCard).toHaveClass(/active/);
    await expect(vanformsCard).not.toHaveClass(/active/);

    // Screenshot: switched to Hub
    await page.screenshot({ 
      path: 'test-screenshots/04-switched-to-hub.png',
      fullPage: true 
    });

    // Verify proxy returns Hub content
    const proxyResponse = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const text = await resp.text();
      return { 
        status: resp.status, 
        hasError: text.includes('socket hang up') || text.includes('Cannot reach'),
        isHub: text.toLowerCase().includes('hub') || text.toLowerCase().includes('finance')
      };
    }, `${BASE_URL}/`);

    expect(proxyResponse.hasError).toBe(false);
    expect(proxyResponse.status).toBe(200);
    expect(proxyResponse.isHub).toBe(true);

    console.log('✓ Server switching works correctly');
  });

  test('Deactivating server returns to dashboard', async ({ page }) => {
    // Activate a server
    const vanformsCard = page.locator('.server-card').filter({ hasText: 'Vanforms' });
    await vanformsCard.locator('button[data-action="tunnel"]').click();
    await page.waitForTimeout(1000);

    // Verify active
    await expect(vanformsCard).toHaveClass(/active/);

    // Click Stop button (same button, now shows "Stop")
    const stopBtn = vanformsCard.locator('.tunnel-btn.stop');
    await stopBtn.click();
    await page.waitForTimeout(1000);

    // Verify deactivated
    await expect(vanformsCard).not.toHaveClass(/active/);

    // Screenshot: deactivated
    await page.screenshot({ 
      path: 'test-screenshots/05-server-deactivated.png',
      fullPage: true 
    });

    // Verify / now returns dashboard (200) when no target is set
    const proxyResponse = await page.evaluate(async (url) => {
      const resp = await fetch(url);
      const text = await resp.text();
      return { 
        status: resp.status,
        isDashboard: text.includes('Tunnel Switcher') || text.includes('server-card')
      };
    }, `${BASE_URL}/`);

    expect(proxyResponse.status).toBe(200);
    expect(proxyResponse.isDashboard).toBe(true);

    console.log('✓ Server deactivation works correctly');
  });
});
