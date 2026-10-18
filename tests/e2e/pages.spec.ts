import { expect, test } from '@playwright/test';

test.describe('static pages & security headers', () => {
  test('home page loads without console errors and with a strict CSP', async ({ page }) => {
    const problems: string[] = [];
    page.on('console', (msg) => msg.type() === 'error' && problems.push(msg.text()));
    page.on('pageerror', (err) => problems.push(err.message));
    const response = await page.goto('/');
    expect(response?.status()).toBe(200);
    const csp = response?.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('unsafe-inline');
    expect(response?.headers()['x-content-type-options']).toBe('nosniff');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('MP4 atau MP3');
    await expect(page.locator('[data-el="record"]')).toBeDisabled();
    expect(problems).toEqual([]);
  });

  test('sandbox page is served without the app CSP but cannot be framed by other sites', async ({ request }) => {
    const response = await request.get('/sandbox.html');
    expect(response.status()).toBe(200);
    const csp = response.headers()['content-security-policy'] ?? '';
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain('script-src');
  });

  for (const path of ['/bantuan', '/privasi', '/lisensi']) {
    test(`page ${path} renders`, async ({ page }) => {
      const response = await page.goto(path);
      expect(response?.status()).toBe(200);
      await expect(page.locator('h1')).toBeVisible();
    });
  }

  test('unknown routes return the 404 page', async ({ page }) => {
    const response = await page.goto('/does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.locator('h1')).toContainText('tidak ditemukan');
  });
});
